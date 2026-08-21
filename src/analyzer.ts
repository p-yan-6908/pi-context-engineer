/**
 * pi-context-engineer — static analyzer for fabric_exec programs.
 *
 * Goal: detect "passthrough" programs that defeat Context Engineering.
 * A passthrough is a program whose return is a raw tool result (or near-raw),
 * with no data processing between the tool call and the return.
 *
 * Detection is conservative: we prefer false negatives (miss) over false
 * positives (block), so we only block patterns we are confident are wasteful.
 */

import ts from "typescript";

export interface AnalysisResult {
  ok: boolean;
  reasons: string[];
  metrics: ProgramMetrics;
}

export interface ProgramMetrics {
  toolCalls: number;
  returnIsRawToolResult: boolean;
  hasProcessingBetweenToolAndReturn: boolean;
  hasLoopOrConditional: boolean;
  hasVariableAssignment: boolean;
  estimatedReturnTokens: number | null;
  declaredVariables: number;
}

export interface AnalyzerOptions {
  /** Maximum number of unprocessed data-tool calls before blocking. */
  maxUnprocessedToolCalls?: number;
  /** Maximum estimated tokens for a literal return before warning/blocking. */
  maxReturnTokens?: number;
}

/**
 * The core enforcement. Returns ok=false when the program is a wasteful
 * passthrough that would dump raw data into context.
 */
export function analyzeProgram(source: string, opts: AnalyzerOptions = {}): AnalysisResult {
  const reasons: string[] = [];
  const metrics: ProgramMetrics = {
    toolCalls: 0,
    returnIsRawToolResult: false,
    hasProcessingBetweenToolAndReturn: false,
    hasLoopOrConditional: false,
    hasVariableAssignment: false,
    estimatedReturnTokens: null,
    declaredVariables: 0,
  };

  const maxCalls = opts.maxUnprocessedToolCalls ?? 3;
  const maxReturnTokens = opts.maxReturnTokens ?? 4000;

  const sourceText = source.trim();
  if (!sourceText) {
    return { ok: false, reasons: ["Empty program."], metrics };
  }

  const sf = ts.createSourceFile("program.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const checker = createLightweightChecker(sf);
  const toolResultVariables = new Set<string>();

  walk(sf, checker, metrics, toolResultVariables);

  let ok = true;

  if (metrics.toolCalls > 0 && metrics.returnIsRawToolResult) {
    ok = false;
    reasons.push(
      "Return statement is a raw or near-raw tool result with no processing. " +
        "This dumps the full payload into context, defeating context engineering. " +
        "Process the result (filter, project, summarize, extract) before returning."
    );
  }

  if (metrics.toolCalls > maxCalls && !metrics.hasLoopOrConditional && !metrics.hasProcessingBetweenToolAndReturn) {
    ok = false;
    reasons.push(
      `${metrics.toolCalls} tool calls with no branching or processing. ` +
        "If you need multiple calls, process and aggregate their results before returning."
    );
  }

  if (metrics.estimatedReturnTokens !== null && metrics.estimatedReturnTokens > maxReturnTokens) {
    ok = false;
    reasons.push(
      `Return is estimated at ~${metrics.estimatedReturnTokens} tokens (>${maxReturnTokens}). ` +
        "Use ctx_summarize or project to a smaller structure before returning."
    );
  }

  return { ok, reasons, metrics };
}

// --- Lightweight checker helpers ---

interface LightweightChecker {
  isToolCall(node: ts.CallExpression): boolean;
  isCeHelper(node: ts.CallExpression): boolean;
}

function createLightweightChecker(sf: ts.SourceFile): LightweightChecker {
  // Current Fabric full-code programs use pi.* and extensions.*. Older
  // programs used tools.*; retain those spellings for compatibility.
  const dataToolPattern = /^(tools|pi|fabric|mcp|extensions)\./;
  const directDataToolPattern = /^(read|write|edit|bash|grep|glob|list|search|fetch|vision|subagent|delegate)(?:$|\.)/;
  const ceHelperPattern = /^(ce|ctx)\.|^extensions\.(?:ctx_|ce_)|^(?:ctx_|ce_)/;

  const isCeHelperText = (text: string): boolean => ceHelperPattern.test(text);

  return {
    isToolCall(node) {
      const text = node.expression.getText(sf);
      if (isCeHelperText(text)) return false;
      return dataToolPattern.test(text) || directDataToolPattern.test(text);
    },
    isCeHelper(node) {
      return isCeHelperText(node.expression.getText(sf));
    },
  };
}

function isDirectToolCall(expr: ts.Expression, checker: LightweightChecker): boolean {
  return (
    (ts.isCallExpression(expr) && checker.isToolCall(expr)) ||
    (ts.isAwaitExpression(expr) && ts.isCallExpression(expr.expression) && checker.isToolCall(expr.expression))
  );
}

function walk(
  node: ts.Node,
  checker: LightweightChecker,
  metrics: ProgramMetrics,
  toolResultVariables: Set<string>
): void {
  const sf = node.getSourceFile();

  if (ts.isCallExpression(node) && checker.isToolCall(node)) {
    metrics.toolCalls++;
  }

  if (ts.isCallExpression(node) && checker.isCeHelper(node)) {
    metrics.hasProcessingBetweenToolAndReturn = true;
  }

  if (ts.isVariableStatement(node)) {
    metrics.hasVariableAssignment = true;
    metrics.declaredVariables += node.declarationList.declarations.length;

    for (const decl of node.declarationList.declarations) {
      if (decl.name && ts.isIdentifier(decl.name) && decl.initializer && isDirectToolCall(decl.initializer, checker)) {
        toolResultVariables.add(decl.name.text);
      }
      if (decl.initializer && ts.isCallExpression(decl.initializer)) {
        metrics.hasProcessingBetweenToolAndReturn = true;
      }
    }
  }

  if (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isIfStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isConditionalExpression(node)
  ) {
    metrics.hasLoopOrConditional = true;
  }

  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ["map", "filter", "reduce", "slice", "find", "flatMap", "sort", "keys", "values", "entries", "join", "includes", "some", "every"].includes(
      node.expression.name.getText(sf)
    )
  ) {
    metrics.hasProcessingBetweenToolAndReturn = true;
  }

  if (ts.isReturnStatement(node) && node.expression) {
    analyzeReturnExpression(node.expression, sf, checker, metrics, toolResultVariables);
  }

  ts.forEachChild(node, (child) => walk(child, checker, metrics, toolResultVariables));
}

