/**
 * Quick verification: run the analyzer against representative Fabric programs.
 */

import { analyzeProgram, type AnalyzerOptions } from "./analyzer.js";
import { ceToolMap } from "./tools.js";
import { FabricExecutionScopes } from "./execution-scope.js";

type TestCase = {
  name: string;
  program: string;
  /** Expect a hard block (direct passthrough). */
  expectBlock?: boolean;
  /** Expect execution with an advisory (tainted but reduced). */
  expectWarn?: boolean;
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
    name: "mapped return remains dynamically sized",
    program: `const files = await tools.list({}); return files.map(f => f.name);`,
    expectBlock: true,
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
    name: "filtered return remains dynamically sized",
    program: `const logs = await tools.bash({command:"cat log.txt"}); return logs.split('\\n').filter(l => l.includes("ERROR"));`,
    expectBlock: true,
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
    name: "property map remains dynamically sized",
    program: `const rows = await tools.list({}); return rows.map(row => row.name);`,
    expectBlock: true,
  },
  {
    name: "split alone does not reduce text",
    program: `const raw = await tools.bash({ command: "cat massive.log" }); return raw.split("\\n");`,
    expectBlock: true,
  },
  {
    name: "split and filter are not a static bound",
    program: `const raw = await tools.bash({ command: "cat massive.log" }); return raw.split("\\n").filter(line => line.includes("ERROR"));`,
    expectBlock: true,
  },
  {
    name: "Promise.all raw aggregate is blocked",
    program: `const values = await Promise.all([pi.read({ path: "a" }), pi.read({ path: "b" })]); return values;`,
    expectBlock: true,
  },
  {
    name: "Promise.all map remains dynamically sized",
    program: `const values = await Promise.all([pi.read({ path: "a" }), pi.read({ path: "b" })]); return values.map(value => value.path);`,
    expectBlock: true,
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

  // ---- Provable-bound regressions ----
  {
    name: "filter can retain every item",
    program: "const raw = await pi.read({ path: \"rows.json\" }); return raw.filter(() => true);",
    expectBlock: true
  },
  {
    name: "bounded slice is safe",
    program: "const raw = await pi.read({ path: \"log.txt\" }); return raw.slice(0, 10);",
    expectBlock: false
  },
  {
    name: "one-item find is bounded",
    program: "const raw = await pi.read({ path: \"rows.json\" }); return raw.find(row => row.id === 7);",
    expectBlock: false
  },
  {
    name: "unbounded reduce is guarded",
    program: "const raw = await pi.read({ path: \"rows.json\" }); return raw.reduce((all, row) => [...all, row], []);",
    expectBlock: true
  },

  {
    name: "trim does not establish a bound",
    program: `const raw = await pi.read({ path: "log.txt" }); return raw.trim();`,
    expectBlock: true,
  },
  {
    name: "replace does not establish a bound",
    program: `const raw = await pi.read({ path: "cfg.json" }); return raw.replace("x", "y");`,
    expectBlock: true,
  },
  {
    name: "nullish coalescing on a compressed result is safe",
    program: `const s = await extensions.ctx_summarize({ text: "x" }); return { summary: s.text ?? s };`,
    expectBlock: false,
  },
  {
    name: "template/map output remains dynamically sized",
    program: `const out = await pi.bash({ cmd: "ps" }); return out.output.split("\\n").filter(Boolean).map(l => ({ row: l.slice(0, 10) }));`,
    expectBlock: true,
  },
  {
    name: "Object.fromEntries remains dynamically sized",
    program: `const pairs = await pi.bash({ cmd: "echo" }); return Object.fromEntries(pairs.output.split("\\n").map(l => [l.slice(0, 3), l.length]));`,
    expectBlock: true,
  },
  {
    name: "mixed diagnostic object still carries unbounded text",
    program: `const d = await pi.bash({ cmd: "uptime" }); const p = await pi.bash({ cmd: "ps" });\nconst rows = p.output.split("\\n").filter(Boolean);\nreturn { up: d.output.trim(), lineCount: rows.length, first: rows[0]?.slice(0, 20) ?? "none" };`,
    expectBlock: true,
  },
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  const result = analyzeProgram(test.program, test.options);
  const tier: "BLOCK" | "WARN" | "PASS" = result.hardBlock ? "BLOCK" : !result.ok ? "WARN" : "PASS";
  const expected = test.expectBlock ? "BLOCK" : test.expectWarn ? "WARN" : "PASS";
  const matched = tier === expected;
  const status = matched ? "[ok]" : "[FAIL]";

  console.log(`${status} [${tier}] ${test.name}`);
  console.log(`     expected ${expected}, got ${tier}`);
  if (result.reasons.length > 0) {
    console.log(`     reasons: ${result.reasons.map((r) => r.slice(0, 110)).join("; ")}`);
  }
  console.log(`     metrics: toolCalls=${result.metrics.toolCalls}, rawReturn=${result.metrics.returnIsRawToolResult}, transforms=${result.metrics.meaningfulTransformations}, retention=${result.metrics.estimatedRetentionRatio ?? "?"}, estTokens=${result.metrics.estimatedReturnTokens}`);
  console.log();

  if (matched) passed++;
  else failed++;
}

