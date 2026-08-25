/**
 * Static data-flow analysis for Fabric code-mode programs.
 *
 * The important question is not whether a program contains a function call;
 * it is whether data originating at a tool can still reach the final return
 * without a context-reducing operation.  This module intentionally uses an
 * abstract interpreter rather than a global "some call happened" flag.
 */

import ts from "typescript";
import { contextEffectFor, isContextHelperName, isFoveaName } from "./context-effects.js";

export type TaintKind =
  | "clean"
  | "raw"
  | "encoded"
  | "unknown"
  | "projected"
  | "selected"
  | "aggregated"
  | "compressed"
  | "offloaded";

export interface AnalysisResult {
  ok: boolean;
  /** True when a source value reaches return without a provable context bound. */
  hardBlock: boolean;
  reasons: string[];
  metrics: ProgramMetrics;
}

export interface ProgramMetrics {
  /** Data-producing calls, retained as `toolCalls` for compatibility. */
  toolCalls: number;
  sourceCalls: number;
  returnIsRawToolResult: boolean;
  /** True only when returned source data has a meaningful reduction path. */
  hasProcessingBetweenToolAndReturn: boolean;
  hasLoopOrConditional: boolean;
  hasVariableAssignment: boolean;
  estimatedReturnTokens: number | null;
  declaredVariables: number;
  returnTaint: TaintKind;
  returnOperation: string;
  /** Legacy-compatible count of source-bearing transformations observed. */
  meaningfulTransformations: number;
  /** Whether the final source-bearing flow used a reducing operation. */
  returnIsReduced: boolean;
  /** Whether the final source-bearing flow has an explicit static bound. */
  provablyBounded: boolean;
  /** Alias for the transformation count with less ambiguous naming. */
  transformationCount: number;
  boundedSelectionCalls: number;
  /** Static estimate; null when source size is only known at runtime. */
  estimatedSourceTokens: number | null;
  /** 0..1 estimate of source payload retained by the final value. */
  estimatedRetentionRatio: number | null;
  /** 0..1 estimate of source payload removed before return. */
  estimatedReductionRatio: number | null;
}

export interface AnalyzerOptions {
  /** Legacy compatibility knob; cost/reduction is now the primary policy. */
  maxUnprocessedToolCalls?: number;
  /** Maximum estimated tokens for a literal/bounded return. */
  maxReturnTokens?: number;
}

interface Flow {
  kind: TaintKind;
  hasSource: boolean;
  /** True only when the output has an explicit static context-size bound. */
  bounded: boolean;
  /** True when an operation reduced/projected the source, even if unbounded. */
  meaningful: boolean;
  /** Upper bound on source retention; unbounded flows are always 1. */
  retention: number;
  operation: string;
  /** Statically known numeric constants survive aliases and helper arguments. */
  constantNumber?: number;
}

interface FunctionLike {
  node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
}

interface EvalState {
  functions: Map<string, FunctionLike>;
  activeFunctions: Set<FunctionLike>;
  boundedSelectionCalls: number;
  meaningfulTransformations: number;
}

const UNSAFE_KINDS = new Set<TaintKind>(["raw", "encoded", "unknown"]);
const REDUCING_KINDS = new Set<TaintKind>(["projected", "selected", "aggregated", "compressed", "offloaded"]);

function cleanFlow(operation = "constant", constantNumber?: number): Flow {
  return { kind: "clean", hasSource: false, bounded: true, meaningful: false, retention: 0, operation, constantNumber };
}

function sourceFlow(kind: TaintKind = "raw", operation = "tool result", retention = 1): Flow {
  return { kind, hasSource: true, bounded: false, meaningful: false, retention: Math.max(0, Math.min(1, retention)), operation };
}

function reducedFlow(kind: TaintKind, operation: string, retention: number, bounded = false): Flow {
  return {
    kind,
    hasSource: true,
    bounded,
    meaningful: true,
    // If the operation is dynamically sized, it may retain the entire source.
    retention: bounded ? Math.max(0, Math.min(1, retention)) : 1,
    operation,
  };
}

