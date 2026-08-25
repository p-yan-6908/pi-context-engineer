import { analyzeProgram } from "./analyzer.js";
import type { ResolvedBound } from "./context-effects.js";

interface AliasCase {
  name: string;
  program: string;
  expected: ResolvedBound;
  reasonIncludes: string;
}

const cases: readonly AliasCase[] = [
  {
    name: "direct const",
    program: `const LIMIT = 4096; return extensions.ctx_read({ id: "h", length: LIMIT });`,
    expected: { kind: "constant", value: 4096, unit: "bytes" },
    reasonIncludes: "length resolves through LIMIT = 4096 bytes.",
  },
  {
    name: "two-hop const alias",
    program: `const BASE = 4096; const LIMIT = BASE; return extensions.ctx_read({ id: "h", length: LIMIT });`,
    expected: { kind: "constant", value: 4096, unit: "bytes" },
    reasonIncludes: "LIMIT → BASE = 4096 bytes.",
  },
  {
    name: "three-hop const alias",
    program: `const ROOT = 4096; const BASE = ROOT; const LIMIT = BASE; return extensions.ctx_read({ id: "h", length: LIMIT });`,
    expected: { kind: "constant", value: 4096, unit: "bytes" },
    reasonIncludes: "LIMIT → BASE → ROOT = 4096 bytes.",
  },
  {
    name: "summarize const alias",
    program: `const TOKENS = 300; return extensions.ctx_summarize({ text: "x", maxTokens: TOKENS });`,
    expected: { kind: "constant", value: 300, unit: "tokens" },
    reasonIncludes: "maxTokens resolves through TOKENS = 300 tokens.",
  },
  {
    name: "Fovea const alias",
    program: `const TOKENS = 1000; return extensions.fovea_focus({ query: "x", maxTokens: TOKENS });`,
    expected: { kind: "constant", value: 1000, unit: "tokens" },
    reasonIncludes: "maxTokens resolves through TOKENS = 1000 tokens.",
  },
  {
    name: "shadowed function const",
    program: `const LIMIT = 4096; function f() { const LIMIT = 100; return extensions.ctx_read({ id: "h", length: LIMIT }); } return f();`,
    expected: { kind: "constant", value: 100, unit: "bytes" },
    reasonIncludes: "length resolves through LIMIT = 100 bytes.",
  },
  {
    name: "outer const inherited by function",
    program: `const LIMIT = 4096; function f() { return extensions.ctx_read({ id: "h", length: LIMIT }); } return f();`,
    expected: { kind: "constant", value: 4096, unit: "bytes" },
    reasonIncludes: "length resolves through LIMIT = 4096 bytes.",
  },
  {
    name: "sibling scope does not leak",
    program: `const LIMIT = 4096; { const LIMIT = 100; const local = extensions.ctx_read({ id: "h", length: LIMIT }); } return extensions.ctx_read({ id: "h", length: LIMIT });`,
    expected: { kind: "constant", value: 4096, unit: "bytes" },
    reasonIncludes: "length resolves through LIMIT = 4096 bytes.",
  },
  {
    name: "let remains unknown",
    program: `let LIMIT = 4096; return extensions.ctx_read({ id: "h", length: LIMIT });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "length has no provable numeric constant (bytes).",
  },
  {
    name: "parameter remains unknown",
    program: `function f(LIMIT) { return extensions.ctx_read({ id: "h", length: LIMIT }); } return f(4096);`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "length has no provable numeric constant (bytes).",
  },
  {
    name: "missing binding remains unknown",
    program: `return extensions.ctx_read({ id: "h", length: LIMIT });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "length has no provable numeric constant (bytes).",
  },
  {
    name: "arithmetic remains unknown",
    program: `const LIMIT = 2048 * 2; return extensions.ctx_read({ id: "h", length: LIMIT });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "length has no provable numeric constant (bytes).",
  },
  {
    name: "call initializer remains unknown",
    program: `const LIMIT = getLimit(); return extensions.ctx_read({ id: "h", length: LIMIT });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "length has no provable numeric constant (bytes).",
  },
  {
    name: "conditional initializer remains unknown",
    program: `const LIMIT = condition ? 4096 : 8192; return extensions.ctx_read({ id: "h", length: LIMIT });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "length has no provable numeric constant (bytes).",
  },
  {
    name: "cycle remains unknown",
    program: `const A = B; const B = A; return extensions.ctx_read({ id: "h", length: A });`,
    expected: { kind: "unknown", unit: "bytes" },
    reasonIncludes: "length has no provable numeric constant (bytes).",
  },
];

export interface ConstantAliasCheckResult {
  passed: number;
  failed: number;
  failures: string[];
}

export function runConstantAliasChecks(): ConstantAliasCheckResult {
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
    check(`${test.name}: policy remains safe`, result.hardBlock === false);
  }
  return { passed: checks - failures.length, failed: failures.length, failures };
}
