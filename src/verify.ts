/**
 * Quick verification: run the analyzer against representative Fabric programs.
 */

import { analyzeProgram, type AnalyzerOptions } from "./analyzer.js";

type TestCase = {
  name: string;
  program: string;
  expectBlock: boolean;
  options?: AnalyzerOptions;
};

const tests: TestCase[] = [
  {
    name: "raw passthrough: return await tools.read(...)",
    program: `const r = await tools.read({ path: "src/index.ts" }); return r;`,
    expectBlock: true,
  },
  {
    name: "raw passthrough: current pi.read(...)",
    program: `const r = await pi.read({ path: "src/index.ts" }); return r;`,
    expectBlock: true,
  },
  {
    name: "raw passthrough: return tools.grep(...)",
    program: `return await tools.grep({ pattern: "TODO", path: "src/" });`,
    expectBlock: true,
  },
  {
    name: "bare identifier return after tool call",
    program: `const r = await tools.read({ path: "package.json" }); return r;`,
    expectBlock: true,
  },
  {
    name: "near-raw object return",
    program: `const r = await pi.read({ path: "package.json" }); return { data: r };`,
    expectBlock: true,
  },
  {
    name: "projected return: current pi.read line count",
    program: `const r = await pi.read({ path: "src/index.ts" }); return { lines: r.split('\\n').length, path: "src/index.ts" };`,
    expectBlock: false,
  },
  {
    name: "projected return: extract only line count",
    program: `const r = await tools.read({ path: "src/index.ts" }); return { lines: r.content.split('\\n').length, path: "src/index.ts" };`,
    expectBlock: false,
  },
  {
    name: "mapped return: extract names from list",
    program: `const files = await tools.list({}); return files.map(f => f.name);`,
    expectBlock: false,
  },
  {
    name: "summarized return: current extension helper",
    program: `const r = await pi.grep({ pattern: "TODO" }); return extensions.ctx_summarize({ text: r });`,
    expectBlock: false,
  },
  {
    name: "summarized return: ce.summarize compatibility",
    program: `const r = await tools.grep({ pattern: "TODO" }); return ce.summarize(r);`,
    expectBlock: false,
  },
  {
    name: "offloaded return: current extension helper",
    program: `const r = await pi.read({ path: "big.json" }); return extensions.ctx_offload({ key: "big-json", source: "read", data: r });`,
    expectBlock: false,
  },
  {
    name: "many tool calls, no processing (>3)",
    program: `const a = await tools.read({path:"a"}); const b = await tools.read({path:"b"}); const c = await tools.read({path:"c"}); const d = await tools.read({path:"d"}); return {a,b,c,d};`,
    expectBlock: true,
  },
  {
    name: "configurable unprocessed-call limit",
    program: `const a = await pi.read({path:"a"}); const b = await pi.read({path:"b"}); return [a,b];`,
    options: { maxUnprocessedToolCalls: 1 },
    expectBlock: true,
  },
  {
    name: "many tool calls WITH processing (loop + map)",
    program: `const paths = ["a","b","c","d"]; const results = []; for (const p of paths) { const r = await tools.read({path:p}); results.push(r.content.length); } return results;`,
    expectBlock: false,
  },
  {
    name: "no tool calls, pure computation",
    program: `const x = 1 + 2; return { x };`,
    expectBlock: false,
  },
  {
    name: "large literal return (>4000 tokens)",
    program: `return { data: "${"x".repeat(20000)}" };`,
    expectBlock: true,
  },
  {
    name: "filtered return: .filter() on array",
    program: `const logs = await tools.bash({command:"cat log.txt"}); return logs.split('\\n').filter(l => l.includes("ERROR"));`,
    expectBlock: false,
  },
  {
    name: "String() does not reduce raw data",
    program: `const raw = await pi.read({ path: "massive.log" }); return String(raw);`,
    expectBlock: true,
  },
  {
    name: "JSON.stringify() does not reduce raw data",
    program: `const raw = await pi.read({ path: "massive.log" }); return JSON.stringify(raw);`,
    expectBlock: true,
  },
  {
    name: "encoder followed by scalar length is safe",
    program: `const raw = await pi.read({ path: "massive.log" }); return JSON.stringify(raw).length;`,
    expectBlock: false,
  },
  {
    name: "alias chain preserves taint",
    program: `const raw = await pi.read({ path: "massive.log" }); const alias = raw; return alias;`,
    expectBlock: true,
  },
  {
    name: "destructured scalar projection is safe",
    program: `const raw = await pi.read({ path: "massive.log" }); const { length } = raw; return { length };`,
    expectBlock: false,
  },
  {
    name: "unknown helper receiving raw data is unsafe",
    program: `const raw = await pi.read({ path: "massive.log" }); const x = normalize(raw); return x;`,
    expectBlock: true,
  },
  {
    name: "local helper wrapping CE compression is safe",
    program: `function summarize(x) { return extensions.ctx_summarize({ text: x, maxTokens: 200 }); } const raw = await pi.read({ path: "massive.log" }); return summarize(raw);`,
    expectBlock: false,
  },
  {
    name: "identity map preserves taint",
    program: `const rows = await tools.list({}); return rows.map(row => row);`,
    expectBlock: true,
  },
  {
    name: "property map projects fields",
    program: `const rows = await tools.list({}); return rows.map(row => row.name);`,
    expectBlock: false,
  },
  {
    name: "split alone does not reduce text",
    program: `const raw = await tools.bash({ command: "cat massive.log" }); return raw.split("\\n");`,
    expectBlock: true,
  },
  {
    name: "split and filter selects matching lines",
    program: `const raw = await tools.bash({ command: "cat massive.log" }); return raw.split("\\n").filter(line => line.includes("ERROR"));`,
    expectBlock: false,
  },
  {
    name: "Promise.all raw aggregate is blocked",
    program: `const values = await Promise.all([pi.read({ path: "a" }), pi.read({ path: "b" })]); return values;`,
    expectBlock: true,
  },
  {
    name: "Promise.all followed by field projection is safe",
    program: `const values = await Promise.all([pi.read({ path: "a" }), pi.read({ path: "b" })]); return values.map(value => value.path);`,
    expectBlock: false,
  },
  {
    name: "bounded Fovea selection is accepted",
    program: `return extensions.fovea_focus({ query: "authentication", maxTokens: 500 });`,
    expectBlock: false,
  },
  {
    name: "unbounded Fovea selection remains guarded",
    program: `return extensions.fovea_focus({ query: "authentication" });`,
    expectBlock: true,
  },
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  const result = analyzeProgram(test.program, test.options);
  const wasBlocked = !result.ok;
  const status = wasBlocked === test.expectBlock ? "✅" : "❌";
  const label = wasBlocked === test.expectBlock ? "PASS" : "FAIL";

  console.log(`${status} [${label}] ${test.name}`);
  console.log(`     expected block=${test.expectBlock}, got block=${wasBlocked}`);
  if (result.reasons.length > 0) {
    console.log(`     reasons: ${result.reasons.map((r) => r.slice(0, 80)).join("; ")}`);
  }
  console.log(`     metrics: toolCalls=${result.metrics.toolCalls}, rawReturn=${result.metrics.returnIsRawToolResult}, processing=${result.metrics.hasProcessingBetweenToolAndReturn}, branching=${result.metrics.hasLoopOrConditional}, estTokens=${result.metrics.estimatedReturnTokens}`);
  console.log();

  if (wasBlocked === test.expectBlock) passed++;
  else failed++;
}

console.log("---");
console.log(`Results: ${passed} passed, ${failed} failed out of ${tests.length} tests.`);
process.exit(failed > 0 ? 1 : 0);