function boundedFlow(kind: TaintKind, operation: string, retention: number): Flow {
  return reducedFlow(kind, operation, retention, true);
}

function getCalleeText(expr: ts.Expression, sf: ts.SourceFile): string {
  return expr.getText(sf).replace(/\s+/g, "");
}

function isContextHelperText(text: string): boolean {
  return isContextHelperName(text);
}

function isFoveaText(text: string): boolean {
  return isFoveaName(text);
}

function isDataToolText(text: string): boolean {
  const effect = contextEffectFor(text);
  return effect.kind === "source" || isFoveaText(text);
}

function isDataToolCall(node: ts.CallExpression, sf: ts.SourceFile): boolean {
  return isDataToolText(getCalleeText(node.expression, sf));
}

function isFoveaCall(node: ts.CallExpression, sf: ts.SourceFile): boolean {
  return isFoveaText(getCalleeText(node.expression, sf));
}

function isFunctionLikeNode(node: ts.Node): node is FunctionLike["node"] {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function combine(flows: Flow[], operation: string): Flow {
  const sourced = flows.filter((flow) => flow.hasSource);
  if (sourced.length === 0) return cleanFlow(operation);

  const firstUnsafe = sourced.find((flow) => flow.kind === "raw");
  if (firstUnsafe) return { ...firstUnsafe, operation };
  const encoded = sourced.find((flow) => flow.kind === "encoded");
  if (encoded) return { ...encoded, operation };
  const unknown = sourced.find((flow) => flow.kind === "unknown");
  if (unknown) return { ...unknown, operation };

  const kind = sourced.some((flow) => flow.kind === "offloaded")
    ? "offloaded"
    : sourced.some((flow) => flow.kind === "compressed")
      ? "compressed"
      : sourced.some((flow) => flow.kind === "aggregated")
        ? "aggregated"
        : sourced.some((flow) => flow.kind === "selected")
          ? "selected"
          : "projected";
  return {
    kind,
    hasSource: true,
    bounded: sourced.every((flow) => flow.bounded),
    meaningful: sourced.some((flow) => flow.meaningful),
    retention: Math.max(...sourced.map((flow) => flow.retention)),
    operation,
  };
}

const SCALAR_RESULT_PROPERTIES = new Set([
  "length", "size", "count", "lineCount", "byteLength", "bytes", "bytesRead", "totalBytes", "offset", "nextOffset",
  "tokens", "totalTokens", "originalTokens", "estimatedTokens", "resultTokens", "summaryTokens",
  "exitCode", "statusCode", "ok", "success", "failed", "blocked", "isError", "truncated", "cancelled",
]);

function propertyFlow(receiver: Flow, property: string): Flow {
  if (!receiver.hasSource) return cleanFlow(`property ${property}`);
  if (SCALAR_RESULT_PROPERTIES.has(property)) {
    return boundedFlow("projected", `scalar property ${property}`, 0.01);
  }
  if (["content", "data", "result", "stdout", "stderr", "text", "body", "value"].includes(property)) {
    return { ...receiver, operation: `raw property ${property}` };
  }
  // A property projection is structurally smaller but the property itself can
  // still contain the whole source. It is therefore not a proof of a bound.
  return reducedFlow("projected", `project property ${property}`, Math.min(receiver.retention, 0.5));
}

function elementFlow(receiver: Flow, index?: string): Flow {
  if (!receiver.hasSource) return cleanFlow("array element");
  if (index === "length" || index === "size") return boundedFlow("projected", "scalar element", 0.01);
  // Selecting one container element does not bound the size of that element;
  // `[raw][0]`, `Promise.all([raw])[0]`, and computed properties can still be
  // the complete source payload.
  if (UNSAFE_KINDS.has(receiver.kind)) return { ...receiver, operation: "select source element" };
  return boundedFlow("selected", "select element", Math.min(receiver.retention, 0.25));
}

function literalNumber(
  expr: ts.Expression | undefined,
  sf: ts.SourceFile,
  env?: Map<string, Flow>,
): number | undefined {
  if (!expr) return undefined;
  const value = unwrap(expr);
  if (ts.isNumericLiteral(value)) {
    const number = Number(value.text);
    return Number.isFinite(number) ? number : undefined;
  }
  if (ts.isPrefixUnaryExpression(value) && ts.isNumericLiteral(value.operand)) {
    const number = Number(value.operand.text);
    if (!Number.isFinite(number)) return undefined;
    if (value.operator === ts.SyntaxKind.MinusToken) return -number;
    if (value.operator === ts.SyntaxKind.PlusToken) return number;
  }
  if (ts.isIdentifier(value)) return env?.get(value.text)?.constantNumber;
  return undefined;
}

function objectNumberArgument(
  call: ts.CallExpression,
  name: string,
  sf: ts.SourceFile,
  env?: Map<string, Flow>,
): number | undefined {
  const first = call.arguments[0];
  if (!first || !ts.isObjectLiteralExpression(first)) return undefined;
  for (const property of first.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = property.name.getText(sf).replace(/["']/g, "");
    if (key === name) return literalNumber(property.initializer, sf, env);
  }
  return undefined;
}

function callArgs(call: ts.CallExpression, env: Map<string, Flow>, state: EvalState, sf: ts.SourceFile): Flow[] {
  return call.arguments
    .filter((arg) => !ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg))
    .map((arg) => evaluateExpression(arg, env, state, sf));
}

function evaluateCallback(
  callback: ts.Expression | undefined,
  receiver: Flow,
  env: Map<string, Flow>,
  state: EvalState,
  sf: ts.SourceFile,
): Flow {
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return sourceFlow("unknown", "unknown callback", receiver.retention);
  }

  const local = new Map(env);
  const item = receiver.hasSource ? sourceFlow(receiver.kind === "raw" ? "raw" : "projected", "collection item", receiver.retention) : cleanFlow("collection item");
  if (callback.parameters[0]) bindPattern(callback.parameters[0].name, item, local, state, sf);
  if (callback.parameters[1]) bindPattern(callback.parameters[1].name, cleanFlow("index"), local, state, sf);

  if (ts.isBlock(callback.body)) {
    const returns: Flow[] = [];
    visitFunctionStatements(callback.body, local, state, sf, returns);
    return returns.length > 0 ? combine(returns, "callback return") : cleanFlow("callback");
  }
  return evaluateExpression(callback.body, local, state, sf);
}

function evaluateMethodCall(
  call: ts.CallExpression,
  property: ts.PropertyAccessExpression,
  env: Map<string, Flow>,
  state: EvalState,
  sf: ts.SourceFile,
): Flow {
  const receiver = evaluateExpression(property.expression, env, state, sf);
  const method = property.name.text;
  if (!receiver.hasSource) return cleanFlow(`pure ${method}`);

  const callback = call.arguments.find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
  switch (method) {
    case "map":
    case "flatMap": {
      const mapped = evaluateCallback(callback, receiver, env, state, sf);
      if (!mapped.hasSource) return cleanFlow(`${method} scalar projection`);
      if (UNSAFE_KINDS.has(mapped.kind)) return { ...mapped, operation: `${method} preserves source` };
      state.meaningfulTransformations++;
      // map/flatMap can emit one item per input (or more), so field mapping
      // is not a proof that the total result is context-bounded.
      return reducedFlow(mapped.kind === "aggregated" ? "aggregated" : "projected", `${method} projection`, Math.min(receiver.retention, mapped.retention, 0.5));
    }
    case "filter":
      state.meaningfulTransformations++;
      return reducedFlow("selected", "filter collection", Math.min(receiver.retention, 0.5));
    case "find":
    case "findLast":
      state.meaningfulTransformations++;
      return boundedFlow("selected", `select ${method} item`, Math.min(receiver.retention, 0.15));
    case "reduce":
    case "reduceRight":
      state.meaningfulTransformations++;
      return reducedFlow("aggregated", `${method} aggregation`, Math.min(receiver.retention, 0.15));
    case "slice":
    case "substring":
    case "substr": {
      state.meaningfulTransformations++;
      const start = literalNumber(call.arguments[0], sf, env);
      const second = literalNumber(call.arguments[1], sf, env);
      // `slice(0, 10)`, `substring(0, 10)`, and `substr(0, 10)` have an
      // explicit output bound. A one-argument positive slice is a tail of
      // unbounded size and must not be treated as safe.
      const limit = second !== undefined
        ? Math.abs(second - (start ?? 0))
        : start !== undefined && start < 0
          ? Math.abs(start)
          : undefined;
      return limit !== undefined
        ? boundedFlow("selected", `${method} bounded selection`, Math.min(receiver.retention, Math.max(0.02, limit / 1000)))
        : reducedFlow("selected", `${method} unbounded selection`, receiver.retention);
    }
    case "match":
    case "matchAll":
      state.meaningfulTransformations++;
      return reducedFlow("selected", `${method} selection`, Math.min(receiver.retention, 0.25));
    case "includes":
    case "startsWith":
    case "endsWith":
    case "indexOf":
    case "lastIndexOf":
    case "some":
    case "every":
    case "has":
      state.meaningfulTransformations++;
      return boundedFlow("projected", `${method} scalar predicate`, 0.01);
    case "join":
      if (UNSAFE_KINDS.has(receiver.kind)) {
        return { ...receiver, operation: "join preserves source" };
      }
      state.meaningfulTransformations++;
      return reducedFlow("selected", "join projected values", receiver.retention, receiver.bounded);
    case "split":
      // Splitting alone does not reduce data; `.length`, `.filter`, etc. do.
      // Preserve the receiver's taint instead of escalating it.
      return { ...receiver, operation: "split without reduction" };
    case "trim":
    case "replace":
    case "replaceAll":
    case "normalize":
    case "toString":
      // Normalization does not prove any context bound. Preserve the receiver's
      // taint and let the final bound check reject raw-preserving transforms.
      state.meaningfulTransformations++;
      return { ...receiver, operation: `${method} preserves source` };
    case "sort":
    case "reverse":
      return { ...receiver, operation: `${method} reorders source` };
    default:
      return { ...receiver, kind: "unknown", operation: `unknown method ${method}` };
  }
}

function evaluateCall(call: ts.CallExpression, env: Map<string, Flow>, state: EvalState, sf: ts.SourceFile): Flow {
  const name = getCalleeText(call.expression, sf);
  const effect = contextEffectFor(name);
  if (isContextHelperText(name)) {
    const args = callArgs(call, env, state, sf);
    const source = args.some((flow) => flow.hasSource);
    if (effect.kind === "compress") {
      state.meaningfulTransformations++;
      const maxTokens = objectNumberArgument(call, effect.boundFrom ?? "maxTokens", sf, env);
      return boundedFlow("compressed", "context summary", maxTokens ? Math.min(0.08, maxTokens / 10000) : 0.08);
    }
    if (effect.kind === "offload") {
      state.meaningfulTransformations++;
      return boundedFlow("offloaded", "context offload", 0);
    }
    if (effect.kind === "select") {
      state.meaningfulTransformations++;
      return boundedFlow("selected", "context selection", 0.25);
    }
    if (effect.kind === "scalar") {
      return source ? boundedFlow("projected", "context scalar", 0.01) : cleanFlow("context scalar");
    }
    return source ? reducedFlow("selected", "context helper", 0.25) : cleanFlow("context helper");
  }

  if (isFoveaCall(call, sf)) {
    const maxTokens = objectNumberArgument(call, "maxTokens", sf, env);
    if (maxTokens !== undefined) {
      state.boundedSelectionCalls++;
      state.meaningfulTransformations++;
      return boundedFlow("selected", "Fovea budgeted selection", Math.min(0.25, maxTokens / 10000));
    }
    return sourceFlow("unknown", "unbounded Fovea selection");
  }

  if (effect.kind === "source" || isDataToolCall(call, sf)) return sourceFlow("raw", `data source ${name}`);

  const args = callArgs(call, env, state, sf);
  const sourced = args.some((flow) => flow.hasSource);
  const simpleName = name.replace(/^.*\./, "");

  if (["String", "JSON.stringify", "encodeURIComponent", "btoa", "Buffer.from"].includes(name) || ["Stringify", "toString"].includes(simpleName)) {
    const flow = args.find((item) => item.hasSource);
    return flow ? { ...flow, kind: "encoded", meaningful: false, operation: `${name} preserves source` } : cleanFlow(name);
  }
  if (name === "JSON.parse") {
    const flow = args.find((item) => item.hasSource);
    return flow ? { ...flow, kind: "unknown", meaningful: false, operation: "JSON.parse preserves source" } : cleanFlow(name);
  }
  if (name === "Object.fromEntries") {
    return sourced ? reducedFlow("projected", "Object.fromEntries projection", 0.25) : cleanFlow(name);
  }
  if (name === "Array.from" || name === "Array.of") {
    return sourced ? reducedFlow("projected", `${name} projection`, 0.5) : cleanFlow(name);
  }
  if (["Object.keys", "Object.entries"].includes(name)) {
    return sourced ? reducedFlow("projected", `${name} dynamically sized projection`, 0.25) : cleanFlow(name);
  }
  if (name === "Object.values") {
    return sourced ? reducedFlow("selected", "Object.values dynamically sized selection", 0.5) : cleanFlow(name);
  }
  if (["Math.abs", "Math.ceil", "Math.floor", "Math.round", "Number", "Boolean", "parseInt", "parseFloat"].includes(name)) {
    return sourced ? boundedFlow("projected", `${name} scalar projection`, 0.01) : cleanFlow(name);
  }
  if (/^Promise\.(?:resolve|reject)$/.test(name)) {
    return combine(args, `${name} preserves source`);
  }
  if (/^Promise\.(?:all|allSettled|race|any)$/.test(name)) {
    return combine(args, `${name} aggregate`);
  }

  if (ts.isPropertyAccessExpression(call.expression)) {
    return evaluateMethodCall(call, call.expression, env, state, sf);
  }

  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) {
    const fn = state.functions.get(callee.text);
    if (fn && !state.activeFunctions.has(fn)) {
      state.activeFunctions.add(fn);
      const result = evaluateFunction(fn.node, args, env, state, sf);
      state.activeFunctions.delete(fn);
      return result;
    }
  }

  // Unknown functions receiving source data are not assumed to compress it.
  return sourced ? sourceFlow("unknown", `unknown function ${name}`) : cleanFlow(`call ${name}`);
}