console.log("---");
console.log(`Results: ${passed} passed, ${failed} failed out of ${tests.length} tests.`);
const scopes = new FabricExecutionScopes();
scopes.start({ toolCallId: "fabric_a", workspaceRoot: "/tmp/a", startedAt: 1 });
scopes.start({ toolCallId: "fabric_b", workspaceRoot: "/tmp/b", startedAt: 2 });
const sizeAfterStarts = scopes.size;
const nestedA = scopes.isNestedToolResult("fabric_child_a");
const ordinaryIsBoundary = !scopes.isNestedToolResult("model-read");
const finishedA = scopes.finish("fabric_a");
const nestedB = scopes.isNestedToolResult("fabric_child_b");
const finishedB = scopes.finish("fabric_b");
const sizeAfterFinishes = scopes.size;
const nestedAfterFinishes = scopes.isNestedToolResult("fabric_child_after");
const scopeOk = sizeAfterStarts === 2 && nestedA && ordinaryIsBoundary && finishedA && nestedB && finishedB && sizeAfterFinishes === 0 && !nestedAfterFinishes;
console.log(`${scopeOk ? "[ok]" : "[FAIL]"} execution scopes handle overlapping out-of-order Fabric runs`);
let scopeFailures = scopeOk ? 0 : 1;

const summarizeTool = ceToolMap.get("ctx_summarize");
let toolFailures = 0;
if (!summarizeTool) {
  console.log("[FAIL] ctx_summarize is not registered");
  toolFailures++;
} else {
  let modelCalls = 0;
  const toolContext = {
    store: { read: () => ({ content: "", truncated: false }) },
    workspaceRoot: process.cwd(),
    callTool: async () => ({}),
    spawnAgent: async () => "",
    modelCall: async () => { modelCalls++; return "model summary"; },
  } as any;
  const codeText = Array.from({ length: 120 }, (_, index) => `export function item${index}() { return ${index}; }`).join("\\n");
  const codeSummary = await summarizeTool.handler({ text: codeText, mode: "code", maxTokens: 120 }, toolContext);
  const codeRecord = codeSummary && typeof codeSummary === "object" ? codeSummary as Record<string, unknown> : {};
  const codeBytes = Buffer.byteLength(JSON.stringify(codeSummary), "utf8");
  const codeOk = codeRecord.mode === "code" && codeRecord.kind === "code" && modelCalls === 0 && codeBytes <= 120 * 4;
  console.log(`${codeOk ? "[ok]" : "[FAIL]"} ctx_summarize code mode is deterministic and bounded (${codeBytes} bytes)`);
  if (!codeOk) toolFailures++;
  const objectText = JSON.stringify(Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`key${index}`, "x".repeat(180)])));
  const objectSummary = await summarizeTool.handler({ text: objectText, mode: "structural", maxTokens: 120 }, toolContext);
  const objectBytes = Buffer.byteLength(JSON.stringify(objectSummary), "utf8");
  const objectOk = objectBytes <= 120 * 4;
  console.log(`${objectOk ? "[ok]" : "[FAIL]"} ctx_summarize JSON mode is bounded (${objectBytes} bytes)`);
  if (!objectOk) toolFailures++;
  const invalid = await summarizeTool.handler({ text: "x", mode: "code-ish" }, toolContext);
  const invalidRecord = invalid && typeof invalid === "object" ? invalid as Record<string, unknown> : {};
  const invalidOk = invalidRecord.code === "invalid_summary_mode" && Array.isArray(invalidRecord.allowedModes);
  console.log(`${invalidOk ? "[ok]" : "[FAIL]"} ctx_summarize rejects unknown modes`);
  if (!invalidOk) toolFailures++;
}
console.log(`Tool checks: ${toolFailures === 0 ? "passed" : `${toolFailures} failed`}.`);
process.exit(failed + toolFailures + scopeFailures > 0 ? 1 : 0);
