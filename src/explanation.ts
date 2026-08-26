import { analyzeProgram, type AnalysisResult, type AnalyzerOptions } from "./analyzer.js";
import type { ContextProvenanceStep, ResolvedBound } from "./context-effects.js";
import type { QuantitativeDecision } from "./quantitative-policy.js";

export interface ProgramExplanation {
  classification: "safe" | "unsafe";
  /** Policy boundedness, independent from whether an exact numeric bound is known. */
  bounded: boolean;
  returnBound?: ResolvedBound;
  provenance: ContextProvenanceStep[];
  quantitativeDecision?: QuantitativeDecision;
  summary: string;
}

function boundText(bound: ResolvedBound | undefined): string {
  if (!bound) return "bounded, exact maximum unknown";
  if (bound.kind === "exact" || bound.kind === "upper") return `≤ ${bound.value} ${bound.unit}`;
  return bound.unit ? `bounded, exact maximum unknown (${bound.unit})` : "bounded, exact maximum unknown";
}

function boundaryText(bounded: boolean, bound: ResolvedBound | undefined): string {
  const finite = bound?.kind === "exact" || bound?.kind === "upper";
  return bounded || finite ? boundText(bound) : "unbounded";
}

function policyLines(decision: QuantitativeDecision | undefined): string[] {
  if (!decision) return [];
  if (decision.kind === "not-comparable") return [
    "Policy",
    "  result: NOT COMPARABLE",
    `  reason: ${decision.reason}`,
  ];
  const provenMaximum = decision.bound.kind === "unknown" ? "unknown" : decision.bound.value;
  return [
    "Policy",
    `  ${decision.unit} budget: ${decision.limit}`,
    `  proven maximum: ${provenMaximum}`,
    `  result: ${decision.kind === "within-budget" ? "WITHIN BUDGET" : "OVER BUDGET"}`,
  ];
}

function stepText(step: ContextProvenanceStep): string {
  const effect = step.effect.toUpperCase();
  if (step.effect === "source") return `${effect} · unbounded · bound unknown`;
  if (step.effect === "scalar") return `${effect} · scalar projection · quantitative bound unknown`;
  if (step.bound?.kind === "exact" || step.bound?.kind === "upper") return `${effect} · ${boundText(step.bound)}`;
  if (step.bound?.kind === "unknown") return `${effect} · ${boundText(step.bound)}`;
  if (step.effect === "unknown") return `${effect} · effect unknown · bound unknown`;
  return `${effect} · bounded, exact bound unknown`;
}

export function formatProgramExplanation(explanation: ProgramExplanation): string {
  const lines = ["Context analysis", ""];
  explanation.provenance.forEach((step) => {
    lines.push(step.operation);
    lines.push(`  ${stepText(step)}`);
    lines.push("    ↓");
  });
  lines.push("return");
  lines.push(`  BOUNDARY · ${boundaryText(explanation.bounded, explanation.returnBound)}`);
  const policy = policyLines(explanation.quantitativeDecision);
  if (policy.length > 0) lines.push("", ...policy);
  return lines.join("\n");
}

export function explanationFromAnalysis(result: AnalysisResult): ProgramExplanation {
  const quantitativeDecision = result.metrics.quantitativeDecision;
  const bounded = result.metrics.provablyBounded || quantitativeDecision?.kind === "within-budget";
  const returnBound = result.metrics.returnBound;
  const classification = result.hardBlock ? "unsafe" : "safe";
  const summary = `${classification === "safe" ? "Safe" : "Unsafe"} return: ${boundaryText(bounded, returnBound)}.`;
  return {
    classification,
    bounded,
    returnBound,
    provenance: result.metrics.returnProvenance.map((step) => ({
      ...step,
      bound: step.bound === undefined ? undefined : { ...step.bound },
      location: step.location === undefined ? undefined : { ...step.location },
    })),
    quantitativeDecision,
    summary,
  };
}

export function explainProgram(source: string, options: AnalyzerOptions = {}): ProgramExplanation {
  return explanationFromAnalysis(analyzeProgram(source, options));
}