function evaluateExpression(expr: ts.Expression, env: Map<string, Flow>, state: EvalState, sf: ts.SourceFile): Flow {
  const value = unwrap(expr);

  if (ts.isAwaitExpression(value)) return evaluateExpression(value.expression, env, state, sf);
  if (ts.isIdentifier(value)) return env.get(value.text) ?? cleanFlow(`identifier ${value.text}`);
  if (ts.isNumericLiteral(value)) return cleanFlow("literal", Number(value.text));
  if (ts.isPrefixUnaryExpression(value) && ts.isNumericLiteral(value.operand)) {
    const number = Number(value.operand.text);
    if (value.operator === ts.SyntaxKind.MinusToken) return cleanFlow("literal", -number);
    if (value.operator === ts.SyntaxKind.PlusToken) return cleanFlow("literal", number);
  }
  if (ts.isStringLiteral(value) || ts.isBigIntLiteral(value) || ts.isRegularExpressionLiteral(value)) return cleanFlow("literal");
  if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword || value.kind === ts.SyntaxKind.NullKeyword) return cleanFlow("literal");

  if (ts.isTemplateExpression(value)) {
    const expressions = value.templateSpans.map((span) => evaluateExpression(span.expression, env, state, sf));
    const flow = combine(expressions, "template interpolation");
    // Interpolation is bounded composition, not data amplification: keep the
    // worst source kind but do not escalate to "encoded".
    return flow.hasSource ? { ...flow, operation: "template interpolation" } : cleanFlow("template");
  }
  if (ts.isPropertyAccessExpression(value)) return propertyFlow(evaluateExpression(value.expression, env, state, sf), value.name.text);
  if (ts.isElementAccessExpression(value)) {
    const receiver = evaluateExpression(value.expression, env, state, sf);
    if (value.argumentExpression && ts.isStringLiteral(value.argumentExpression)) {
      return propertyFlow(receiver, value.argumentExpression.text);
    }
    return elementFlow(receiver);
  }
  if (ts.isCallExpression(value)) return evaluateCall(value, env, state, sf);
  if (ts.isSpreadElement(value)) return evaluateExpression(value.expression, env, state, sf);
  if (ts.isArrayLiteralExpression(value)) return combine(value.elements.map((item) => evaluateExpression(item, env, state, sf)), "array aggregate");
  if (ts.isObjectLiteralExpression(value)) {
    const fields: Flow[] = [];
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) fields.push(evaluateExpression(property.expression, env, state, sf));
      else if (ts.isShorthandPropertyAssignment(property)) fields.push(env.get(property.name.text) ?? cleanFlow("shorthand"));
      else if (ts.isPropertyAssignment(property)) fields.push(evaluateExpression(property.initializer, env, state, sf));
    }
    return combine(fields, "object projection");
  }
  if (ts.isConditionalExpression(value)) return combine([
    evaluateExpression(value.whenTrue, env, state, sf),
    evaluateExpression(value.whenFalse, env, state, sf),
  ], "conditional result");
  if (ts.isBinaryExpression(value)) {
    const left = evaluateExpression(value.left, env, state, sf);
    const right = evaluateExpression(value.right, env, state, sf);
    const operation = ts.tokenToString(value.operatorToken.kind) ?? "binary operation";
    if (["===", "!==", "==", "!=", ">", ">=", "<", "<="].includes(operation)) {
      return (left.hasSource || right.hasSource)
        ? boundedFlow("projected", `scalar ${operation}`, 0.01)
        : cleanFlow(`scalar ${operation}`);
    }
    if (["&&", "||", "??"].includes(operation)) {
      // JavaScript returns one of the operands for short-circuit operators;
      // they are not scalar predicates and must preserve source taint/bounds.
      return combine([left, right], `short-circuit ${operation}`);
    }
    const flow = combine([left, right], operation);
    return flow.hasSource ? { ...flow, operation: `${operation} combines source` } : flow;
  }
  if (ts.isParenthesizedExpression(value)) return evaluateExpression(value.expression, env, state, sf);

  return cleanFlow("unclassified expression");
}

