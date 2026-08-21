/**
 * Enforcement policy for Fabric code-mode programs.
 *
 * The analyzer supplies data-flow severity. Raw, encoded, or unknown tainted
 * values crossing the return boundary are hard blocks; oversized but otherwise
 * reduced returns are warnings unless strict mode is enabled.
 */

import { analyzeProgram, type AnalysisResult } from "./analyzer.js";

export interface WrapperOptions {
  /** When true, soft warnings are blocked instead of warned. Default: false. */
  strict?: boolean;
  /** Legacy compatibility setting; reduction/cost is now the primary policy. */
  maxUnprocessedToolCalls?: number;
  /** Max estimated return tokens before warning. Default: 4000. */
  maxReturnTokens?: number;
}

export interface ExecResult {
  ok: boolean;
  blocked: boolean;
  analysis: AnalysisResult;
  result?: unknown;
  warning?: string;
  error?: string;
}

export function evaluateProgram(
  program: string,
  opts: WrapperOptions = {},
): { tier: "BLOCK" | "WARN" | "PASS"; analysis: AnalysisResult; guidance: string } {
  const analysis = analyzeProgram(program, {
    maxUnprocessedToolCalls: opts.maxUnprocessedToolCalls,
    maxReturnTokens: opts.maxReturnTokens,
  });
  const strict = opts.strict ?? false;

  if (!analysis.ok) {
    if (analysis.hardBlock || strict) {
      return {
        tier: "BLOCK",
        analysis,
        guidance: formatBlockGuidance(analysis.reasons, analysis.metrics),
      };
    }
    return {
      tier: "WARN",
      analysis,
      guidance: formatWarning(analysis.reasons, analysis.metrics),
    };
  }

  return { tier: "PASS", analysis, guidance: "" };
}

/** Analyze, then delegate to the real executor unless the policy blocks. */
export async function wrappedExec(
  program: string,
  realExec: (program: string) => Promise<unknown>,
  opts: WrapperOptions = {},
): Promise<ExecResult> {
  const decision = evaluateProgram(program, opts);
  if (decision.tier === "BLOCK") {
    return { ok: false, blocked: true, analysis: decision.analysis, error: decision.guidance };
  }

  const result = await realExec(program);
  if (decision.tier === "WARN") {
    return { ok: true, blocked: false, analysis: decision.analysis, result, warning: decision.guidance };
  }
  return { ok: true, blocked: false, analysis: decision.analysis, result };
}

function metricLines(metrics: AnalysisResult["metrics"]): string[] {
  return [
    `  • source/tool calls: ${metrics.sourceCalls}`,
    `  • return data-flow: ${metrics.returnTaint} (${metrics.returnOperation})`,
    `  • meaningful transformations: ${metrics.meaningfulTransformations}`,
    `  • bounded Fovea selections: ${metrics.boundedSelectionCalls}`,
    `  • return is unsafe/near-raw: ${metrics.returnIsRawToolResult}`,
    `  • estimated return tokens: ${metrics.estimatedReturnTokens ?? "unknown"}`,
    `  • estimated reduction: ${metrics.estimatedReductionRatio === null ? "unknown" : `${Math.round(metrics.estimatedReductionRatio * 100)}%`}`,
  ];
}

function formatBlockGuidance(reasons: string[], metrics: AnalysisResult["metrics"]): string {
  return [
    "⛔ fabric_exec program BLOCKED by context-engineer.",
    "",
    "Reason(s):",
    ...reasons.map((reason) => `  • ${reason}`),
    "",
    "Program metrics:",
    ...metricLines(metrics),
    "",
    "How to fix — choose one:",
    "  1. PROJECT: extract only the fields you need before returning.",
    "     const r = await pi.read({ path }); return { lines: r.split('\\n').length, path };",
    "  2. SELECT/FILTER: use map, filter, find, slice, or a bounded Fovea call.",
    "  3. COMPRESS: call extensions.ctx_summarize() before returning.",
    "  4. OFFLOAD: call extensions.ctx_offload() and return a handle + preview.",
    "  5. ISOLATE: delegate a separable subtask with ctx_delegate or Fabric agents.",
    "",
    "See the context-engineer skill for full patterns.",
  ].join("\n");
}

function formatWarning(reasons: string[], metrics: AnalysisResult["metrics"]): string {
  return [
    "⚠️  context-engineer WARNING:",
    ...reasons.map((reason) => `  • ${reason}`),
    ...metricLines(metrics),
    "  Consider reducing the returned context further.",
  ].join("\n");
}
