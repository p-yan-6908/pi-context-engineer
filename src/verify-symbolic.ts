import { analyzeProgram } from "./analyzer.js";
import type { ResolvedBound } from "./context-effects.js";

interface SymbolicCase {
  name: string;
  program: string;
  expected: ResolvedBound;
  reasonIncludes: string;
}

const cases: readonly SymbolicCase[] = [
  {
    name: "literal addition",
    program: `return extensions.ctx_read({ id: "h", length: 2000 + 1000 });`,
    expected: { kind: "exact", value: 3000, unit: "bytes" },
    reasonIncludes: "exact 3000 bytes",
  },
  {
    name: "alias plus literal",
    program: `const A = 2000; return extensions.ctx_read({ id: "h", length: A + 1000 });`,
    expected: { kind: "exact", value: 3000, unit: "bytes" },
    reasonIncludes: "3000 bytes",
  },
  {
    name: "alias plus alias",
    program: `const A = 2000; const B = 1000; return extensions.ctx_read({ id: "h", length: A + B });`,
    expected: { kind: "exact", value: 3000, unit: "bytes" },
    reasonIncludes: "A → B",
  },
  {
    name: "literal multiplication",
    program: `return extensions.ctx_read({ id: "h", length: 1024 * 4 });`,
    expected: { kind: "exact", value: 4096, unit: "bytes" },
    reasonIncludes: "exact 4096 bytes",
  },
  {
    name: "multiplication through alias",
    program: `const BASE = 1024; return extensions.ctx_read({ id: "h", length: BASE * 4 });`,
    expected: { kind: "exact", value: 4096, unit: "bytes" },
    reasonIncludes: "BASE",
  },
  {
    name: "nested exact arithmetic",
    program: `const A = 2; const B = 3; return extensions.ctx_read({ id: "h", length: (A + B) * 4 });`,
    expected: { kind: "exact", value: 20, unit: "bytes" },
    reasonIncludes: "20 bytes",
  },
  {
    name: "Math.min dynamic then literal",
    program: `return extensions.ctx_read({ id: "h", length: Math.min(requested, 4096) });`,
    expected: { kind: "upper", value: 4096, unit: "bytes" },
    reasonIncludes: "upper-bounded by 4096 bytes",
  },
  {
    name: "Math.min literal then dynamic",
    program: `return extensions.ctx_read({ id: "h", length: Math.min(4096, requested) });`,
    expected: { kind: "upper", value: 4096, unit: "bytes" },
    reasonIncludes: "Math.min(4096, requested)",
  },
  {
    name: "Math.min through alias",
    program: `const CAP = 4096; return extensions.ctx_read({ id: "h", length: Math.min(requested, CAP) });`,
    expected: { kind: "upper", value: 4096, unit: "bytes" },
    reasonIncludes: "through CAP",
  },
  {
    name: "Math.min chooses smallest cap",
    program: `return extensions.ctx_read({ id: "h", length: Math.min(requested, 4096, 8192) });`,
    expected: { kind: "upper", value: 4096, unit: "bytes" },
    reasonIncludes: "4096 bytes",
  },
  {
    name: "nested Math.min",
    program: `return extensions.ctx_read({ id: "h", length: Math.min(Math.min(requested, 8192), 4096) });`,
    expected: { kind: "upper", value: 4096, unit: "bytes" },
    reasonIncludes: "upper-bounded by 4096 bytes",
  },
  {
    name: "aliased Math.min upper bound",
    program: `const LIMIT = Math.min(requested, 4096); return extensions.ctx_read({ id: "h", length: LIMIT });`,
    expected: { kind: "upper", value: 4096, unit: "bytes" },
    reasonIncludes: "through LIMIT",
  },
  {
    name: "token upper bound",
    program: `return extensions.ctx_summarize({ text: "x", maxTokens: Math.min(requested, 300) });`,
    expected: { kind: "upper", value: 300, unit: "tokens" },
    reasonIncludes: "300 tokens",
  },
  {
    name: "Math.max remains unknown",
    program: `return extensions.ctx_read({ id: "h", length: Math.max(requested, 4096) });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "no provable non-negative safe-integer bound",
  },
  {
    name: "dynamic addition remains unknown",
    program: `return extensions.ctx_read({ id: "h", length: requested + 4096 });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "no provable non-negative safe-integer bound",
  },
  {
    name: "dynamic multiplication remains unknown",
    program: `return extensions.ctx_read({ id: "h", length: requested * 2 });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "no provable non-negative safe-integer bound",
  },
  {
    name: "negative result remains unknown",
    program: `return extensions.ctx_read({ id: "h", length: 4096 - 5000 });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "no provable non-negative safe-integer bound",
  },
  {
    name: "infinity remains unknown",
    program: `return extensions.ctx_read({ id: "h", length: 1e999 });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "no provable non-negative safe-integer bound",
  },
  {
    name: "unsafe integer remains unknown",
    program: `return extensions.ctx_read({ id: "h", length: 9007199254740992 });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "no provable non-negative safe-integer bound",
  },
  {
    name: "negative Math.min cap remains unknown",
    program: `return extensions.ctx_read({ id: "h", length: Math.min(requested, -1) });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "no provable non-negative safe-integer bound",
  },
  {
    name: "decimal Math.min cap remains unknown",
    program: `return extensions.ctx_read({ id: "h", length: Math.min(requested, 1.5) });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "no provable non-negative safe-integer bound",
  },
  {
    name: "mutable Math.min cap remains unknown",
    program: `let CAP = 4096; return extensions.ctx_read({ id: "h", length: Math.min(requested, CAP) });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "no provable non-negative safe-integer bound",
  },
  {
    name: "unsupported rounding remains unknown",
    program: `return extensions.ctx_read({ id: "h", length: Math.ceil(4096) });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "no provable non-negative safe-integer bound",
  },
  {
    name: "conditional remains unknown",
    program: `return extensions.ctx_read({ id: "h", length: condition ? 100 : 4096 });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "no provable non-negative safe-integer bound",
  },
];

export interface SymbolicCheckResult {
  passed: number;
  failed: number;
  failures: string[];
}

export function runSymbolicChecks(): SymbolicCheckResult {
  const failures: string[] = [];
  let checks = 0;
  const check = (name: string, condition: boolean): void => {
    checks++;
    if (!condition) failures.push(name);
  };
  for (const test of cases) {
    const result = analyzeProgram(test.program);
    const actual = result.metrics.returnBound;
    const reason = result.metrics.returnProvenance.at(-1)?.reason ?? "";
    check(`${test.name}: bound`, JSON.stringify(actual) === JSON.stringify(test.expected));
    check(`${test.name}: reason`, reason.includes(test.reasonIncludes));
    check(`${test.name}: policy unchanged`, result.hardBlock === false);
  }
  return { passed: checks - failures.length, failed: failures.length, failures };
}