function bindPattern(pattern: ts.BindingName, value: Flow, env: Map<string, Flow>, state: EvalState, sf: ts.SourceFile): void {
  if (ts.isIdentifier(pattern)) {
    env.set(pattern.text, value);
    return;
  }
  if (ts.isObjectBindingPattern(pattern)) {
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element.name)) continue;
      const property = element.propertyName?.getText(sf) ?? element.name.getText(sf);
      bindPattern(element.name, propertyFlow(value, property), env, state, sf);
    }
    return;
  }
  if (ts.isArrayBindingPattern(pattern)) {
    let index = 0;
    for (const element of pattern.elements) {
      if (ts.isBindingElement(element)) bindPattern(element.name, elementFlow(value, String(index)), env, state, sf);
      index++;
    }
  }
}

function collectFunctions(node: ts.Node, functions: Map<string, FunctionLike>): void {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, { node });
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    functions.set(node.name.text, { node: node.initializer });
  }
  ts.forEachChild(node, (child) => collectFunctions(child, functions));
}

function visitBindings(node: ts.Node, env: Map<string, Flow>, state: EvalState, sf: ts.SourceFile): void {
  if (isFunctionLikeNode(node)) return;
  if (ts.isVariableDeclaration(node) && node.initializer) {
    bindPattern(node.name, evaluateExpression(node.initializer, env, state, sf), env, state, sf);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
    env.set(node.left.text, evaluateExpression(node.right, env, state, sf));
  }
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    const iterable = evaluateExpression(node.expression, env, state, sf);
    const item = ts.isForOfStatement(node)
      ? (iterable.hasSource ? { ...iterable, operation: "loop item" } : cleanFlow("loop item"))
      : (iterable.hasSource ? sourceFlow("unknown", "loop key") : cleanFlow("loop key"));
    if (ts.isVariableDeclarationList(node.initializer)) {
      const declaration = node.initializer.declarations[0];
      if (declaration) bindPattern(declaration.name, item, env, state, sf);
    } else if (ts.isIdentifier(node.initializer)) {
      env.set(node.initializer.text, item);
    }
    visitBindings(node.statement, env, state, sf);
    return;
  }
  ts.forEachChild(node, (child) => visitBindings(child, env, state, sf));
}

