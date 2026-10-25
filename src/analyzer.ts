/**
 * Static data-flow analysis for Fabric code-mode programs.
 *
 * The important question is not whether a program contains a function call;
 * it is whether data originating at a tool can still reach the final return
 * without a context-reducing operation.  This module intentionally uses an
 * abstract interpreter rather than a global "some call happened" flag.
 */

import { createRequire } from "node:module";
import type TS from "typescript";
import {
  contextEffectFor,
  isContextHelperName,
  isFoveaName,
  type BoundUnit,
  type ContextEffect,
  type ContextProvenanceLocation,
  type ContextProvenanceStep,
  type ResolvedBound,
} from "./context-effects.js";
import { evaluateReturnBudget, type ContextBoundaryPolicy, type QuantitativeDecision } from "./quantitative-policy.js";

// TypeScript is needed only when a program is analyzed (strict preflight,
// ce_exec, explainProgram); load it on first use instead of at startup.
let typescript: typeof TS | undefined;
const ts = new Proxy({} as typeof TS, {
  get: (_target, key) => Reflect.get(typescript ??= createRequire(import.meta.url)("typescript") as typeof TS, key),
});

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
  /** Quantitative result bound; unknown means no literal numeric bound was resolved. */
  returnBound?: ResolvedBound;
  /** Structured source/effect history for the final returned flow. */
  returnProvenance: ContextProvenanceStep[];
  /** Independent size-policy result; legacy flow policy remains separately observable. */
  quantitativeDecision?: QuantitativeDecision;
  /** True when a within-budget proof removed only the legacy unbounded-return block. */
  quantitativePolicyApplied: boolean;
}

export interface AnalyzerOptions {
  /** Legacy compatibility knob; cost/reduction is now the primary policy. */
  maxUnprocessedToolCalls?: number;
  /** Maximum estimated tokens for a literal/bounded return. */
  maxReturnTokens?: number;
  /** Optional quantitative budgets consumed only when legacy policy is unsafe. */
  quantitativePolicy?: ContextBoundaryPolicy;
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
  /** Quantitative output bound, independent from the policy bounded flag. */
  bound?: ResolvedBound;
  /** Structured source/effect history for this value. */
  provenance: ContextProvenanceStep[];
}

interface FunctionLike {
  node: TS.FunctionDeclaration | TS.FunctionExpression | TS.ArrowFunction;
}

interface EvalState {
  functions: Map<string, FunctionLike>;
  activeFunctions: Set<FunctionLike>;
  boundedSelectionCalls: number;
  meaningfulTransformations: number;
  constantResolver: NumericConstantResolver;
}

const UNSAFE_KINDS = new Set<TaintKind>(["raw", "encoded", "unknown"]);
const REDUCING_KINDS = new Set<TaintKind>(["projected", "selected", "aggregated", "compressed", "offloaded"]);

function unknownBound(unit?: BoundUnit): ResolvedBound {
  return unit ? { kind: "unknown", unit } : { kind: "unknown" };
}

function exactBound(value: number, unit: BoundUnit): ResolvedBound {
  return { kind: "exact", value, unit };
}

function upperBound(value: number, unit: BoundUnit): ResolvedBound {
  return { kind: "upper", value, unit };
}

function effectReason(effect: ContextEffect["kind"]): string {
  switch (effect) {
    case "source": return "Tool-originated data enters the flow.";
    case "select": return "The registry declares a selection effect.";
    case "compress": return "The registry declares a compression effect.";
    case "offload": return "The registry declares an offload effect.";
    case "scalar": return "The operation projects a scalar result.";
    case "passthrough": return "The operation preserves the source shape.";
    case "unknown": return "The effect is unknown, so analysis stays conservative.";
  }
}

function nodeLocation(sf: TS.SourceFile, node: TS.Node): ContextProvenanceLocation {
  const position = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: position.line + 1, column: position.character + 1 };
}

function effectStep(
  operation: string,
  effect: ContextEffect["kind"],
  bound?: ResolvedBound,
  location?: ContextProvenanceLocation,
  reason?: string,
): ContextProvenanceStep {
  return {
    operation,
    effect,
    reason: reason ?? effectReason(effect),
    ...(bound === undefined ? {} : { bound }),
    ...(location === undefined ? {} : { location }),
  };
}

function mergeProvenance(flows: Flow[]): ContextProvenanceStep[] {
  return flows.flatMap((flow) => flow.provenance);
}

function withUnknownBound(flow: Flow, operation = flow.operation): Flow {
  return { ...flow, operation, bound: unknownBound() };
}

function cleanFlow(operation = "constant", constantNumber?: number, provenance: ContextProvenanceStep[] = []): Flow {
  return { kind: "clean", hasSource: false, bounded: true, meaningful: false, retention: 0, operation, constantNumber, provenance };
}

function sourceFlow(
  kind: TaintKind = "raw",
  operation = "tool result",
  retention = 1,
  provenance: ContextProvenanceStep[] = [],
  bound: ResolvedBound = unknownBound(),
): Flow {
  return {
    kind,
    hasSource: true,
    bounded: false,
    meaningful: false,
    retention: Math.max(0, Math.min(1, retention)),
    operation,
    provenance,
    bound,
  };
}

function reducedFlow(
  kind: TaintKind,
  operation: string,
  retention: number,
  bounded = false,
  provenance: ContextProvenanceStep[] = [],
  bound: ResolvedBound = unknownBound(),
): Flow {
  return {
    kind,
    hasSource: true,
    bounded,
    meaningful: true,
    // If the operation is dynamically sized, it may retain the entire source.
    retention: bounded ? Math.max(0, Math.min(1, retention)) : 1,
    operation,
    provenance,
    bound,
  };
}

function boundedFlow(
  kind: TaintKind,
  operation: string,
  retention: number,
  provenance: ContextProvenanceStep[] = [],
  bound: ResolvedBound = unknownBound(),
): Flow {
  return reducedFlow(kind, operation, retention, true, provenance, bound);
}

