/**
 * Context effects are the policy vocabulary shared by static analysis,
 * benchmarks, and runtime adapters.
 *
 * v0.5 starts with a deliberately small registry. It describes what a call
 * does to context; propagation and quantitative accounting remain analyzer
 * concerns so this refactor does not change v0.4 behavior.
 */

export type BoundUnit = "bytes" | "tokens" | "elements" | "characters" | "records";

export interface BoundExpression {
  readonly kind: "argument";
  readonly name: string;
  readonly unit: BoundUnit;
}

export type ResolvedBound =
  | {
      readonly kind: "exact";
      readonly value: number;
      readonly unit: BoundUnit;
    }
  | {
      readonly kind: "upper";
      readonly value: number;
      readonly unit: BoundUnit;
    }
  | {
      readonly kind: "unknown";
      readonly unit?: BoundUnit;
    };

export type ContextEffect =
  | { readonly kind: "source" }
  | { readonly kind: "passthrough" }
  | { readonly kind: "scalar" }
  | { readonly kind: "select"; readonly bound?: BoundExpression }
  | { readonly kind: "compress"; readonly bound?: BoundExpression }
  | { readonly kind: "offload" }
  | { readonly kind: "unknown" };

export type ContextEffectKind = ContextEffect["kind"];

export interface ContextProvenanceLocation {
  readonly line: number;
  readonly column: number;
}

export interface ContextProvenanceStep {
  readonly operation: string;
  readonly effect: ContextEffectKind;
  readonly bound?: ResolvedBound;
  readonly reason?: string;
  readonly location?: ContextProvenanceLocation;
}

const argumentBound = (name: string, unit: BoundUnit): BoundExpression =>
  Object.freeze({ kind: "argument", name, unit });

const source: ContextEffect = Object.freeze({ kind: "source" });
const scalar: ContextEffect = Object.freeze({ kind: "scalar" });
const selectBytes: ContextEffect = Object.freeze({
  kind: "select",
  bound: argumentBound("length", "bytes"),
});
const selectTokens: ContextEffect = Object.freeze({
  kind: "select",
  bound: argumentBound("maxTokens", "tokens"),
});
const foveaSelect: ContextEffect = Object.freeze({
  kind: "select",
  bound: argumentBound("maxTokens", "tokens"),
});
const compressTokens: ContextEffect = Object.freeze({
  kind: "compress",
  bound: argumentBound("maxTokens", "tokens"),
});
const offload: ContextEffect = Object.freeze({ kind: "offload" });

/** Exact public tool effects. Keep this table easy to audit and extend. */
export const contextEffects: Readonly<Record<string, ContextEffect>> = Object.freeze({
  "extensions.ctx_read": selectBytes,
  "ctx_read": selectBytes,
  "ce_read": selectBytes,
  "extensions.ctx_summarize": compressTokens,
  "ctx_summarize": compressTokens,
  "ce_summarize": compressTokens,
  "extensions.ctx_offload": offload,
  "ctx_offload": offload,
  "ce_offload": offload,
  "extensions.ctx_delegate": compressTokens,
  "ctx_delegate": compressTokens,
  "ce_delegate": compressTokens,
  "extensions.ctx_recall": selectTokens,
  "ctx_recall": selectTokens,
  "extensions.ctx_remember": scalar,
  "ctx_remember": scalar,
  "extensions.ctx_forget": scalar,
  "ctx_forget": scalar,
  "extensions.ctx_status": scalar,
  "ctx_status": scalar,
  "extensions.fovea_sketch": foveaSelect,
  "extensions.fovea_focus": foveaSelect,
  "extensions.fovea_dwell": foveaSelect,
  "extensions.fovea_impact": foveaSelect,
  "fovea_sketch": foveaSelect,
  "fovea_focus": foveaSelect,
  "fovea_dwell": foveaSelect,
  "fovea_impact": foveaSelect,
});

// Retain conservative namespace detection for calls not yet represented in
// the registry. Exact entries above always win, so helper names stay unknown
// instead of being mistaken for raw sources.
const SOURCE_NAMESPACE = /^(?:tools|pi|fabric|mcp|extensions)\./;
const DIRECT_SOURCE_TOOL = /^(?:read|write|edit|bash|grep|glob|list|ls|find|search|fetch|vision|subagent|delegate)(?:$|\.)/;
const CONTEXT_HELPER = /^(?:(?:extensions\.)?(?:ctx|ce)_[a-z0-9_]+|(?:ctx|ce)\.)/;

export function normalizeCalleeName(name: string): string {
  return name.replace(/\s+/g, "");
}

function aliasName(normalized: string): string {
  if (normalized.startsWith("extensions.ctx.")) {
    return `extensions.ctx_${normalized.slice("extensions.ctx.".length)}`;
  }
  if (normalized.startsWith("extensions.ce.")) {
    return `extensions.ce_${normalized.slice("extensions.ce.".length)}`;
  }
  if (normalized.startsWith("ctx.")) {
    return `ctx_${normalized.slice("ctx.".length)}`;
  }
  if (normalized.startsWith("ce.")) {
    return `ce_${normalized.slice("ce.".length)}`;
  }
  return normalized;
}

function exactContextEffect(name: string): ContextEffect | undefined {
  const normalized = normalizeCalleeName(name);
  return contextEffects[normalized] ?? contextEffects[aliasName(normalized)];
}

export function isContextHelperName(name: string): boolean {
  return CONTEXT_HELPER.test(normalizeCalleeName(name));
}

/** Fovea's special unbounded behavior is identified by its registry entry. */
export function isFoveaName(name: string): boolean {
  return exactContextEffect(name) === foveaSelect;
}

/** Resolve exact registry entries first, then conservative legacy namespaces. */
export function contextEffectFor(name: string): ContextEffect {
  const normalized = normalizeCalleeName(name);
  const exact = exactContextEffect(normalized);
  if (exact) return exact;
  if (isContextHelperName(normalized)) return { kind: "unknown" };
  if (SOURCE_NAMESPACE.test(normalized) || DIRECT_SOURCE_TOOL.test(normalized)) return source;
  return { kind: "unknown" };
}

/** Small scalar effects are useful to callers that only need policy metadata. */
export function isBoundedContextEffect(effect: ContextEffect): boolean {
  return effect.kind === "scalar" || effect.kind === "select" || effect.kind === "compress" || effect.kind === "offload";
}
