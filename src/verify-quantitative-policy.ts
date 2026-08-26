import { analyzeProgram } from "./analyzer.js";
import { evaluateProgram } from "./wrapper.js";
import type { ResolvedBound } from "./context-effects.js";
import {
  DEFAULT_CONTEXT_BOUNDARY_POLICY,
  evaluateReturnBudget,
  type QuantitativeDecision,
} from "./quantitative-policy.js";

interface PolicyCase {
  name: string;
  program: string;
  v04: { ok: boolean; hardBlock: boolean };
  v05: { ok: boolean; hardBlock: boolean; decision: QuantitativeDecision["kind"]; applied: boolean };
}

const cases: readonly PolicyCase[] = [
  {
    name: "symbolically capped Fovea selection",
    program: `const limit = Math.min(requested, 3000); return extensions.fovea_focus({ query: "auth", maxTokens: limit });`,
    v04: { ok: false, hardBlock: true },
    v05: { ok: true, hardBlock: false, decision: "within-budget", applied: true },
  },
  {
    name: "conditionally capped Fovea selection",
    program: `const limit = compact ? 1024 : Math.min(requested, 3000); return extensions.fovea_focus({ query: "auth", maxTokens: limit });`,
    v04: { ok: false, hardBlock: true },
    v05: { ok: true, hardBlock: false, decision: "within-budget", applied: true },
  },
  {
    name: "Math.max bounded Fovea selection",
    program: `const limit = Math.max(Math.min(a, 1024), Math.min(b, 3000)); return extensions.fovea_focus({ query: "auth", maxTokens: limit });`,
    v04: { ok: false, hardBlock: true },
    v05: { ok: true, hardBlock: false, decision: "within-budget", applied: true },
  },
  {
    name: "exact token ceiling remains legacy-safe",
    program: `const limit = 4000; return extensions.fovea_focus({ query: "auth", maxTokens: limit });`,
    v04: { ok: true, hardBlock: false },
    v05: { ok: true, hardBlock: false, decision: "within-budget", applied: false },
  },
  {
    name: "finite token ceiling over policy limit",
    program: `const limit = Math.min(requested, 4001); return extensions.fovea_focus({ query: "auth", maxTokens: limit });`,
    v04: { ok: false, hardBlock: true },
    v05: { ok: false, hardBlock: true, decision: "over-budget", applied: false },
  },
  {
    name: "unknown conditional branch",
    program: `const limit = compact ? 3000 : requested; return extensions.fovea_focus({ query: "auth", maxTokens: limit });`,
    v04: { ok: false, hardBlock: true },
    v05: { ok: false, hardBlock: true, decision: "not-comparable", applied: false },
  },
  {
    name: "unsupported dynamic arithmetic",
    program: `const limit = requested + 4096; return extensions.fovea_focus({ query: "auth", maxTokens: limit });`,
    v04: { ok: false, hardBlock: true },
    v05: { ok: false, hardBlock: true, decision: "not-comparable", applied: false },
  },
  {
    name: "legacy-safe oversized byte selection",
    program: `return extensions.ctx_read({ id: "h", length: 4000000000 });`,
    v04: { ok: true, hardBlock: false },
    v05: { ok: true, hardBlock: false, decision: "over-budget", applied: false },
  },
];

interface UnitCase {
  name: string;
  bound: ResolvedBound;
  expected: QuantitativeDecision["kind"];
}

const unitCases: readonly UnitCase[] = [
  { name: "exact bytes within", bound: { kind: "exact", value: 4096, unit: "bytes" }, expected: "within-budget" },
  { name: "upper bytes within", bound: { kind: "upper", value: 4096, unit: "bytes" }, expected: "within-budget" },
  { name: "bytes over", bound: { kind: "upper", value: 4000000000, unit: "bytes" }, expected: "over-budget" },
  { name: "tokens within", bound: { kind: "exact", value: 300, unit: "tokens" }, expected: "within-budget" },
  { name: "characters within", bound: { kind: "upper", value: 4000, unit: "characters" }, expected: "within-budget" },
  { name: "elements are not comparable", bound: { kind: "upper", value: 10, unit: "elements" }, expected: "not-comparable" },
  { name: "records are not comparable", bound: { kind: "exact", value: 10, unit: "records" }, expected: "not-comparable" },
  { name: "unknown is not comparable", bound: { kind: "unknown", unit: "bytes" }, expected: "not-comparable" },
];

export interface V05PolicyCheckResult {
  passed: number;
  failed: number;
  failures: string[];
  intentionalPassed: number;
  intentionalTotal: number;
  parityPassed: number;
  parityTotal: number;
}

export function runV05PolicyChecks(): V05PolicyCheckResult {
  const failures: string[] = [];
  let checks = 0;
  const check = (name: string, condition: boolean): void => {
    checks++;
    if (!condition) failures.push(name);
  };

  let intentionalPassed = 0;
  let intentionalTotal = 0;
  let parityPassed = 0;
  let parityTotal = 0;
  for (const test of cases) {
    const result = analyzeProgram(test.program);
    const decision = result.metrics.quantitativeDecision;
    const before = failures.length;
    check(`${test.name}: v0.4 expectation recorded`, test.v04.ok !== test.v05.ok || (test.v04.ok === test.v05.ok && test.v04.hardBlock === test.v05.hardBlock));
    check(`${test.name}: v0.5 ok`, result.ok === test.v05.ok);
    check(`${test.name}: v0.5 hardBlock`, result.hardBlock === test.v05.hardBlock);
    check(`${test.name}: decision`, decision?.kind === test.v05.decision);
    check(`${test.name}: policy application`, result.metrics.quantitativePolicyApplied === test.v05.applied);
    const changed = test.v04.ok !== test.v05.ok || test.v04.hardBlock !== test.v05.hardBlock;
    if (changed) {
      intentionalTotal++;
      if (failures.length === before) intentionalPassed++;
    } else {
      parityTotal++;
      if (failures.length === before) parityPassed++;
    }
  }

  for (const test of unitCases) {
    const decision = evaluateReturnBudget(test.bound, DEFAULT_CONTEXT_BOUNDARY_POLICY);
    check(`${test.name}: decision`, decision.kind === test.expected);
    check(`${test.name}: no cross-unit conversion`, test.bound.kind === "unknown" || decision.kind === "not-comparable" || decision.unit === test.bound.unit);
  }

  const custom = analyzeProgram(cases[0].program, { quantitativePolicy: { maxTokens: 1000 } });
  check("custom token budget: over-budget", custom.metrics.quantitativeDecision?.kind === "over-budget");
  check("custom token budget: remains blocked", custom.ok === false && custom.hardBlock === true);
  check("strict wrapper: within-budget passes", evaluateProgram(cases[0].program, { strict: true }).tier === "PASS");
  check("wrapper: over-budget blocks", evaluateProgram(cases[4].program).tier === "BLOCK");
  check("strict wrapper: custom budget blocks", evaluateProgram(cases[0].program, { strict: true, quantitativePolicy: { maxTokens: 1000 } }).tier === "BLOCK");

  return { passed: checks - failures.length, failed: failures.length, failures, intentionalPassed, intentionalTotal, parityPassed, parityTotal };
}
