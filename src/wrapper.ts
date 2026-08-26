/**
 * Enforcement policy for Fabric code-mode programs.
 *
 * The analyzer supplies data-flow severity. By default, uncertain source-bearing
 * returns execute under the runtime boundary guard; strict mode blocks them.
 * Certain static failures remain hard blocks, and optional size advisories can
 * annotate large-but-sub-threshold boundary payloads.
 */

import { analyzeProgram, type AnalysisResult } from "./analyzer.js";
import type { ContextBoundaryPolicy } from "./quantitative-policy.js";

export interface WrapperOptions {
  /** When true, uncertain source returns and soft warnings are blocked. Default: false. */
  strict?: boolean;
  /** Legacy compatibility setting; reduction/cost is now the primary policy. */
  maxUnprocessedToolCalls?: number;
  /** Max estimated return tokens before a static hard block. Default: 4000. */
  maxReturnTokens?: number;
  /**
   * Block statically unbounded source returns before execution. Default: false.
   * When false, the runtime boundary guard executes the task and offloads only
   * if the actual result is large. `strict: true` always enables blocking.
   */
  blockUnboundedReturns?: boolean;
  /** Optional quantitative budgets for additive v0.5 policy decisions. */
  quantitativePolicy?: ContextBoundaryPolicy;
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
    quantitativePolicy: opts.quantitativePolicy,
  });
  const strict = opts.strict ?? false;

  if (!analysis.ok) {
    // Unknown source sizes are better decided at the real model boundary: a
    // small result is harmless, while a large one is automatically offloaded.
    // Keep certain failures (empty/static oversize) blocked, and preserve the
    // old fail-closed policy behind either explicit switch.
    const runtimeGuardable =
      analysis.hardBlock &&
      !strict &&
      opts.blockUnboundedReturns !== true &&
      analysis.metrics.sourceCalls > 0 &&
      !analysis.metrics.provablyBounded &&
      analysis.metrics.quantitativeDecision?.kind !== "over-budget" &&
      (analysis.metrics.estimatedReturnTokens === null ||
        analysis.metrics.estimatedReturnTokens <= (opts.maxReturnTokens ?? 4000));

    if (!runtimeGuardable && (analysis.hardBlock || strict)) {
      return {
        tier: "BLOCK",
        analysis,
        guidance: formatBlockGuidance(analysis.reasons, analysis.metrics),
      };
    }
    return {
      tier: "WARN",
      analysis,
      guidance: runtimeGuardable
        ? formatRuntimeGuardWarning(analysis.metrics)
        : formatWarning(analysis.reasons, analysis.metrics),
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
  const quantitative = metrics.quantitativeDecision;
  const quantitativeLine = !quantitative
    ? "  • quantitative policy: unavailable"
    : quantitative.kind === "not-comparable"
      ? `  • quantitative policy: not comparable (${quantitative.reason})`
      : `  • quantitative policy: ${quantitative.kind} (${quantitative.bound.kind === "unknown" ? "unknown" : quantitative.bound.value} ${quantitative.unit} / ${quantitative.limit} ${quantitative.unit})`;
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
    quantitativeLine,
  ];
}

function formatBlockGuidance(reasons: string[], metrics: AnalysisResult["metrics"]): string {
  return [
    "fabric_exec BLOCKED by context-engineer — return does not satisfy the configured context policy.",
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

function formatRuntimeGuardWarning(metrics: AnalysisResult["metrics"]): string {
  return "[context-engineer] Unbounded " + metrics.returnTaint +
    " return executed in runtime-guard mode; the actual result will stay visible if small " +
    "or be offloaded if large. Set strict=true or blockUnboundedReturns=true to fail closed.";
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