function visitFunctionStatements(
  node: ts.Node,
  env: Map<string, Flow>,
  state: EvalState,
  sf: ts.SourceFile,
  returns: Flow[],
): void {
  if (isFunctionLikeNode(node) && !ts.isBlock(node)) return;
  if (ts.isVariableDeclaration(node) && node.initializer) {
    bindPattern(node.name, evaluateExpression(node.initializer, env, state, sf), env, state, sf);
  }
  if (ts.isReturnStatement(node) && node.expression) returns.push(evaluateExpression(node.expression, env, state, sf));
  ts.forEachChild(node, (child) => visitFunctionStatements(child, env, state, sf, returns));
}

function evaluateFunction(
  fn: FunctionLike["node"],
  args: Flow[],
  parentEnv: Map<string, Flow>,
  state: EvalState,
  sf: ts.SourceFile,
): Flow {
  const env = new Map(parentEnv);
  fn.parameters.forEach((parameter, index) => {
    bindPattern(parameter.name, args[index] ?? cleanFlow("missing argument"), env, state, sf);
  });
  if (!ts.isBlock(fn.body)) return evaluateExpression(fn.body, env, state, sf);
  const returns: Flow[] = [];
  visitFunctionStatements(fn.body, env, state, sf, returns);
  return returns.length > 0 ? combine(returns, "function return") : cleanFlow("function");
}

