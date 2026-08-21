/**
 * pi-context-engineer — enforcement wrapper for fabric_exec.
 *
 * This is the "force" half of the plugin. It intercepts fabric_exec programs
 * before execution and runs the static analyzer. Programs that are wasteful
 * passthroughs are BLOCKED — the program does not execute, and the model
 * receives an error explaining what to fix.
 *
 * Enforcement tiers:
 *   BLOCK   — clear passthroughs (raw tool result returned, no processing)
 *   WARN    — borderline cases (large returns, many unprocessed calls)
 *             Program executes but a warning is prepended to the result.
 *   PASS    — clean programs with real data processing
 *
 * Current Fabric exposes registered CE tools through `extensions.*`; the
 * analyzer treats those helpers as processing rather than raw data calls.
 */

import { analyzeProgram, type AnalysisResult } from "./analyzer.js";
import type { ToolContext } from "./tools.js";

export interface WrapperOptions {
  /** When true, borderline cases are blocked instead of warned. Default: false. */
  strict?: boolean;
  /** Max tool calls before requiring processing. Default: 3. */
  maxUnprocessedToolCalls?: number;
  /** Max estimated return tokens before warning. Default: 4000. */
  maxReturnTokens?: number;
}

export interface ExecResult {
  ok: boolean;
  blocked: boolean;
  analysis: AnalysisResult;
  /** The result from the real fabric_exec, if not blocked. */
  result?: unknown;
  /** Warning text prepended to results in WARN tier. */
  warning?: string;
  /** Error message for the model when blocked. */
  error?: string;
}

/**
 * Analyze a fabric_exec program and decide: block, warn, or pass.
 * Returns the decision + analysis metrics.
 */
export function evaluateProgram(
  program: string,
  opts: WrapperOptions = {}
): { tier: "BLOCK" | "WARN" | "PASS"; analysis: AnalysisResult; guidance: string } {
  const analysis = analyzeProgram(program, {
    maxUnprocessedToolCalls: opts.maxUnprocessedToolCalls,
    maxReturnTokens: opts.maxReturnTokens,
  });
  const strict = opts.strict ?? false;
  const maxReturn = opts.maxReturnTokens ?? 4000;

  // BLOCK tier: clear passthroughs
  if (!analysis.ok && analysis.reasons.length > 0) {
    // Distinguish hard blocks from soft warnings
    const hardBlockReasons = analysis.reasons.filter((r) =>
      r.includes("raw or near-raw tool result") || r.includes("no branching or processing")
    );
    const softReasons = analysis.reasons.filter((r) =>
      !r.includes("raw or near-raw tool result") && !r.includes("no branching or processing")
    );

    if (hardBlockReasons.length > 0) {
      return {
        tier: "BLOCK",
        analysis,
        guidance: formatBlockGuidance(hardBlockReasons, analysis.metrics, program),
      };
    }

    // Soft reasons (e.g. large return) → warn unless strict
    if (strict) {
      return {
        tier: "BLOCK",
        analysis,
        guidance: formatBlockGuidance(analysis.reasons, analysis.metrics, program),
      };
    }

    return {
      tier: "WARN",
      analysis,
      guidance: formatWarning(softReasons, analysis.metrics),
    };
  }

  // Check return token estimate even if ok
  if (analysis.metrics.estimatedReturnTokens !== null && analysis.metrics.estimatedReturnTokens > maxReturn) {
    if (strict) {
      return {
        tier: "BLOCK",
        analysis,
        guidance: formatBlockGuidance(
          [`Return is estimated at ~${analysis.metrics.estimatedReturnTokens} tokens (> ${maxReturn}).`],
          analysis.metrics,
          program
        ),
      };
    }
    return {
      tier: "WARN",
      analysis,
      guidance: formatWarning(
        [`Return is ~${analysis.metrics.estimatedReturnTokens} tokens (>${maxReturn}). Consider ctx_summarize.`],
        analysis.metrics
      ),
    };
  }

  return {
    tier: "PASS",
    analysis,
    guidance: "",
  };
}

/**
 * The wrapped executor. Call this instead of the raw fabric_exec.
 * It analyzes, decides, and either blocks or delegates to the real executor.
 */
export async function wrappedExec(
  program: string,
  realExec: (program: string) => Promise<unknown>,
  opts: WrapperOptions = {}
): Promise<ExecResult> {
  const decision = evaluateProgram(program, opts);

  if (decision.tier === "BLOCK") {
    return {
      ok: false,
      blocked: true,
      analysis: decision.analysis,
      error: decision.guidance,
    };
  }

  const result = await realExec(program);

  if (decision.tier === "WARN") {
    return {
      ok: true,
      blocked: false,
      analysis: decision.analysis,
      result,
      warning: decision.guidance,
    };
  }

  return {
    ok: true,
    blocked: false,
    analysis: decision.analysis,
    result,
  };
}

// ---- Guidance formatters ----

function formatBlockGuidance(reasons: string[], metrics: AnalysisResult["metrics"], _program: string): string {
  const lines = [
    "⛔ fabric_exec program BLOCKED by context-engineer.",
    "",
    "Reason(s):",
    ...reasons.map((r) => `  • ${r}`),
    "",
    "Program metrics:",
    `  • tool calls: ${metrics.toolCalls}`,
    `  • return is raw tool result: ${metrics.returnIsRawToolResult}`,
    `  • has processing (map/filter/reduce/etc.): ${metrics.hasProcessingBetweenToolAndReturn}`,
    `  • has branching/loops: ${metrics.hasLoopOrConditional}`,
    `  • estimated return tokens: ${metrics.estimatedReturnTokens ?? "unknown"}`,
    "",
    "How to fix — choose one:",
    "  1. PROJECT: extract only the fields you need before returning.",
    "     const r = await pi.read({ path }); return { lines: r.split('\n').length, path };",
    "  2. SUMMARIZE: call extensions.ctx_summarize() on the result before returning.",
    "     const r = await pi.grep({ pattern }); return extensions.ctx_summarize({ text: r });",
    "  3. OFFLOAD: store large data and return a handle + preview.",
    "     const r = await pi.read({ path }); return extensions.ctx_offload({ key: 'file-read', source: 'read', data: r });",
    "  4. DELEGATE: if this is a separable subtask, use ctx_delegate instead.",
    "",
    "See the context-engineer skill for full patterns.",
  ];
  return lines.join("\n");
}

function formatWarning(reasons: string[], metrics: AnalysisResult["metrics"]): string {
  return [
    "⚠️  context-engineer WARNING:",
    ...reasons.map((r) => `  • ${r}`),
    `  • tool calls: ${metrics.toolCalls}, est return tokens: ${metrics.estimatedReturnTokens ?? "?"}`,
    "  Consider processing the result more before returning.",
  ].join("\n");
}
