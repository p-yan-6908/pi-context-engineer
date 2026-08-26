import { analyzeProgram } from "./analyzer.js";
import type { ResolvedBound } from "./context-effects.js";
import {
  DEFAULT_CONTEXT_BOUNDARY_POLICY,
  MAX_CONTEXT_BOUNDARY_BUDGET,
  evaluateReturnBudget,
  validateContextBoundaryPolicy,
} from "./quantitative-policy.js";

interface DirectCase {
  name: string;
  bound: ResolvedBound;
  expected: "within-budget" | "over-budget" | "not-comparable";
  limit?: number;
}

const directCases: readonly DirectCase[] = [
  { name: "bytes 8191", bound: { kind: "exact", value: 8191, unit: "bytes" }, expected: "within-budget", limit: 8192 },
  { name: "bytes 8192", bound: { kind: "exact", value: 8192, unit: "bytes" }, expected: "within-budget", limit: 8192 },
  { name: "bytes 8193", bound: { kind: "exact", value: 8193, unit: "bytes" }, expected: "over-budget", limit: 8192 },
  { name: "upper bytes 8192", bound: { kind: "upper", value: 8192, unit: "bytes" }, expected: "within-budget", limit: 8192 },
  { name: "upper bytes 8193", bound: { kind: "upper", value: 8193, unit: "bytes" }, expected: "over-budget", limit: 8192 },
  { name: "tokens 3999", bound: { kind: "exact", value: 3999, unit: "tokens" }, expected: "within-budget", limit: 4000 },
  { name: "tokens 4000", bound: { kind: "exact", value: 4000, unit: "tokens" }, expected: "within-budget", limit: 4000 },
  { name: "tokens 4001", bound: { kind: "exact", value: 4001, unit: "tokens" }, expected: "over-budget", limit: 4000 },
  { name: "upper tokens 4000", bound: { kind: "upper", value: 4000, unit: "tokens" }, expected: "within-budget", limit: 4000 },
  { name: "upper tokens 4001", bound: { kind: "upper", value: 4001, unit: "tokens" }, expected: "over-budget", limit: 4000 },
  { name: "characters 8191", bound: { kind: "exact", value: 8191, unit: "characters" }, expected: "within-budget", limit: 8192 },
  { name: "characters 8192", bound: { kind: "exact", value: 8192, unit: "characters" }, expected: "within-budget", limit: 8192 },
  { name: "characters 8193", bound: { kind: "exact", value: 8193, unit: "characters" }, expected: "over-budget", limit: 8192 },
  { name: "upper characters 8192", bound: { kind: "upper", value: 8192, unit: "characters" }, expected: "within-budget", limit: 8192 },
  { name: "upper characters 8193", bound: { kind: "upper", value: 8193, unit: "characters" }, expected: "over-budget", limit: 8192 },
  { name: "zero", bound: { kind: "exact", value: 0, unit: "bytes" }, expected: "within-budget", limit: 8192 },
  { name: "negative", bound: { kind: "exact", value: -1, unit: "bytes" }, expected: "not-comparable" },
  { name: "unsafe integer", bound: { kind: "exact", value: 9007199254740992, unit: "bytes" }, expected: "not-comparable" },
  { name: "unknown bound", bound: { kind: "unknown", unit: "bytes" }, expected: "not-comparable" },
  { name: "elements", bound: { kind: "upper", value: 10, unit: "elements" }, expected: "not-comparable" },
  { name: "records", bound: { kind: "upper", value: 10, unit: "records" }, expected: "not-comparable" },
  { name: "unknown unit", bound: { kind: "upper", value: 10, unit: "words" } as unknown as ResolvedBound, expected: "not-comparable" },
];

interface DerivedCase {
  name: string;
  program: string;
  bound: ResolvedBound;
  decision: DirectCase["expected"];
}

const derivedCases: readonly DerivedCase[] = [
  {
    name: "nested byte cap alias",
    program: `const CAP = 8192; const limit = Math.min(requested, CAP); return extensions.ctx_read({ id: "h", length: limit });`,
    bound: { kind: "upper", value: 8192, unit: "bytes" },
    decision: "within-budget",
  },
  {
    name: "conditional byte cap",
    program: `const limit = compact ? 8191 : Math.min(requested, 8192); return extensions.ctx_read({ id: "h", length: limit });`,
    bound: { kind: "upper", value: 8192, unit: "bytes" },
    decision: "within-budget",
  },
  {
    name: "bounded byte max",
    program: `const limit = Math.max(Math.min(a, 8191), Math.min(b, 8192)); return extensions.ctx_read({ id: "h", length: limit });`,
    bound: { kind: "upper", value: 8192, unit: "bytes" },
    decision: "within-budget",
  },
  {
    name: "aliased over-budget byte cap",
    program: `const CAP = 8193; const limit = Math.min(requested, CAP); return extensions.ctx_read({ id: "h", length: limit });`,
    bound: { kind: "upper", value: 8193, unit: "bytes" },
    decision: "over-budget",
  },
  {
    name: "token cap alias",
    program: `const CAP = 4000; const limit = Math.min(requested, CAP); return extensions.fovea_focus({ query: "x", maxTokens: limit });`,
    bound: { kind: "upper", value: 4000, unit: "tokens" },
    decision: "within-budget",
  },
  {
    name: "unsupported arithmetic remains unknown",
    program: `const limit = requested + 4096; return extensions.fovea_focus({ query: "x", maxTokens: limit });`,
    bound: { kind: "unknown", unit: "tokens" },
    decision: "not-comparable",
  },
  {
    name: "unsafe literal remains unknown",
    program: `return extensions.ctx_read({ id: "h", length: 9007199254740992 });`,
    bound: { kind: "unknown", unit: "bytes" },
    decision: "not-comparable",
  },
];

export interface PolicyBoundaryCheckResult {
  passed: number;
  failed: number;
  failures: string[];
}

export function runPolicyBoundaryChecks(): PolicyBoundaryCheckResult {
  const failures: string[] = [];
  let checks = 0;
  const check = (name: string, condition: boolean): void => {
    checks++;
    if (!condition) failures.push(name);
  };

  for (const test of directCases) {
    const decision = evaluateReturnBudget(test.bound, DEFAULT_CONTEXT_BOUNDARY_POLICY);
    check(`${test.name}: decision`, decision.kind === test.expected);
    if (test.limit !== undefined && decision.kind !== "not-comparable") {
      check(`${test.name}: default limit`, decision.limit === test.limit);
    }
    if (decision.kind === "not-comparable") check(`${test.name}: reason`, decision.reason.length > 0);
  }

  for (const test of derivedCases) {
    const result = analyzeProgram(test.program);
    check(`${test.name}: bound`, JSON.stringify(result.metrics.returnBound) === JSON.stringify(test.bound));
    check(`${test.name}: policy`, result.metrics.quantitativeDecision?.kind === test.decision);
  }

  const validConfig = validateContextBoundaryPolicy(DEFAULT_CONTEXT_BOUNDARY_POLICY);
  check("default policy validates", validConfig.length === 0);
  check("invalid policy rejects fractional budget", validateContextBoundaryPolicy({ maxBytes: 1.5 }).length === 1);
  check("invalid policy rejects negative budget", validateContextBoundaryPolicy({ maxTokens: -1 }).length === 1);
  check("invalid policy rejects excessive budget", validateContextBoundaryPolicy({ maxCharacters: MAX_CONTEXT_BOUNDARY_BUDGET + 1 }).length === 1);
  return { passed: checks - failures.length, failed: failures.length, failures };
}