function getCalleeText(expr: TS.Expression, sf: TS.SourceFile): string {
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

function isDataToolCall(node: TS.CallExpression, sf: TS.SourceFile): boolean {
  return isDataToolText(getCalleeText(node.expression, sf));
}

function isFoveaCall(node: TS.CallExpression, sf: TS.SourceFile): boolean {
  return isFoveaText(getCalleeText(node.expression, sf));
}

function isFunctionLikeNode(node: TS.Node): node is FunctionLike["node"] {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

function unwrap(expr: TS.Expression): TS.Expression {
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

interface ConstantScope {
  parent?: ConstantScope;
  bindings: Map<string, ConstantBinding>;
}

interface ConstantBinding {
  mutable: boolean;
  initializer?: TS.Expression;
  scope: ConstantScope;
}

type NumericResolutionKind = "exact" | "upper" | "unknown";

interface NumericConstantResolution {
  kind: NumericResolutionKind;
  value?: number;
  chain: string[];
  expression?: string;
  derivation?: NumericResolutionDerivation;
}

interface NumericResolutionDerivation {
  kind: "conditional" | "max";
  expression: string;
  branches?: Array<{ label: "true" | "false"; resolution: NumericConstantResolution }>;
  operands?: NumericConstantResolution[];
}

interface EffectBoundResolution {
  bound?: ResolvedBound;
  reason?: string;
}

function isLexicalScopeNode(node: TS.Node): boolean {
  return ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    isFunctionLikeNode(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isCatchClause(node);
}

function unknownNumericResolution(derivation?: NumericResolutionDerivation): NumericConstantResolution {
  return derivation ? { kind: "unknown", chain: [], derivation } : { kind: "unknown", chain: [] };
}

function safeInteger(value: number): boolean {
  return Number.isSafeInteger(value);
}

function joinConditionalResolution(
  expression: string,
  trueBranch: NumericConstantResolution,
  falseBranch: NumericConstantResolution,
): NumericConstantResolution {
  const derivation: NumericResolutionDerivation = {
    kind: "conditional",
    expression,
    branches: [
      { label: "true", resolution: trueBranch },
      { label: "false", resolution: falseBranch },
    ],
  };
  if (trueBranch.kind === "unknown" || falseBranch.kind === "unknown") return unknownNumericResolution(derivation);
  if (trueBranch.value === undefined || falseBranch.value === undefined) return unknownNumericResolution(derivation);
  const value = Math.max(trueBranch.value, falseBranch.value);
  if (!safeInteger(value)) return unknownNumericResolution(derivation);
  const exact = trueBranch.kind === "exact" && falseBranch.kind === "exact" && trueBranch.value === falseBranch.value;
  return { kind: exact ? "exact" : "upper", value, chain: [], expression, derivation };
}

function joinMaxResolution(expression: string, operands: NumericConstantResolution[]): NumericConstantResolution {
  const derivation: NumericResolutionDerivation = { kind: "max", expression, operands };
  if (operands.length === 0 || operands.some((operand) => operand.kind === "unknown" || operand.value === undefined)) {
    return unknownNumericResolution(derivation);
  }
  const value = Math.max(...operands.map((operand) => operand.value!));
  if (!safeInteger(value)) return unknownNumericResolution(derivation);
  const exact = operands.every((operand) => operand.kind === "exact");
  const winners = operands.filter((operand) => operand.value === value);
  const chain = [...new Set(winners.flatMap((operand) => operand.chain))];
  return { kind: exact ? "exact" : "upper", value, chain, expression, derivation };
}

class NumericConstantResolver {
  private readonly scopes = new WeakMap<TS.Node, ConstantScope>();

  constructor(sourceFile: TS.SourceFile) {
    const root: ConstantScope = { bindings: new Map() };
    this.visit(sourceFile, root, true);
  }

  resolve(expr: TS.Expression): number | undefined {
    const result = this.resolveWithChain(expr);
    return result.kind === "exact" ? result.value : undefined;
  }

  resolveWithChain(expr: TS.Expression): NumericConstantResolution {
    const scope = this.scopes.get(expr);
    return scope ? this.resolveExactExpression(expr, scope, new Set<ConstantBinding>()) : unknownNumericResolution();
  }

  resolveUpperBound(expr: TS.Expression): NumericConstantResolution {
    const scope = this.scopes.get(expr);
    return scope ? this.resolveUpperExpression(expr, scope, new Set<ConstantBinding>()) : unknownNumericResolution();
  }

  private visit(node: TS.Node, parent: ConstantScope, useParent = false): void {
    const scope = useParent ? parent : isLexicalScopeNode(node) ? { parent, bindings: new Map() } : parent;
    this.scopes.set(node, scope);
    if (ts.isFunctionLike(node)) {
      this.addPattern(node.parameters[0]?.name, scope, true);
      for (let index = 1; index < node.parameters.length; index++) this.addPattern(node.parameters[index].name, scope, true);
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) this.addPattern(node.variableDeclaration.name, scope, true);
    this.collectDirectDeclarations(node, scope);
    ts.forEachChild(node, (child) => this.visit(child, scope));
  }

  private collectDirectDeclarations(node: TS.Node, scope: ConstantScope): void {
    const collect = (current: TS.Node, isRoot: boolean): void => {
      if (!isRoot && isLexicalScopeNode(current)) return;
      if (ts.isVariableStatement(current)) this.addDeclarationList(current.declarationList, scope);
      else if (ts.isVariableDeclarationList(current)) this.addDeclarationList(current, scope);
      ts.forEachChild(current, (child) => collect(child, false));
    };
    collect(node, true);
  }

  private addDeclarationList(list: TS.VariableDeclarationList, scope: ConstantScope): void {
    const mutable = (list.flags & ts.NodeFlags.Const) === 0;
    for (const declaration of list.declarations) {
      this.addPattern(declaration.name, scope, mutable, ts.isIdentifier(declaration.name) ? declaration.initializer : undefined);
    }
  }

  private addPattern(pattern: TS.BindingName | undefined, scope: ConstantScope, mutable: boolean, initializer?: TS.Expression): void {
    if (!pattern) return;
    if (ts.isIdentifier(pattern)) {
      scope.bindings.set(pattern.text, { mutable, initializer, scope });
      return;
    }
    for (const element of pattern.elements) {
      if (ts.isBindingElement(element)) this.addPattern(element.name, scope, true);
    }
  }

  private resolveExactExpression(expr: TS.Expression, scope: ConstantScope, seen: Set<ConstantBinding>): NumericConstantResolution {
    const value = unwrap(expr);
    if (ts.isNumericLiteral(value)) {
      const number = Number(value.text.replace(/_/g, ""));
      return safeInteger(number) ? { kind: "exact", value: number, chain: [], expression: value.getText() } : unknownNumericResolution();
    }
    if (ts.isPrefixUnaryExpression(value) && ts.isNumericLiteral(value.operand)) {
      const number = Number(value.operand.text.replace(/_/g, ""));
      const signed = value.operator === ts.SyntaxKind.MinusToken ? -number : value.operator === ts.SyntaxKind.PlusToken ? number : NaN;
      return safeInteger(signed) ? { kind: "exact", value: signed, chain: [], expression: value.getText() } : unknownNumericResolution();
    }
    if (ts.isIdentifier(value)) {
      const binding = this.lookup(scope, value.text);
      if (!binding || binding.mutable || !binding.initializer || seen.has(binding)) return unknownNumericResolution();
      seen.add(binding);
      const resolved = this.resolveExactExpression(binding.initializer, binding.scope, seen);
      seen.delete(binding);
      return resolved.kind === "exact" ? { ...resolved, chain: [value.text, ...resolved.chain] } : resolved;
    }
    if (ts.isConditionalExpression(value)) {
      const trueBranch = this.resolveExactExpression(value.whenTrue, scope, seen);
      const falseBranch = this.resolveExactExpression(value.whenFalse, scope, seen);
      return joinConditionalResolution(value.getText(), trueBranch, falseBranch);
    }
    if (!ts.isBinaryExpression(value)) return unknownNumericResolution();
    const operator = ts.tokenToString(value.operatorToken.kind);
    if (operator !== "+" && operator !== "-" && operator !== "*") return unknownNumericResolution();
    const left = this.resolveExactExpression(value.left, scope, seen);
    const right = this.resolveExactExpression(value.right, scope, seen);
    if (left.kind !== "exact" || right.kind !== "exact") return unknownNumericResolution();
    const result = operator === "+" ? left.value! + right.value! : operator === "-" ? left.value! - right.value! : left.value! * right.value!;
    return safeInteger(result)
      ? { kind: "exact", value: result, chain: [...left.chain, ...right.chain], expression: value.getText() }
      : unknownNumericResolution();
  }

  private resolveUpperExpression(expr: TS.Expression, scope: ConstantScope, seen: Set<ConstantBinding>): NumericConstantResolution {
    const exact = this.resolveExactExpression(expr, scope, new Set(seen));
    if (exact.kind === "exact") return exact;
    const value = unwrap(expr);
    if (ts.isIdentifier(value)) {
      const binding = this.lookup(scope, value.text);
      if (!binding || binding.mutable || !binding.initializer || seen.has(binding)) return unknownNumericResolution();
      seen.add(binding);
      const resolved = this.resolveUpperExpression(binding.initializer, binding.scope, seen);
      seen.delete(binding);
      return resolved.kind === "unknown" ? resolved : { ...resolved, chain: [value.text, ...resolved.chain] };
    }
    if (ts.isConditionalExpression(value)) {
      const trueBranch = this.resolveUpperExpression(value.whenTrue, scope, new Set(seen));
      const falseBranch = this.resolveUpperExpression(value.whenFalse, scope, new Set(seen));
      return joinConditionalResolution(value.getText(), trueBranch, falseBranch);
    }
    if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)) return unknownNumericResolution();
    if (value.arguments.length === 0) return unknownNumericResolution();
    const functionName = value.expression.getText();
    const argumentsResolved = value.arguments.map((argument) => this.resolveUpperExpression(argument, scope, new Set(seen)));
    if (functionName === "Math.max") return joinMaxResolution(value.getText(), argumentsResolved);
    if (functionName !== "Math.min") return unknownNumericResolution();
    const known = argumentsResolved.filter((item) => item.kind !== "unknown" && item.value !== undefined);
    if (known.length === 0 || known.some((item) => !safeInteger(item.value!) || item.value! < 0)) return unknownNumericResolution();
    const upperValue = Math.min(...known.map((item) => item.value!));
    const winners = known.filter((item) => item.value === upperValue);
    const chain = [...new Set(winners.flatMap((item) => item.chain))];
    const allExact = known.length === argumentsResolved.length && known.every((item) => item.kind === "exact");
    return {
      kind: allExact ? "exact" : "upper",
      value: upperValue,
      chain,
      expression: value.getText(),
    };
  }

  private lookup(scope: ConstantScope, name: string): ConstantBinding | undefined {
    let current: ConstantScope | undefined = scope;
    while (current) {
      const binding = current.bindings.get(name);
      if (binding) return binding;
      current = current.parent;
    }
    return undefined;
  }
}

function combine(flows: Flow[], operation: string, preserveSingleBound = false): Flow {
  const sourced = flows.filter((flow) => flow.hasSource);
  if (sourced.length === 0) return cleanFlow(operation);
  const provenance = mergeProvenance(sourced);
  const combinedBound = preserveSingleBound && sourced.length === 1 ? sourced[0].bound : unknownBound();

  const firstUnsafe = sourced.find((flow) => flow.kind === "raw");
  if (firstUnsafe) return { ...firstUnsafe, operation, provenance, bound: preserveSingleBound && sourced.length === 1 ? combinedBound : unknownBound() };
  const encoded = sourced.find((flow) => flow.kind === "encoded");
  if (encoded) return { ...encoded, operation, provenance, bound: preserveSingleBound && sourced.length === 1 ? combinedBound : unknownBound() };
  const unknown = sourced.find((flow) => flow.kind === "unknown");
  if (unknown) return { ...unknown, operation, provenance, bound: preserveSingleBound && sourced.length === 1 ? combinedBound : unknownBound() };

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
    provenance,
    bound: combinedBound,
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
    return boundedFlow("projected", `scalar property ${property}`, 0.01, [
      ...receiver.provenance,
      effectStep(property, "scalar", unknownBound()),
    ]);
  }
  if (["content", "data", "result", "stdout", "stderr", "text", "body", "value"].includes(property)) {
    return withUnknownBound({ ...receiver, operation: `raw property ${property}` });
  }
  // A property projection is structurally smaller but the property itself can
  // still contain the whole source. It is therefore not a proof of a bound.
  return reducedFlow("projected", `project property ${property}`, Math.min(receiver.retention, 0.5), false, receiver.provenance);
}

function elementFlow(receiver: Flow, index?: string): Flow {
  if (!receiver.hasSource) return cleanFlow("array element");
  if (index === "length" || index === "size") return boundedFlow("projected", "scalar element", 0.01, [
    ...receiver.provenance,
    effectStep(index, "scalar", unknownBound()),
  ]);
  // Selecting one container element does not bound the size of that element;
  // `[raw][0]`, `Promise.all([raw])[0]`, and computed properties can still be
  // the complete source payload.
  if (UNSAFE_KINDS.has(receiver.kind)) return withUnknownBound({ ...receiver, operation: "select source element" });
  return boundedFlow("selected", "select element", Math.min(receiver.retention, 0.25), receiver.provenance);
}

function literalNumber(
  expr: TS.Expression | undefined,
  sf: TS.SourceFile,
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
  call: TS.CallExpression,
  name: string,
  sf: TS.SourceFile,
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

/** Quantitative resolution is deliberately stricter than policy resolution. */
function objectLiteralNumberArgument(
  call: TS.CallExpression,
  name: string,
  sf: TS.SourceFile,
  resolver: NumericConstantResolver,
): NumericConstantResolution {
  const first = call.arguments[0];
  if (!first || !ts.isObjectLiteralExpression(first)) return unknownNumericResolution();
  for (const property of first.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = property.name.getText(sf).replace(/["']/g, "");
    if (key !== name) continue;
    return resolver.resolveUpperBound(property.initializer);
  }
  return unknownNumericResolution();
}

function numericResolutionDetail(resolution: NumericConstantResolution): string {
  if (resolution.kind === "unknown" || resolution.value === undefined) return "unknown";
  const value = resolution.kind === "exact" ? `${resolution.value}` : `≤${resolution.value}`;
  if (resolution.chain.length > 0) return `${resolution.chain.join(" → ")} → ${value}`;
  const expression = resolution.expression?.trim();
  if (expression && !/^[+-]?\d+(?:\.\d+)?$/.test(expression)) return `${expression} → ${value}`;
  return value;
}

function derivedBoundReason(
  name: string,
  unit: BoundUnit,
  resolution: NumericConstantResolution,
  validValue: boolean,
): string | undefined {
  const derivation = resolution.derivation;
  if (!derivation || (!validValue && resolution.kind !== "unknown")) return undefined;
  if (derivation.kind === "conditional") {
    const trueBranch = derivation.branches?.find((branch) => branch.label === "true")?.resolution ?? unknownNumericResolution();
    const falseBranch = derivation.branches?.find((branch) => branch.label === "false")?.resolution ?? unknownNumericResolution();
    const prefix = `${name} uses conditional expression.\n  true branch: ${numericResolutionDetail(trueBranch)}\n  false branch: ${numericResolutionDetail(falseBranch)}`;
    if (resolution.kind === "unknown" || resolution.value === undefined) {
      return `${prefix}\n  conditional join requires a finite upper bound for every branch; ${name} has no provable non-negative safe-integer bound (${unit}).`;
    }
    if (resolution.kind === "exact") return `${prefix}\n  join exact bound: ${resolution.value} ${unit}.`;
    const values = [trueBranch.value, falseBranch.value].filter((value): value is number => value !== undefined);
    return `${prefix}\n  join upper bound: max(${values.join(", ")}) = ${resolution.value} ${unit}.`;
  }

  const operands = derivation.operands ?? [];
  const prefix = `${name} uses Math.max expression.\n${operands.map((operand, index) => `  operand ${index + 1}: ${numericResolutionDetail(operand)}`).join("\n")}`;
  if (resolution.kind === "unknown" || resolution.value === undefined) {
    return `${prefix}\n  max join requires a finite upper bound for every operand; ${name} has no provable non-negative safe-integer bound (${unit}).`;
  }
  const values = operands.map((operand) => operand.value!).join(", ");
  const label = resolution.kind === "exact" ? "exact" : "upper";
  return `${prefix}\n  max join ${label} bound: max(${values}) = ${resolution.value} ${unit}.`;
}

function resolveEffectBound(call: TS.CallExpression, effect: ContextEffect, sf: TS.SourceFile, resolver: NumericConstantResolver): EffectBoundResolution {
  const declaration = effect.kind === "select" || effect.kind === "compress" ? effect.bound : undefined;
  if (!declaration) return {};
  const resolution = objectLiteralNumberArgument(call, declaration.name, sf, resolver);
  const validValue = resolution.value !== undefined && safeInteger(resolution.value) && resolution.value >= 0 && resolution.kind !== "unknown";
  const bound = !validValue
    ? unknownBound(declaration.unit)
    : resolution.kind === "upper"
      ? upperBound(resolution.value!, declaration.unit)
      : exactBound(resolution.value!, declaration.unit);
  const reason = derivedBoundReason(declaration.name, declaration.unit, resolution, validValue) ?? (
    !validValue
      ? `${declaration.name} has no provable non-negative safe-integer bound (${declaration.unit}).`
      : resolution.kind === "upper"
        ? `${declaration.name} is upper-bounded by ${resolution.value} ${declaration.unit}${resolution.expression ? ` via ${resolution.expression}` : ""}${resolution.chain.length > 0 ? ` through ${resolution.chain.join(" → ")}` : ""}.`
        : resolution.chain.length > 0
          ? `${declaration.name} resolves through ${resolution.chain.join(" → ")} = ${resolution.value} ${declaration.unit}.`
          : `${declaration.name} resolves to exact ${resolution.value} ${declaration.unit}.`
  );
  return { bound, reason };
}

function callArgs(call: TS.CallExpression, env: Map<string, Flow>, state: EvalState, sf: TS.SourceFile): Flow[] {
  return call.arguments
    .filter((arg) => !ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg))
    .map((arg) => evaluateExpression(arg, env, state, sf));
}

function evaluateCallback(
  callback: TS.Expression | undefined,
  receiver: Flow,
  env: Map<string, Flow>,
  state: EvalState,
  sf: TS.SourceFile,
): Flow {
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return sourceFlow("unknown", "unknown callback", receiver.retention, receiver.provenance);
  }

  const local = new Map(env);
  const item = receiver.hasSource
    ? sourceFlow(receiver.kind === "raw" ? "raw" : "projected", "collection item", receiver.retention, receiver.provenance)
    : cleanFlow("collection item");
  if (callback.parameters[0]) bindPattern(callback.parameters[0].name, item, local, state, sf);
  if (callback.parameters[1]) bindPattern(callback.parameters[1].name, cleanFlow("index"), local, state, sf);

  if (ts.isBlock(callback.body)) {
    const returns: Flow[] = [];
    visitFunctionStatements(callback.body, local, state, sf, returns);
    return returns.length > 0 ? combine(returns, "callback return", true) : cleanFlow("callback");
  }
  return evaluateExpression(callback.body, local, state, sf);
}

function evaluateMethodCall(
  call: TS.CallExpression,
  property: TS.PropertyAccessExpression,
  env: Map<string, Flow>,
  state: EvalState,
  sf: TS.SourceFile,
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
      if (UNSAFE_KINDS.has(mapped.kind)) return withUnknownBound({ ...mapped, operation: `${method} preserves source` });
      state.meaningfulTransformations++;
      // map/flatMap can emit one item per input (or more), so field mapping
      // is not a proof that the total result is context-bounded.
      return reducedFlow(mapped.kind === "aggregated" ? "aggregated" : "projected", `${method} projection`, Math.min(receiver.retention, mapped.retention, 0.5), false, mapped.provenance);
    }
    case "filter":
      state.meaningfulTransformations++;
      return reducedFlow("selected", "filter collection", Math.min(receiver.retention, 0.5), false, receiver.provenance);
    case "find":
    case "findLast":
      state.meaningfulTransformations++;
      return boundedFlow("selected", `select ${method} item`, Math.min(receiver.retention, 0.15), receiver.provenance);
    case "reduce":
    case "reduceRight":
      state.meaningfulTransformations++;
      return reducedFlow("aggregated", `${method} aggregation`, Math.min(receiver.retention, 0.15), false, receiver.provenance);
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
        ? boundedFlow("selected", `${method} bounded selection`, Math.min(receiver.retention, Math.max(0.02, limit / 1000)), receiver.provenance)
        : reducedFlow("selected", `${method} unbounded selection`, receiver.retention, false, receiver.provenance);
    }
    case "match":
    case "matchAll":
      state.meaningfulTransformations++;
      return reducedFlow("selected", `${method} selection`, Math.min(receiver.retention, 0.25), false, receiver.provenance);
    case "includes":
    case "startsWith":
    case "endsWith":
    case "indexOf":
    case "lastIndexOf":
    case "some":
    case "every":
    case "has":
      state.meaningfulTransformations++;
      return boundedFlow("projected", `${method} scalar predicate`, 0.01, [
        ...receiver.provenance,
        effectStep(method, "scalar", unknownBound(), nodeLocation(sf, call)),
      ]);
    case "join":
      if (UNSAFE_KINDS.has(receiver.kind)) {
        return withUnknownBound({ ...receiver, operation: "join preserves source" });
      }
      state.meaningfulTransformations++;
      return reducedFlow("selected", "join projected values", receiver.retention, receiver.bounded, receiver.provenance);
    case "split":
      // Splitting alone does not reduce data; `.length`, `.filter`, etc. do.
      // Preserve the receiver's taint instead of escalating it.
      return withUnknownBound({ ...receiver, operation: "split without reduction" });
    case "trim":
    case "replace":
    case "replaceAll":
    case "normalize":
    case "toString":
      // Normalization does not prove any context bound. Preserve the receiver's
      // taint and let the final bound check reject raw-preserving transforms.
      state.meaningfulTransformations++;
      return withUnknownBound({ ...receiver, operation: `${method} preserves source` });
    case "then": {
      const callbacks = call.arguments.filter((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
      if (callbacks.length === 0) return { ...receiver, operation: "then preserves source" };
      const results = callbacks.map((fn) => evaluateCallback(fn as TS.Expression, receiver, env, state, sf));
      if (results.length === 1) return results[0];
      return combine(results, "then preserves source", true);
    }
    case "catch": {
      const callbacks = call.arguments.filter((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
      if (callbacks.length === 0) return { ...receiver, operation: "catch preserves source" };
      const handled = callbacks.map((fn) => evaluateCallback(fn as TS.Expression, receiver, env, state, sf));
      return combine([receiver, ...handled], "catch preserves source", true);
    }
    case "finally":
      return { ...receiver, operation: "finally preserves source" };
    case "sort":
    case "reverse":
      return withUnknownBound({ ...receiver, operation: `${method} reorders source` });
    default:
      return withUnknownBound({ ...receiver, kind: "unknown", operation: `unknown method ${method}` });
  }
}

function evaluateCall(call: TS.CallExpression, env: Map<string, Flow>, state: EvalState, sf: TS.SourceFile): Flow {
  const name = getCalleeText(call.expression, sf);
  const effect = contextEffectFor(name);
  if (isContextHelperText(name)) {
    const args = callArgs(call, env, state, sf);
    const source = args.some((flow) => flow.hasSource);
    const resolvedBound = resolveEffectBound(call, effect, sf, state.constantResolver);
    const bound = resolvedBound.bound;
    const outputBound = effect.kind === "offload" ? unknownBound() : bound;
    const provenance = [...mergeProvenance(args), effectStep(name, effect.kind, outputBound, nodeLocation(sf, call), resolvedBound.reason)];
    if (effect.kind === "compress") {
      state.meaningfulTransformations++;
      const boundName = effect.bound?.name;
      const maxTokens = boundName ? objectNumberArgument(call, boundName, sf, env) : undefined;
      return boundedFlow("compressed", "context summary", maxTokens ? Math.min(0.08, maxTokens / 10000) : 0.08, provenance, outputBound);
    }
    if (effect.kind === "offload") {
      state.meaningfulTransformations++;
      return boundedFlow("offloaded", "context offload", 0, provenance, outputBound);
    }
    if (effect.kind === "select") {
      state.meaningfulTransformations++;
      return boundedFlow("selected", "context selection", 0.25, provenance, outputBound);
    }
    if (effect.kind === "scalar") {
      return source
        ? boundedFlow("projected", "context scalar", 0.01, provenance)
        : cleanFlow("context scalar", undefined, provenance);
    }
    return source
      ? reducedFlow("selected", "context helper", 0.25, false, provenance)
      : cleanFlow("context helper", undefined, provenance);
  }

  if (isFoveaCall(call, sf)) {
    const boundName = effect.kind === "select" ? effect.bound?.name : undefined;
    const maxTokens = boundName ? objectNumberArgument(call, boundName, sf, env) : undefined;
    const resolvedBound = resolveEffectBound(call, effect, sf, state.constantResolver);
    const bound = resolvedBound.bound ?? unknownBound("tokens");
    const provenance = [effectStep(name, effect.kind, bound, nodeLocation(sf, call), resolvedBound.reason)];
    if (maxTokens !== undefined) {
      state.boundedSelectionCalls++;
      state.meaningfulTransformations++;
      return boundedFlow("selected", "Fovea budgeted selection", Math.min(0.25, maxTokens / 10000), provenance, bound);
    }
    return sourceFlow("unknown", "unbounded Fovea selection", 1, provenance, bound);
  }

  if (effect.kind === "source" || isDataToolCall(call, sf)) {
    return sourceFlow("raw", `data source ${name}`, 1, [effectStep(name, "source", undefined, nodeLocation(sf, call))]);
  }

  const args = callArgs(call, env, state, sf);
  const sourced = args.some((flow) => flow.hasSource);
  const sourceProvenance = mergeProvenance(args);
  const simpleName = name.replace(/^.*\./, "");

  if (["String", "JSON.stringify", "encodeURIComponent", "btoa", "Buffer.from"].includes(name) || ["Stringify", "toString"].includes(simpleName)) {
    const flow = args.find((item) => item.hasSource);
    return flow ? withUnknownBound({ ...flow, kind: "encoded", meaningful: false, operation: `${name} preserves source` }) : cleanFlow(name);
  }
  if (name === "JSON.parse") {
    const flow = args.find((item) => item.hasSource);
    return flow ? withUnknownBound({ ...flow, kind: "unknown", meaningful: false, operation: "JSON.parse preserves source" }) : cleanFlow(name);
  }
  if (name === "Object.fromEntries") {
    return sourced ? reducedFlow("projected", "Object.fromEntries projection", 0.25, false, sourceProvenance) : cleanFlow(name);
  }
  if (name === "Array.from" || name === "Array.of") {
    return sourced ? reducedFlow("projected", `${name} projection`, 0.5, false, sourceProvenance) : cleanFlow(name);
  }
  if (["Object.keys", "Object.entries"].includes(name)) {
    return sourced ? reducedFlow("projected", `${name} dynamically sized projection`, 0.25, false, sourceProvenance) : cleanFlow(name);
  }
  if (name === "Object.values") {
    return sourced ? reducedFlow("selected", "Object.values dynamically sized selection", 0.5, false, sourceProvenance) : cleanFlow(name);
  }
  if (["Math.abs", "Math.ceil", "Math.floor", "Math.round", "Number", "Boolean", "parseInt", "parseFloat"].includes(name)) {
    return sourced
      ? boundedFlow("projected", `${name} scalar projection`, 0.01, [
          ...sourceProvenance,
          effectStep(name, "scalar", unknownBound(), nodeLocation(sf, call)),
        ])
      : cleanFlow(name);
  }
  if (/^Promise\.(?:resolve|reject)$/.test(name)) {
    return combine(args, `${name} preserves source`, true);
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
  return sourced ? sourceFlow("unknown", `unknown function ${name}`, 1, sourceProvenance) : cleanFlow(`call ${name}`);
}

function evaluateExpression(expr: TS.Expression, env: Map<string, Flow>, state: EvalState, sf: TS.SourceFile): Flow {
  const value = unwrap(expr);

  if (ts.isAwaitExpression(value)) return evaluateExpression(value.expression, env, state, sf);
  if (ts.isIdentifier(value)) return env.get(value.text) ?? cleanFlow(`identifier ${value.text}`);
  if (ts.isNumericLiteral(value)) return cleanFlow("literal", Number(value.text));
  if (ts.isPostfixUnaryExpression(value)) {
    if (value.operator === ts.SyntaxKind.PlusPlusToken || value.operator === ts.SyntaxKind.MinusMinusToken) {
      const operand = unwrap(value.operand as TS.Expression);
      if (ts.isIdentifier(operand)) return env.get(operand.text) ?? cleanFlow(`identifier ${operand.text}`);
      return evaluateExpression(value.operand as TS.Expression, env, state, sf);
    }
  }
  if (ts.isPrefixUnaryExpression(value)) {
    if (value.operator === ts.SyntaxKind.PlusPlusToken || value.operator === ts.SyntaxKind.MinusMinusToken) {
      const operand = unwrap(value.operand as TS.Expression);
      if (ts.isIdentifier(operand)) return env.get(operand.text) ?? cleanFlow(`identifier ${operand.text}`);
      return evaluateExpression(value.operand as TS.Expression, env, state, sf);
    }
    if (ts.isNumericLiteral(value.operand)) {
    const number = Number(value.operand.text);
    if (value.operator === ts.SyntaxKind.MinusToken) return cleanFlow("literal", -number);
    if (value.operator === ts.SyntaxKind.PlusToken) return cleanFlow("literal", number);
    }
  }
  if (ts.isStringLiteral(value) || ts.isBigIntLiteral(value) || ts.isRegularExpressionLiteral(value)) return cleanFlow("literal");
  if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword || value.kind === ts.SyntaxKind.NullKeyword) return cleanFlow("literal");

  if (ts.isTemplateExpression(value)) {
    const expressions = value.templateSpans.map((span) => evaluateExpression(span.expression, env, state, sf));
    const flow = combine(expressions, "template interpolation");
    // Interpolation is bounded composition, not data amplification: keep the
    // worst source kind but do not escalate to "encoded".
    return flow.hasSource ? withUnknownBound({ ...flow, operation: "template interpolation" }) : cleanFlow("template");
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
    return flow.hasSource ? withUnknownBound({ ...flow, operation: `${operation} combines source` }) : flow;
  }
  if (ts.isParenthesizedExpression(value)) return evaluateExpression(value.expression, env, state, sf);

  return cleanFlow("unclassified expression");
}

function bindPattern(pattern: TS.BindingName, value: Flow, env: Map<string, Flow>, state: EvalState, sf: TS.SourceFile): void {
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

function collectFunctions(node: TS.Node, functions: Map<string, FunctionLike>): void {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, { node });
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    functions.set(node.name.text, { node: node.initializer });
  }
  ts.forEachChild(node, (child) => collectFunctions(child, functions));
}

function rootIdentifierForWrite(target: TS.Expression): string | undefined {
  let current: TS.Expression = unwrap(target);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrap(current.expression);
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

function isCompoundAssignmentKind(kind: TS.SyntaxKind): boolean {
  switch (kind) {
    case ts.SyntaxKind.PlusEqualsToken:
    case ts.SyntaxKind.MinusEqualsToken:
    case ts.SyntaxKind.AsteriskEqualsToken:
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
    case ts.SyntaxKind.SlashEqualsToken:
    case ts.SyntaxKind.PercentEqualsToken:
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.AmpersandEqualsToken:
    case ts.SyntaxKind.BarEqualsToken:
    case ts.SyntaxKind.CaretEqualsToken:
    case ts.SyntaxKind.BarBarEqualsToken:
    case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
    case ts.SyntaxKind.QuestionQuestionEqualsToken:
      return true;
    default:
      return false;
  }
}

function taintBaseForContainerWrite(
  baseName: string,
  rhs: Flow,
  env: Map<string, Flow>,
  operation: string,
): void {
  if (!rhs.hasSource) return;
  const old = env.get(baseName);
  const provenance = [...(old?.hasSource ? old.provenance : []), ...rhs.provenance];
  if (!rhs.bounded) {
    env.set(baseName, sourceFlow("unknown", operation, 1, provenance));
    return;
  }
  if (old?.hasSource) {
    const combined = combine([old, rhs], operation, true);
    env.set(baseName, { ...combined, operation });
    return;
  }
  env.set(baseName, { ...rhs, operation, provenance });
}

function applyBinaryBinding(node: TS.BinaryExpression, env: Map<string, Flow>, state: EvalState, sf: TS.SourceFile): void {
  const kind = node.operatorToken.kind;
  const isPlain = kind === ts.SyntaxKind.EqualsToken;
  const isCompound = isCompoundAssignmentKind(kind);
  if (!isPlain && !isCompound) return;
  const opText = ts.tokenToString(kind) ?? (isPlain ? "=" : "compound assignment");
  if (ts.isIdentifier(node.left)) {
    const rhs = evaluateExpression(node.right, env, state, sf);
    if (isPlain) {
      env.set(node.left.text, rhs);
      return;
    }
    const old = env.get(node.left.text) ?? cleanFlow(`identifier ${node.left.text}`);
    const combined = combine([old, rhs], `${opText} combines source`, true);
    env.set(node.left.text, combined);
    return;
  }
  const baseName = rootIdentifierForWrite(node.left);
  if (baseName === undefined) return;
  const rhs = evaluateExpression(node.right, env, state, sf);
  const operation = isPlain
    ? "property assignment preserves source"
    : `${opText} property assignment preserves source`;
  taintBaseForContainerWrite(baseName, rhs, env, operation);
}

function applyUpdateBinding(node: TS.PrefixUnaryExpression | TS.PostfixUnaryExpression, env: Map<string, Flow>): void {
  const op = node.operator;
  if (op !== ts.SyntaxKind.PlusPlusToken && op !== ts.SyntaxKind.MinusMinusToken) return;
  const operand = unwrap(node.operand as TS.Expression);
  if (ts.isIdentifier(operand)) {
    const old = env.get(operand.text) ?? cleanFlow(`identifier ${operand.text}`);
    const combined = combine([old, cleanFlow("increment")], "increment preserves source", true);
    env.set(operand.text, combined);
    return;
  }
  // Property/element increments preserve an already-tainted container; a
  // clean container holding only a counter stays clean, so no env change.
}

function visitBindings(node: TS.Node, env: Map<string, Flow>, state: EvalState, sf: TS.SourceFile): void {
  if (isFunctionLikeNode(node)) return;
  if (ts.isVariableDeclaration(node) && node.initializer) {
    bindPattern(node.name, evaluateExpression(node.initializer, env, state, sf), env, state, sf);
  }
  if (ts.isBinaryExpression(node)) {
    applyBinaryBinding(node, env, state, sf);
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    applyUpdateBinding(node, env);
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
  if (ts.isForStatement(node)) {
    if (node.initializer) visitBindings(node.initializer, env, state, sf);
    // Loop-carried reassignment (for(;;) bodies run repeatedly) is modeled by
    // visiting the body and incrementor, then the body once more so `x +=`
    // inside the loop combines the pre-loop value with the in-loop update.
    if (node.statement) visitBindings(node.statement, env, state, sf);
    if (node.incrementor) visitBindings(node.incrementor, env, state, sf);
    if (node.statement) visitBindings(node.statement, env, state, sf);
    // Condition may contain assignments as expressions; visit for completeness.
    if (node.condition) visitBindings(node.condition, env, state, sf);
    return;
  }
  if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    // `while`/`do` bodies may execute zero or many times; a second visit
    // propagates loop-carried `x =`/`x +=`/property writes to the return env.
    visitBindings(node.statement, env, state, sf);
    visitBindings(node.statement, env, state, sf);
    if (ts.isWhileStatement(node)) visitBindings(node.expression, env, state, sf);
    else if (node.expression) visitBindings(node.expression, env, state, sf);
    return;
  }
  ts.forEachChild(node, (child) => visitBindings(child, env, state, sf));
}

function visitFunctionStatements(
  node: TS.Node,
  env: Map<string, Flow>,
  state: EvalState,
  sf: TS.SourceFile,
  returns: Flow[],
): void {
  if (isFunctionLikeNode(node) && !ts.isBlock(node)) return;
  if (ts.isVariableDeclaration(node) && node.initializer) {
    bindPattern(node.name, evaluateExpression(node.initializer, env, state, sf), env, state, sf);
  }
  if (ts.isBinaryExpression(node)) {
    applyBinaryBinding(node, env, state, sf);
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    applyUpdateBinding(node, env);
  }
  if (ts.isReturnStatement(node) && node.expression) returns.push(evaluateExpression(node.expression, env, state, sf));
  ts.forEachChild(node, (child) => visitFunctionStatements(child, env, state, sf, returns));
}

function evaluateFunction(
  fn: FunctionLike["node"],
  args: Flow[],
  parentEnv: Map<string, Flow>,
  state: EvalState,
  sf: TS.SourceFile,
): Flow {
  const env = new Map(parentEnv);
  fn.parameters.forEach((parameter, index) => {
    bindPattern(parameter.name, args[index] ?? cleanFlow("missing argument"), env, state, sf);
  });
  if (!ts.isBlock(fn.body)) return evaluateExpression(fn.body, env, state, sf);
  const returns: Flow[] = [];
  visitFunctionStatements(fn.body, env, state, sf, returns);
  return returns.length > 0 ? combine(returns, "function return", true) : cleanFlow("function");
}

function collectProgramMetrics(sf: TS.SourceFile, metrics: ProgramMetrics): void {
  const visit = (node: TS.Node): void => {
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

function topLevelReturns(sf: TS.SourceFile, env: Map<string, Flow>, state: EvalState): Flow[] {
  const returns: Flow[] = [];
  const visit = (node: TS.Node): void => {
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
    returnProvenance: [],
    quantitativePolicyApplied: false,
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
    constantResolver: new NumericConstantResolver(sf),
  };
  collectFunctions(sf, state.functions);
  const env = new Map<string, Flow>();
  visitBindings(sf, env, state, sf);
  const returns = topLevelReturns(sf, env, state);
  const returned = returns.length > 0 ? combine(returns, "program return", true) : cleanFlow("no return");

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
  metrics.returnBound = returned.bound;
  metrics.returnProvenance = returned.provenance;
  const quantitativePolicy: ContextBoundaryPolicy | undefined = opts.maxReturnTokens !== undefined && opts.quantitativePolicy?.maxTokens === undefined
    ? { ...opts.quantitativePolicy, maxTokens: opts.maxReturnTokens }
    : opts.quantitativePolicy;
  const quantitativeDecision = evaluateReturnBudget(metrics.returnBound, quantitativePolicy);
  metrics.quantitativeDecision = quantitativeDecision;

  for (const node of returns) {
    // This is deliberately only a source-size estimate for static returns;
    // runtime tool payloads are measured by the result hook.
    if (node.operation === "literal" || node.operation === "object projection" || node.operation === "array aggregate" || node.operation === "template interpolation") {
      metrics.estimatedReturnTokens = Math.max(metrics.estimatedReturnTokens ?? 0, estimateTokens(node.operation === "literal" ? sourceText : node.operation));
    }
  }
  // Use the source text of literal return expressions when available.
  const literalReturns: string[] = [];
  const collectLiteralReturns = (node: TS.Node): void => {
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
  let legacyUnboundedReason: string | undefined;
  if (returned.hasSource && !returned.bounded) {
    hardBlock = true;
    legacyUnboundedReason =
      `Return carries ${metrics.returnTaint} tool data (${metrics.returnOperation}) without a provable context bound after ${metrics.sourceCalls} source call(s). ` +
      "A transformation such as map, filter, reduce, trim, or replace may still retain the full source. " +
      "Use scalar projections, find/some/every, slice(0, N), extensions.ctx_summarize({ text, mode: \"structural\", maxTokens }), " +
      "extensions.ctx_offload({ key, source, data }), or delegate the work.";
    reasons.push(legacyUnboundedReason);
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

  if (legacyUnboundedReason && quantitativeDecision.kind === "over-budget") {
    const value = quantitativeDecision.bound.kind === "unknown" ? "unknown" : quantitativeDecision.bound.value;
    reasons.push(`Quantitative policy rejects the proven maximum of ${value} ${quantitativeDecision.unit} because it exceeds the configured budget of ${quantitativeDecision.limit} ${quantitativeDecision.unit}.`);
  } else if (legacyUnboundedReason && quantitativeDecision.kind === "not-comparable") {
    reasons.push(`Quantitative policy cannot allow this return: ${quantitativeDecision.reason}`);
  }

  if (legacyUnboundedReason && quantitativeDecision.kind === "within-budget") {
    const index = reasons.indexOf(legacyUnboundedReason);
    if (index >= 0) reasons.splice(index, 1);
    metrics.quantitativePolicyApplied = true;
  }

  metrics.sourceCalls = metrics.toolCalls;
  hardBlock = reasons.length > 0;
  const ok = reasons.length === 0;
  return { ok, hardBlock, reasons, metrics };
}
