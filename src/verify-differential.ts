import { analyzeProgram, type TaintKind } from "./analyzer.js";

/**
 * Classification snapshots captured from the v0.4.0 analyzer. These are
 * intentionally policy-only expectations: quantitative fields may grow in
 * v0.5, but allow/reject and legacy retention classes must remain stable until
 * an intentional semantic change is recorded.
 */
export interface V04DifferentialCase {
  readonly name: string;
  readonly program: string;
  readonly expected: {
    readonly ok: boolean;
    readonly hardBlock: boolean;
    readonly returnTaint: TaintKind;
    readonly returnIsReduced: boolean;
    readonly provablyBounded: boolean;
    readonly retention: number | null;
  };
}

export const V04_DIFFERENTIAL_CASES: readonly V04DifferentialCase[] = [
  {
    name: "raw-read",
    program: `const r = await pi.read({ path: "x" }); return r;`,
    expected: { ok: false, hardBlock: true, returnTaint: "raw", returnIsReduced: false, provablyBounded: false, retention: 1 },
  },
  {
    name: "projected-read",
    program: `const r = await pi.read({ path: "x" }); return r.split("\\n").length;`,
    expected: { ok: true, hardBlock: false, returnTaint: "projected", returnIsReduced: true, provablyBounded: true, retention: 0.01 },
  },
  {
    name: "ctx-read-source",
    program: `const r = await pi.read({ path: "x" }); return extensions.ctx_read({ id: r, offset: 0, length: 4096 });`,
    expected: { ok: true, hardBlock: false, returnTaint: "selected", returnIsReduced: true, provablyBounded: true, retention: 0.25 },
  },
  {
    name: "ctx-summary-source",
    program: `const r = await pi.read({ path: "x" }); return extensions.ctx_summarize({ text: r, maxTokens: 300 });`,
    expected: { ok: true, hardBlock: false, returnTaint: "compressed", returnIsReduced: true, provablyBounded: true, retention: 0.03 },
  },
  {
    name: "ctx-offload-source",
    program: `const r = await pi.read({ path: "x" }); return extensions.ctx_offload({ key: "x", source: "read", data: r });`,
    expected: { ok: true, hardBlock: false, returnTaint: "offloaded", returnIsReduced: true, provablyBounded: true, retention: 0 },
  },
  {
    name: "fovea-bounded",
    program: `return extensions.fovea_focus({ query: "auth", maxTokens: 500 });`,
    expected: { ok: true, hardBlock: false, returnTaint: "selected", returnIsReduced: true, provablyBounded: true, retention: 0.05 },
  },
  {
    name: "fovea-unbounded",
    program: `return extensions.fovea_focus({ query: "auth" });`,
    expected: { ok: false, hardBlock: true, returnTaint: "unknown", returnIsReduced: false, provablyBounded: false, retention: 1 },
  },
  {
    name: "ce-summary-alias",
    program: `const r = await tools.grep({ pattern: "TODO" }); return ce.summarize(r);`,
    expected: { ok: true, hardBlock: false, returnTaint: "compressed", returnIsReduced: true, provablyBounded: true, retention: 0.08 },
  },
  {
    name: "unknown-helper",
    program: `const r = await pi.read({ path: "x" }); return extensions.ctx_future({ data: r });`,
    expected: { ok: false, hardBlock: true, returnTaint: "selected", returnIsReduced: true, provablyBounded: false, retention: 1 },
  },
  {
    name: "raw-map",
    program: `const files = await tools.list({}); return files.map(f => f.name);`,
    expected: { ok: false, hardBlock: true, returnTaint: "projected", returnIsReduced: true, provablyBounded: false, retention: 1 },
  },
  {
    name: "promise-all",
    program: `const a = await pi.read({path:"a"}); const b = await pi.read({path:"b"}); return Promise.all([a,b]);`,
    expected: { ok: false, hardBlock: true, returnTaint: "raw", returnIsReduced: false, provablyBounded: false, retention: 1 },
  },
  {
    name: "scalar",
    program: `const r = await pi.read({ path: "x" }); return r.length;`,
    expected: { ok: true, hardBlock: false, returnTaint: "projected", returnIsReduced: true, provablyBounded: true, retention: 0.01 },
  },
];

export interface V04DifferentialResult {
  passed: number;
  failed: number;
  failures: Array<{ name: string; expected: V04DifferentialCase["expected"]; actual: V04DifferentialCase["expected"] }>;
}

export function runV04Differential(): V04DifferentialResult {
  const failures: V04DifferentialResult["failures"] = [];
  for (const test of V04_DIFFERENTIAL_CASES) {
    const result = analyzeProgram(test.program);
    const actual = {
      ok: result.ok,
      hardBlock: result.hardBlock,
      returnTaint: result.metrics.returnTaint,
      returnIsReduced: result.metrics.returnIsReduced,
      provablyBounded: result.metrics.provablyBounded,
      retention: result.metrics.estimatedRetentionRatio,
    };
    if (JSON.stringify(actual) !== JSON.stringify(test.expected)) failures.push({ name: test.name, expected: test.expected, actual });
  }
  return { passed: V04_DIFFERENTIAL_CASES.length - failures.length, failed: failures.length, failures };
}
