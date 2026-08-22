/**
 * Enforcement policy for Fabric code-mode programs.
 *
 * The analyzer supplies data-flow severity. Any source-bearing value without a
 * provable context bound is a hard block; bounded results may still receive a
 * runtime advisory when their actual boundary payload is large.
 */

import { analyzeProgram, type AnalysisResult } from "./analyzer.js";

export interface WrapperOptions {
  /** When true, soft warnings are blocked instead of warned. Default: false. */
  strict?: boolean;
  /** Legacy compatibility setting; reduction/cost is now the primary policy. */
  maxUnprocessedToolCalls?: number;
  /** Max estimated return tokens before a static hard block. Default: 4000. */
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
    `  • transformations observed: ${metrics.transformationCount}`,
    `  • return is reduced: ${metrics.returnIsReduced}`,
    `  • return is provably bounded: ${metrics.provablyBounded}`,
    `  • bounded Fovea selections: ${metrics.boundedSelectionCalls}`,
    `  • return is unsafe/near-raw: ${metrics.returnIsRawToolResult}`,
    `  • estimated return tokens: ${metrics.estimatedReturnTokens ?? "unknown"}`,
    `  • estimated reduction: ${metrics.estimatedReductionRatio === null ? "unknown" : `${Math.round(metrics.estimatedReductionRatio * 100)}%`}`,
  ];
}

function formatBlockGuidance(reasons: string[], metrics: AnalysisResult["metrics"]): string {
  return [
    "fabric_exec BLOCKED by context-engineer — source-bearing return lacks a provable bound.",
    "",
    ...reasons.map((reason) => `  • ${reason}`),
    "",
    `  • transformations: ${metrics.transformationCount}, reduced: ${metrics.returnIsReduced}, bounded: ${metrics.provablyBounded}, est. retention upper bound: ${metrics.estimatedRetentionRatio === null ? "?" : Math.round(metrics.estimatedRetentionRatio * 100) + "%"}, est. return tokens: ${metrics.estimatedReturnTokens ?? "?"}`,
    "",
    "Fastest fixes:",
    "  • project scalars:  return { lines: r.split('\\n').length }",
    "  • compress inline:  return extensions.ctx_summarize({ text, mode: 'structural', maxTokens: 400 })",
    "  • offload + preview: return extensions.ctx_offload({ key: 'label', source: 'bash', data })",
  ].join("\n");
}

/** One-line post-execution nudge for oversized (but executed) returns. */
export function runtimeAdvisoryLine(bytes: number): string {
  return `[context-engineer] ${(bytes / 1024).toFixed(1)} KB reached the model boundary — consider scalar projections or extensions.ctx_summarize({ text, mode: "structural", maxTokens }).`;
}

function formatWarning(reasons: string[], metrics: AnalysisResult["metrics"]): string {
  return [
    "context-engineer WARNING:",
    ...reasons.map((reason) => `  • ${reason}`),
    ...metricLines(metrics),
    "  Consider reducing the returned context further.",
  ].join("\n");
}