function collectProgramMetrics(sf: ts.SourceFile, metrics: ProgramMetrics): void {
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isDataToolCall(node, sf)) metrics.toolCalls++;
    if (ts.isIfStatement(node) || ts.isSwitchStatement(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isConditionalExpression(node)) metrics.hasLoopOrConditional = true;
    if (ts.isVariableStatement(node)) {
      metrics.hasVariableAssignment = true;
      metrics.declaredVariables += node.declarationList.declarations.length;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  metrics.sourceCalls = metrics.toolCalls;
}

function topLevelReturns(sf: ts.SourceFile, env: Map<string, Flow>, state: EvalState): Flow[] {
  const returns: Flow[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLikeNode(node)) return;
    if (ts.isReturnStatement(node) && node.expression) returns.push(evaluateExpression(node.expression, env, state, sf));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return returns;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function analyzeProgram(source: string, opts: AnalyzerOptions = {}): AnalysisResult {
  const metrics: ProgramMetrics = {
    toolCalls: 0,
    sourceCalls: 0,
    returnIsRawToolResult: false,
    returnIsReduced: false,
    provablyBounded: true,
    transformationCount: 0,
    hasProcessingBetweenToolAndReturn: false,
    hasLoopOrConditional: false,
    hasVariableAssignment: false,
    estimatedReturnTokens: null,
    declaredVariables: 0,
    returnTaint: "clean",
    returnOperation: "no return",
    meaningfulTransformations: 0,
    boundedSelectionCalls: 0,
    estimatedSourceTokens: null,
    estimatedRetentionRatio: null,
    estimatedReductionRatio: null,
  };

  const sourceText = source.trim();
  if (!sourceText) {
    return { ok: false, hardBlock: true, reasons: ["Empty program."], metrics };
  }

  const sf = ts.createSourceFile("program.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  collectProgramMetrics(sf, metrics);
  const state: EvalState = {
    functions: new Map(),
    activeFunctions: new Set(),
    boundedSelectionCalls: 0,
    meaningfulTransformations: 0,
  };
  collectFunctions(sf, state.functions);
  const env = new Map<string, Flow>();
  visitBindings(sf, env, state, sf);
  const returns = topLevelReturns(sf, env, state);
  const returned = returns.length > 0 ? combine(returns, "program return") : cleanFlow("no return");

  metrics.boundedSelectionCalls = state.boundedSelectionCalls;
  metrics.meaningfulTransformations = state.meaningfulTransformations;
  metrics.transformationCount = state.meaningfulTransformations;
  metrics.returnTaint = returned.kind;
  metrics.returnOperation = returned.operation;
  metrics.returnIsRawToolResult = returned.hasSource && UNSAFE_KINDS.has(returned.kind);
  metrics.returnIsReduced = returned.hasSource && returned.meaningful;
  metrics.provablyBounded = !returned.hasSource || returned.bounded;
  metrics.hasProcessingBetweenToolAndReturn = returned.hasSource && (returned.meaningful || REDUCING_KINDS.has(returned.kind));
  metrics.estimatedRetentionRatio = returned.hasSource ? returned.retention : null;
  metrics.estimatedReductionRatio = returned.hasSource ? Math.max(0, 1 - returned.retention) : null;

  for (const node of returns) {
    // This is deliberately only a source-size estimate for static returns;
    // runtime tool payloads are measured by the result hook.
    if (node.operation === "literal" || node.operation === "object projection" || node.operation === "array aggregate" || node.operation === "template interpolation") {
      metrics.estimatedReturnTokens = Math.max(metrics.estimatedReturnTokens ?? 0, estimateTokens(node.operation === "literal" ? sourceText : node.operation));
    }
  }
  // Use the source text of literal return expressions when available.
  const literalReturns: string[] = [];
  const collectLiteralReturns = (node: ts.Node): void => {
    if (isFunctionLikeNode(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      const expression = unwrap(node.expression);
      if (ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression) || ts.isTemplateExpression(expression) || ts.isStringLiteral(expression)) literalReturns.push(expression.getText(sf));
    }
    ts.forEachChild(node, collectLiteralReturns);
  };
  collectLiteralReturns(sf);
  if (literalReturns.length > 0) metrics.estimatedReturnTokens = Math.max(...literalReturns.map(estimateTokens));

  const reasons: string[] = [];
  let hardBlock = false;
  if (returned.hasSource && !returned.bounded) {
    hardBlock = true;
    reasons.push(
      `Return carries ${metrics.returnTaint} tool data (${metrics.returnOperation}) without a provable context bound after ${metrics.sourceCalls} source call(s). ` +
        "A transformation such as map, filter, reduce, trim, or replace may still retain the full source. " +
        "Use scalar projections, find/some/every, slice(0, N), extensions.ctx_summarize({ text, mode: \"structural\", maxTokens }), " +
        "extensions.ctx_offload({ key, source, data }), or delegate the work."
    );
  }

  const maxReturnTokens = opts.maxReturnTokens ?? 4000;
  if (metrics.estimatedReturnTokens !== null && metrics.estimatedReturnTokens > maxReturnTokens) {
    // Statically known oversize: stopping before execution is free, and the
    // size is certain (unlike taint heuristics), so this stays a hard block.
    hardBlock = true;
    reasons.push(
      `Return is estimated at ~${metrics.estimatedReturnTokens} tokens (>${maxReturnTokens}). ` +
        "Use ctx_summarize or project to a smaller structure before returning."
    );
  }

  metrics.sourceCalls = metrics.toolCalls;
  const ok = reasons.length === 0;
  return { ok, hardBlock, reasons, metrics };
}
