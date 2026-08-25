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
    name: "conditional dynamic branch remains unknown",
    program: `return extensions.ctx_read({ id: "h", length: condition ? 100 : requested });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "requires a finite upper bound for every branch",
  },
  {
    name: "conditional equal exact branches remain exact",
    program: `return extensions.ctx_read({ id: "h", length: compact ? 4096 : 4096 });`,
    expected: { kind: "exact", value: 4096, unit: "bytes" },
    reasonIncludes: "join exact bound",
  },
  {
    name: "conditional differing exact branches become upper",
    program: `return extensions.ctx_read({ id: "h", length: compact ? 1024 : 4096 });`,
    expected: { kind: "upper", value: 4096, unit: "bytes" },
    reasonIncludes: "join upper bound",
  },
  {
    name: "conditional alias branches join",
    program: `const SMALL = 1024; const LARGE = 4096; return extensions.ctx_read({ id: "h", length: compact ? SMALL : LARGE });`,
    expected: { kind: "upper", value: 4096, unit: "bytes" },
    reasonIncludes: "true branch: SMALL",
  },
  {
    name: "conditional upper and exact branches join",
    program: `return extensions.ctx_read({ id: "h", length: compact ? Math.min(requested, 2048) : 4096 });`,
    expected: { kind: "upper", value: 4096, unit: "bytes" },
    reasonIncludes: "join upper bound",
  },
  {
    name: "conditional upper branches join",
    program: `return extensions.ctx_read({ id: "h", length: compact ? Math.min(a, 2048) : Math.min(b, 4096) });`,
    expected: { kind: "upper", value: 4096, unit: "bytes" },
    reasonIncludes: "max(2048, 4096)",
  },
  {
    name: "conditional aliased cap joins",
    program: `const DEFAULT = 4096; const HARD_CAP = 8192; const limit = compact ? DEFAULT : Math.min(requested, HARD_CAP); return extensions.ctx_read({ id: "h", length: limit });`,
    expected: { kind: "upper", value: 8192, unit: "bytes" },
    reasonIncludes: "max(4096, 8192)",
  },
  {
    name: "conditional unknown true branch remains unknown",
    program: `return extensions.ctx_read({ id: "h", length: compact ? requested : 4096 });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "requires a finite upper bound for every branch",
  },
  {
    name: "conditional unknown false branch remains unknown",
    program: `return extensions.ctx_read({ id: "h", length: compact ? Math.min(requested, 4096) : dynamic() });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "requires a finite upper bound for every branch",
  },
  {
    name: "Math.max exact operands remain exact",
    program: `return extensions.ctx_read({ id: "h", length: Math.max(1024, 4096) });`,
    expected: { kind: "exact", value: 4096, unit: "bytes" },
    reasonIncludes: "max join exact bound",
  },
  {
    name: "Math.max bounded upper operands",
    program: `return extensions.ctx_read({ id: "h", length: Math.max(Math.min(a, 2048), Math.min(b, 4096)) });`,
    expected: { kind: "upper", value: 4096, unit: "bytes" },
    reasonIncludes: "max join upper bound",
  },
  {
    name: "Math.max bounded upper and exact operands",
    program: `return extensions.ctx_read({ id: "h", length: Math.max(Math.min(a, 2048), 4096) });`,
    expected: { kind: "upper", value: 4096, unit: "bytes" },
    reasonIncludes: "max join upper bound",
  },
  {
    name: "Math.max aliased bounded operands",
    program: `const A = Math.min(a, 2048); const B = Math.min(b, 4096); return extensions.ctx_read({ id: "h", length: Math.max(A, B) });`,
    expected: { kind: "upper", value: 4096, unit: "bytes" },
    reasonIncludes: "max join upper bound",
  },
  {
    name: "Math.max dynamic operand remains unknown",
    program: `return extensions.ctx_read({ id: "h", length: Math.max(dynamic, 4096) });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "requires a finite upper bound for every operand",
  },
  {
    name: "Math.max dynamic call remains unknown",
    program: `return extensions.ctx_read({ id: "h", length: Math.max(Math.min(a, 2048), dynamic()) });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "requires a finite upper bound for every operand",
  },
  {
    name: "token conditional join preserves units",
    program: `return extensions.ctx_summarize({ text: "x", maxTokens: compact ? 100 : Math.min(requested, 300) });`,
    expected: { kind: "upper", value: 300, unit: "tokens" },
    reasonIncludes: "max(100, 300) = 300 tokens",
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
