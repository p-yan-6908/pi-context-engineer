/**
 * Context effects are the policy vocabulary shared by static analysis,
 * benchmarks, and future runtime adapters.
 *
 * The registry intentionally describes what a call does to context, not how a
 * particular analyzer propagates values. Unknown calls remain unknown so new
 * tools fail conservative rather than silently becoming a pass-through.
 */

export type ContextEffectKind =
  | "source"
  | "scalar"
  | "bounded"
  | "select"
  | "compress"
  | "offload"
  | "unknown";

export interface ContextEffect {
  kind: ContextEffectKind;
  /** Argument carrying an explicit output bound, when one exists. */
  boundFrom?: string;
}

const source = { kind: "source" } as const;
const scalar = { kind: "scalar" } as const;
const select = { kind: "select", boundFrom: "maxTokens" } as const;
const readSelect = { kind: "select", boundFrom: "length" } as const;
const compress = { kind: "compress", boundFrom: "maxTokens" } as const;
const offload = { kind: "offload" } as const;

/** Exact public tool effects. Keep this table easy to audit and extend. */
export const contextEffects: Readonly<Record<string, ContextEffect>> = Object.freeze({
  "extensions.ctx_read": readSelect,
  "ctx_read": readSelect,
  "ce_read": readSelect,
  "extensions.ctx_summarize": compress,
  "ctx_summarize": compress,
  "ce_summarize": compress,
  "extensions.ctx_offload": offload,
  "ctx_offload": offload,
  "ce_offload": offload,
  "extensions.ctx_delegate": compress,
  "ctx_delegate": compress,
  "ce_delegate": compress,
  "extensions.ctx_recall": select,
  "ctx_recall": select,
  "extensions.ctx_remember": scalar,
  "ctx_remember": scalar,
  "extensions.ctx_forget": scalar,
  "ctx_forget": scalar,
  "extensions.ctx_status": scalar,
  "ctx_status": scalar,
  "extensions.fovea_sketch": select,
  "extensions.fovea_focus": select,
  "extensions.fovea_dwell": select,
  "extensions.fovea_impact": select,
  "fovea_sketch": select,
  "fovea_focus": select,
  "fovea_dwell": select,
  "fovea_impact": select,
});

const SOURCE_NAMESPACE = /^(?:tools|pi|fabric|mcp|extensions)\./;
const DIRECT_SOURCE_TOOL = /^(?:read|write|edit|bash|grep|glob|list|ls|find|search|fetch|vision|subagent|delegate)(?:$|\.)/;
const CONTEXT_HELPER = /^(?:(?:extensions\.)?(?:ctx|ce)_[a-z0-9_]+|(?:ctx|ce)\.)/;
const FOVEA = /^(?:extensions\.)?fovea_(?:sketch|focus|dwell|impact)$/;

export function normalizeCalleeName(name: string): string {
  return name.replace(/\s+/g, "");
}

export function isContextHelperName(name: string): boolean {
  return CONTEXT_HELPER.test(normalizeCalleeName(name));
}

export function isFoveaName(name: string): boolean {
  return FOVEA.test(normalizeCalleeName(name));
}

/** Resolve exact registry entries first, then conservative legacy namespaces. */
export function contextEffectFor(name: string): ContextEffect {
  const normalized = normalizeCalleeName(name);
  const alias = normalized.startsWith("extensions.ctx.")
    ? `extensions.ctx_${normalized.slice("extensions.ctx.".length)}`
    : normalized.startsWith("extensions.ce.")
      ? `extensions.ce_${normalized.slice("extensions.ce.".length)}`
      : normalized.startsWith("ctx.")
        ? `ctx_${normalized.slice("ctx.".length)}`
        : normalized.startsWith("ce.")
          ? `ce_${normalized.slice("ce.".length)}`
          : normalized;
  const exact = contextEffects[normalized] ?? contextEffects[alias];
  if (exact) return exact;
  if (isContextHelperName(normalized) || isFoveaName(normalized)) return { kind: "unknown" };
  if (SOURCE_NAMESPACE.test(normalized) || DIRECT_SOURCE_TOOL.test(normalized)) return source;
  return { kind: "unknown" };
}

/** Small scalar effects are useful to callers that only need policy metadata. */
export function isBoundedContextEffect(effect: ContextEffect): boolean {
  return effect.kind === "scalar" || effect.kind === "bounded" || effect.kind === "select" || effect.kind === "compress" || effect.kind === "offload";
}
