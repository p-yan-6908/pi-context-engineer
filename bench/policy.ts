import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { analyzeProgram } from "../src/analyzer.js";

interface PolicyBenchmarkCase {
  id: string;
  program: string;
  v04: "safe" | "unsafe";
  v05: "safe" | "unsafe";
  decision: "within-budget" | "over-budget" | "not-comparable";
}

const cases: readonly PolicyBenchmarkCase[] = [
  {
    id: "symbolic-min-cap",
    program: `const limit = Math.min(requested, 3000); return extensions.fovea_focus({ query: "x", maxTokens: limit });`,
    v04: "unsafe",
    v05: "safe",
    decision: "within-budget",
  },
  {
    id: "alias-cap",
    program: `const CAP = 3000; const limit = Math.min(requested, CAP); return extensions.fovea_focus({ query: "x", maxTokens: limit });`,
    v04: "unsafe",
    v05: "safe",
    decision: "within-budget",
  },
  {
    id: "conditional-cap",
    program: `const limit = compact ? 1000 : Math.min(requested, 3000); return extensions.fovea_focus({ query: "x", maxTokens: limit });`,
    v04: "unsafe",
    v05: "safe",
    decision: "within-budget",
  },
  {
    id: "bounded-max",
    program: `const limit = Math.max(Math.min(a, 1024), Math.min(b, 3000)); return extensions.fovea_focus({ query: "x", maxTokens: limit });`,
    v04: "unsafe",
    v05: "safe",
    decision: "within-budget",
  },
  {
    id: "unknown-conditional",
    program: `const limit = compact ? 3000 : requested; return extensions.fovea_focus({ query: "x", maxTokens: limit });`,
    v04: "unsafe",
    v05: "unsafe",
    decision: "not-comparable",
  },
  {
    id: "over-budget-cap",
    program: `const limit = Math.min(requested, 4001); return extensions.fovea_focus({ query: "x", maxTokens: limit });`,
    v04: "unsafe",
    v05: "unsafe",
    decision: "over-budget",
  },
  {
    id: "legacy-safe-over-budget",
    program: `return extensions.ctx_read({ id: "h", length: 4000000000 });`,
    v04: "safe",
    v05: "safe",
    decision: "over-budget",
  },
];

const iterations = Math.max(1, Number(process.env.POLICY_BENCH_ITERATIONS ?? 25));
const rows = cases.map((test) => {
  const durations: number[] = [];
  let actual: ReturnType<typeof analyzeProgram> | undefined;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const started = performance.now();
    actual = analyzeProgram(test.program);
    durations.push(performance.now() - started);
  }
  const elapsedMs = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  const actualClass = actual!.ok ? "safe" : "unsafe";
  const actualDecision = actual!.metrics.quantitativeDecision?.kind ?? "not-comparable";
  return {
    id: test.id,
    v04: test.v04,
    expectedV05: test.v05,
    actualV05: actualClass,
    expectedDecision: test.decision,
    actualDecision,
    bound: actual!.metrics.returnBound ?? null,
    policyApplied: actual!.metrics.quantitativePolicyApplied,
    meanAnalysisMs: Number(elapsedMs.toFixed(3)),
    correct: actualClass === test.v05 && actualDecision === test.decision,
  };
});

const intentional = rows.filter((row, index) => cases[index].v04 !== cases[index].v05);
const parity = rows.filter((row, index) => cases[index].v04 === cases[index].v05);
const correct = rows.filter((row) => row.correct).length;
function commandText(command: string, args: string[]): string | null {
  try { return execFileSync(command, args, { encoding: "utf8" }).trim() || null; }
  catch { return null; }
}

const environment = {
  sourceCommit: commandText("git", ["rev-parse", "HEAD"]) ?? "unknown",
  dirty: Boolean(commandText("git", ["status", "--porcelain"])),
  nodeVersion: process.version,
  model: process.env.PI_MODEL ?? null,
  provider: process.env.PI_PROVIDER ?? (process.env.PI_MODEL?.includes("/") ? process.env.PI_MODEL.split("/", 1)[0] : null),
  iterations,
};
const report = {
  suite: "v0.5 quantitative policy",
  generatedAt: new Date().toISOString(),
  environment,
  iterations,
  rows,
  totals: {
    correct: `${correct}/${rows.length}`,
    intentionalChanges: `${intentional.filter((row) => row.correct).length}/${intentional.length}`,
    legacyParity: `${parity.filter((row) => row.correct).length}/${parity.length}`,
    unexpectedDifferences: rows.filter((row) => !row.correct).length,
  },
};

const outputPath = process.env.POLICY_BENCHMARK_OUT ?? ".tmp/policy-benchmark.json";
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
console.log("# v0.5 quantitative policy benchmark");
console.log(`Iterations: ${iterations}`);
console.log("| Case | v0.4 | v0.5 expected | v0.5 actual | Decision | Bound | Correct |");
console.log("| --- | :---: | :---: | :---: | --- | --- | :---: |");
for (const row of rows) {
  const boundText = row.bound && row.bound.kind !== "unknown" ? `${row.bound.kind} ${row.bound.value} ${row.bound.unit}` : "unknown";
  console.log(`| ${row.id} | ${row.v04} | ${row.expectedV05} | ${row.actualV05} | ${row.actualDecision} | ${boundText} | ${row.correct ? "yes" : "no"} |`);
}
console.log("");
console.log(`- Correctness: ${report.totals.correct}`);
console.log(`- Intentional v0.5 changes: ${report.totals.intentionalChanges}`);
console.log(`- Legacy parity: ${report.totals.legacyParity}`);
console.log(`- Unexpected differences: ${report.totals.unexpectedDifferences}`);
console.log(`JSON report: ${outputPath}`);
process.exitCode = report.totals.unexpectedDifferences === 0 ? 0 : 1;
