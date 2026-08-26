import type { BoundUnit, ResolvedBound } from "./context-effects.js";

export interface ContextBoundaryPolicy {
  readonly maxBytes?: number;
  readonly maxTokens?: number;
  readonly maxCharacters?: number;
}

export type QuantitativeDecision =
  | {
      readonly kind: "within-budget";
      readonly bound: ResolvedBound;
      readonly limit: number;
      readonly unit: BoundUnit;
    }
  | {
      readonly kind: "over-budget";
      readonly bound: ResolvedBound;
      readonly limit: number;
      readonly unit: BoundUnit;
    }
  | {
      readonly kind: "not-comparable";
      readonly reason: string;
    };

/** Defaults mirror the existing CE result and return-token ceilings. */
export const DEFAULT_CONTEXT_BOUNDARY_POLICY: Required<ContextBoundaryPolicy> = Object.freeze({
  maxBytes: 8192,
  maxTokens: 4000,
  maxCharacters: 8192,
});

const comparableLimits: Readonly<Record<"bytes" | "tokens" | "characters", keyof ContextBoundaryPolicy>> = {
  bytes: "maxBytes",
  tokens: "maxTokens",
  characters: "maxCharacters",
};

function validLimit(limit: number | undefined): limit is number {
  return limit !== undefined && Number.isFinite(limit) && limit >= 0;
}

export function evaluateReturnBudget(
  bound: ResolvedBound | undefined,
  policy: ContextBoundaryPolicy = DEFAULT_CONTEXT_BOUNDARY_POLICY,
): QuantitativeDecision {
  if (!bound || bound.kind === "unknown" || bound.value === undefined) {
    return { kind: "not-comparable", reason: "No finite quantitative bound is available." };
  }
  const policyKey = comparableLimits[bound.unit as keyof typeof comparableLimits];
  if (!policyKey) {
    return {
      kind: "not-comparable",
      reason: `A ${bound.unit} bound is structural only and cannot prove context size.`,
    };
  }
  const limit = policy[policyKey];
  if (!validLimit(limit)) {
    return { kind: "not-comparable", reason: `No quantitative budget is configured for ${bound.unit}.` };
  }
  if (!Number.isFinite(bound.value) || bound.value < 0) {
    return { kind: "not-comparable", reason: `The ${bound.unit} bound is not a valid non-negative finite value.` };
  }
  return bound.value <= limit
    ? { kind: "within-budget", bound, limit, unit: bound.unit }
    : { kind: "over-budget", bound, limit, unit: bound.unit };
}