function analyzeReturnExpression(
  expr: ts.Expression,
  sf: ts.SourceFile,
  checker: LightweightChecker,
  metrics: ProgramMetrics,
  toolResultVariables: Set<string>
): void {
  if (isDirectToolCall(expr, checker)) {
    metrics.returnIsRawToolResult = true;
    return;
  }

  if (ts.isIdentifier(expr)) {
    const text = expr.getText(sf);
    if (toolResultVariables.has(text) || (metrics.toolCalls > 0 && !metrics.hasProcessingBetweenToolAndReturn && !metrics.hasLoopOrConditional)) {
      metrics.returnIsRawToolResult = true;
    }
    return;
  }

  if (containsNearRawToolValue(expr, toolResultVariables)) {
    metrics.returnIsRawToolResult = true;
    return;
  }

  if (ts.isObjectLiteralExpression(expr) || ts.isArrayLiteralExpression(expr)) {
    metrics.estimatedReturnTokens = estimateTokens(expr.getText(sf));
    return;
  }

  if (ts.isTemplateExpression(expr)) {
    metrics.estimatedReturnTokens = estimateTokens(expr.getText(sf));
    return;
  }

  // A non-tool call in the return position is treated as processing.
  if (ts.isCallExpression(expr) && !checker.isToolCall(expr)) {
    metrics.hasProcessingBetweenToolAndReturn = true;
  }
}

/** Detect `{data: result}`, `{...result}`, `[result]`, or `result.content`. */
function containsNearRawToolValue(expr: ts.Expression, toolResultVariables: Set<string>): boolean {
  if (ts.isIdentifier(expr)) return toolResultVariables.has(expr.text);

  if (ts.isPropertyAccessExpression(expr)) {
    return ts.isIdentifier(expr.expression) && toolResultVariables.has(expr.expression.text) && expr.name.text === "content";
  }

  if (ts.isSpreadElement(expr)) return containsNearRawToolValue(expr.expression, toolResultVariables);

  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.some((element) => containsNearRawToolValue(element, toolResultVariables));
  }

  if (ts.isObjectLiteralExpression(expr)) {
    return expr.properties.some((property) => {
      if (ts.isSpreadAssignment(property)) return containsNearRawToolValue(property.expression, toolResultVariables);
      if (ts.isShorthandPropertyAssignment(property)) return toolResultVariables.has(property.name.text);
      return ts.isPropertyAssignment(property) && containsNearRawToolValue(property.initializer, toolResultVariables);
    });
  }

  return false;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
