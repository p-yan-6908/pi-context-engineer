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
