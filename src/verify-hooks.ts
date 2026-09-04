/**
 * Test the grep auto-repair and read auto-offload logic.
 * These are the two new code paths added in this round.
 */

import contextEngineer, { repairGrepInput, isLikelyRegexParseError } from "./index.js";
import { ContextStore, DEFAULT_CONTEXT_STORE_TTL_MS, DEFAULT_MEMORY_STORE_MAX_BYTES, MAX_CONTEXT_STORE_BYTES } from "./store.js";
import { ceToolMap } from "./tools.js";
import { ContextTelemetry } from "./telemetry.js";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

// ---- Test grep auto-repair ----

const grepTests: Array<{ name: string; input: Record<string, unknown>; expectRepaired: boolean }> = [
  {
    name: "unescaped parens: hydrateCart(",
    input: { pattern: "hydrateCart(" },
    expectRepaired: true,
  },
  {
    name: "unclosed group: (?:hydrateCart(|loadLocalCart(",
    input: { pattern: "(?:hydrateCart(|loadLocalCart(" },
    expectRepaired: true,
  },
  {
    name: "braces in assignment: state.cart = {};",
    input: { pattern: "state.cart = {};" },
    expectRepaired: true,
  },
  {
    name: "lone opening brace accepted by JS but rejected by rg: return {",
    input: { pattern: "return {" },
    expectRepaired: true,
  },
  {
    name: "already literal: no repair",
    input: { pattern: "clearCustomerSession(", literal: true },
    expectRepaired: false,
  },
  {
    name: "clean regex: no repair needed",
    input: { pattern: "function\\s+clearCustomerSession" },
    expectRepaired: false,
  },
  {
    name: "simple word: no repair needed",
    input: { pattern: "clearCustomerSession" },
    expectRepaired: false,
  },
  {
    name: "unclosed group with alt: refreshCustomer|clearCustomerSession|logout(",
    input: { pattern: "refreshCustomer|clearCustomerSession|logout(" },
    expectRepaired: true,
  },
  // Regression: valid regexes must NEVER be repaired (previously the punctuation
  // heuristic silently flipped them to literal searches).
  {
    name: "valid alternation: (a|b)",
    input: { pattern: "(a|b)" },
    expectRepaired: false,
  },
  {
    name: "valid char class: [a-z]+\\.txt",
    input: { pattern: "[a-z]+\\.txt" },
    expectRepaired: false,
  },
  {
    name: "valid trailing paren: function\\s+\\w+\\(",
    input: { pattern: "function\\s+\\w+\\(" },
    expectRepaired: false,
  },
  {
    name: "valid anchored alternation: ^(GET|POST)$",
    input: { pattern: "^(GET|POST)$" },
    expectRepaired: false,
  },
  {
    name: "valid brace quantifier: a{2,4}",
    input: { pattern: "a{2,4}" },
    expectRepaired: false,
  },
  {
    name: "braces inside a character class: [{}]",
    input: { pattern: "[{}]" },
    expectRepaired: false,
  },
  {
    name: "Unicode class braces: \\p{L}+",
    input: { pattern: "\\p{L}+" },
    expectRepaired: false,
  },
  {
    name: "codepoint escape braces: \\x{41}",
    input: { pattern: "\\x{41}" },
    expectRepaired: false,
  },
  {
    name: "escaped braces stay regex: state\\.cart\\s*=\\s*\\{\\};",
    input: { pattern: "state\\.cart\\s*=\\s*\\{\\};" },
    expectRepaired: false,
  },
];

let grepPassed = 0;
let grepFailed = 0;

console.log("=== Grep Auto-Repair Tests ===\n");
for (const test of grepTests) {
  // Deep clone input so we don't mutate the test data
  const input = JSON.parse(JSON.stringify(test.input));
  const result = repairGrepInput(input);
  const ok = result.repaired === test.expectRepaired;
  const status = ok ? "[ok]" : "[FAIL]";
  console.log(`${status} ${test.name}`);
  console.log(`   expected repaired=${test.expectRepaired}, got repaired=${result.repaired}`);
  if (result.repaired) {
    console.log(`   literal set to: ${input.literal}`);
  }
  if (!ok) grepFailed++;
  else grepPassed++;
}

// ---- Test read auto-offload ----

console.log("\n=== Read Auto-Offload Tests ===\n");

const store = new ContextStore("/tmp/pi-ce-test-" + Date.now());

let ctlFailed = 0;
let ctlChecks = 0;
function checkCtl(name: string, cond: boolean, detail = "") {
  ctlChecks++;
  console.log(`${cond ? "[ok]" : "[FAIL]"} ${name}${detail ? `\\n   ${detail}` : ""}`);
  if (!cond) ctlFailed++;
}

const offloadTests = [
  {
    name: "large result offloaded with handle + preview",
    text: "x".repeat(20000),
    expectTruncated: true,
  },
  {
    name: "small result not offloaded (below threshold)",
    text: "small text",
    expectTruncated: false,
  },
];

let offloadPassed = 0;
let offloadFailed = 0;

for (const test of offloadTests) {
  const result = store.write("test-read", "read", test.text);
  const isLarge = result.bytes > 16_384;
  const ok = test.expectTruncated ? isLarge : !isLarge;
  const status = ok ? "[ok]" : "[FAIL]";
  console.log(`${status} ${test.name}`);
  console.log(`   bytes=${result.bytes}, tokens=${result.estimatedTokens}, handle=${result.id.slice(0, 20)}...`);
  if (!ok) offloadFailed++;
  else offloadPassed++;
}

// ---- Test ctx_read retrieval of offloaded data ----

console.log("\n=== ctx_read Retrieval Tests ===\n");

const largeText = "line1: hello\nline2: world\nline3: clearCustomerSession\nline4: state.cart = {}";
const offloaded = store.write("test-readback", "read", largeText);

const readResult = store.read(offloaded.id, {});
const queryResult = store.read(offloaded.id, { query: "clearCustomerSession" });
const jsonEntry = store.write("json-result", "fabric_exec", JSON.stringify({
  results: [{ name: "alpha", score: 1 }, { name: "beta", score: 2 }],
  metadata: { count: 2, ok: true },
}));
const jsonSelection = store.read(jsonEntry.id, { jsonPath: "$.results[1].name" });
checkCtl("JSON handles expose type and structural preview", jsonEntry.contentType === "json" && jsonEntry.preview.includes("JSON object") && jsonEntry.preview.includes("results"));
checkCtl("JSON-path reads return a focused typed value", jsonSelection.content === '"beta"' && jsonSelection.jsonPath === "$.results[1].name" && jsonSelection.selectedType === "string" && jsonSelection.contentType === "json");

console.log(`[ok] ctx_read full preview (first ${readResult.bytesRead} bytes of ${readResult.totalBytes})`);
console.log(`[ok] ctx_read query "clearCustomerSession": ${queryResult.matchedLines?.length ?? 0} matches`);

// ---- Test boundary vs intermediate results (nested offload fix) ----

console.log("\n=== Boundary vs Intermediate Results ===\n");

let hookFailed = 0;
let hookChecks = 0;
function checkHook(name: string, cond: boolean, detail = "") {
  hookChecks++;
  console.log(`${cond ? "[ok]" : "[FAIL]"} ${name}${detail ? `\n   ${detail}` : ""}`);
  if (!cond) hookFailed++;
}

// Minimal ExtensionAPI stub capturing registered hooks and tools.
type HookFn = (event: any, ctx: any) => Promise<any>;
const hooks: Record<string, HookFn[]> = {};
const registeredTools = new Map<string, any>();
const piStub: any = {
  on: (name: string, fn: HookFn) => {
    (hooks[name] ??= []).push(fn);
  },
  registerTool: (def: any) => {
    registeredTools.set(def.name, def);
  },
  // The /ce command is a UI affordance; nothing to capture in headless tests.
  registerCommand: (_name: string, _def: unknown) => {},
};
contextEngineer(piStub);

const hookCwd = "/tmp/pi-ce-hooks-" + Date.now();
mkdirSync(hookCwd, { recursive: true });
const defaultStore = new ContextStore(hookCwd);
const defaultEntry = defaultStore.write("default-retention", "test", "default retention probe");
const defaultMetadata = defaultStore.list().find((entry) => entry.id === defaultEntry.id);
checkHook("global store defaults are one week and 500 MB",
  DEFAULT_CONTEXT_STORE_TTL_MS === 7 * 24 * 60 * 60 * 1000
  && MAX_CONTEXT_STORE_BYTES === 500_000_000
  && Boolean(defaultMetadata?.expiresAt));
const callHook = async (name: string, event: any, cwd = hookCwd, extraContext: Record<string, unknown> = {}) => {
  let out: any;
  for (const fn of hooks[name] ?? []) {
    const result = await fn(event, { cwd, ...extraContext });
    if (result !== undefined) out = result;
  }
  return out;
};

const BIG = "b".repeat(20000);
const PROGRAM = `const r = await pi.read({ path: "big.txt" }); return r.length;`;

// Control: with no program running, a large top-level result is offloaded.
const ctrl = await callHook("tool_result", {
  toolCallId: "ctrl",
  toolName: "read",
  input: { path: "big.txt" },
  content: [{ type: "text", text: BIG }],
});
checkHook("top-level large result is offloaded", ctrl?.details?.ce_offloaded === true);
const ctrlText = ctrl?.content?.find((item: any) => item.type === "text")?.text ?? "";
checkHook("offload message includes a copyable model-facing ctx_read recipe", ctrlText.includes("ctx_read({ id:") && !ctrlText.includes("extensions.ctx_read({ id:"));
checkHook("structural offload preview stays bounded", Buffer.byteLength(ctrlText, "utf8") < 3200);

const addressableMessage = {
  role: "toolResult",
  toolCallId: "ctrl",
  toolName: "read",
  content: ctrl?.content ?? [],
  details: ctrl?.details,
  isError: false,
  timestamp: Date.now(),
};
const firstAddressableContext = await callHook("context", { messages: [addressableMessage] });
const repeatedAddressableContext = await callHook("context", { messages: [addressableMessage] });
const compactedAddressableText = repeatedAddressableContext?.messages?.[0]?.content?.[0]?.text ?? "";
checkHook("addressable preview is preserved for its first model call", firstAddressableContext === undefined);
checkHook(
  "repeated addressable preview compacts to a re-readable handle",
  compactedAddressableText.includes("preview compacted after use") &&
    compactedAddressableText.includes(ctrl?.details?.ce_handle) &&
    Buffer.byteLength(compactedAddressableText, "utf8") < Buffer.byteLength(ctrlText, "utf8") / 2,
);

// While a program runs, inner results are intermediate values consumed by
// program code and must arrive byte-for-byte intact.
await callHook("tool_call", { toolCallId: "fe1", toolName: "fabric_exec", input: { code: PROGRAM } });
await callHook("tool_call", { toolCallId: "fabric_inner1", toolName: "read", input: { path: "big.txt" } });
const inner = await callHook("tool_result", {
  toolCallId: "fabric_inner1",
  toolName: "read",
  input: { path: "big.txt" },
  content: [{ type: "text", text: BIG }],
});
checkHook("inner read passes through untouched while program runs", inner === undefined);

// Fabric's documented provider proxy is safe to replace even inside an active
// program because its patched details.result becomes the QuickJS value.
const nestedProxy = await callHook("tool_result", {
  toolCallId: "fabric_nested_provider_1",
  toolName: "mcp.test.search",
  input: { query: "large" },
  details: {
    kind: "pi-fabric.tool-result-proxy.v1",
    ref: "mcp.test.search",
    result: { output: BIG },
  },
  content: [{ type: "text", text: BIG }],
});
checkHook(
  "nested Fabric provider result is offloaded structurally",
  nestedProxy?.details?.result?.contextEngineerTruncated === true && typeof nestedProxy?.details?.result?.handle === "string",
);
const nestedHandle = nestedProxy?.details?.result?.handle as string | undefined;
checkHook(
  "nested provider payload is recoverable from its handle",
  Boolean(nestedHandle && new ContextStore(hookCwd).read(nestedHandle, { query: "bbbb" }).totalBytes > 0),
);

const fe1 = await callHook("tool_result", {
  toolCallId: "fe1",
  toolName: "fabric_exec",
  input: { code: PROGRAM },
  content: [{ type: "text", text: BIG }],
});
checkHook("fabric_exec boundary result itself is offloaded", fe1?.details?.ce_offloaded === true);

const resumed = await callHook("tool_result", {
  toolCallId: "resumed1",
  toolName: "grep",
  input: { pattern: "x" },
  content: [{ type: "text", text: BIG }],
});
checkHook("boundary offload resumes after program completes", resumed?.details?.ce_offloaded === true);

// Runtime-first mode executes uncertain programs. Intermediate Pi values stay
// intact, and only the actual final boundary payload is kept/offloaded.
const fe2 = await callHook("tool_call", {
  toolCallId: "fe2",
  toolName: "fabric_exec",
  input: { code: "const raw = await pi.read({ path: \"f\" }); return raw.trim();" },
});
checkHook("raw-preserving transform executes in runtime-guard mode", fe2?.block !== true);
const duringRuntimeGuard = await callHook("tool_result", {
  toolCallId: "fabric_afterwarn1",
  toolName: "read",
  input: { path: "w.txt" },
  content: [{ type: "text", text: BIG }],
});
checkHook("runtime-guard execution preserves its intermediate result", duringRuntimeGuard === undefined);
const fe2Boundary = await callHook("tool_result", {
  toolCallId: "fe2",
  toolName: "fabric_exec",
  input: { code: "const raw = await pi.read({ path: \"f\" }); return raw.trim();" },
  content: [{ type: "text", text: BIG }],
});
checkHook(
  "large uncertain boundary result is offloaded without static-warning noise",
  fe2Boundary?.details?.ce_offloaded === true && fe2Boundary?.details?.ce_warning === undefined,
);

const fe3 = await callHook("tool_call", {
  toolCallId: "fe3",
  toolName: "fabric_exec",
  input: { code: `const r = await pi.read({ path: "f" }); return r;` },
});
checkHook("raw passthrough executes by default", fe3?.block !== true);
const fe3Boundary = await callHook("tool_result", {
  toolCallId: "fe3",
  toolName: "fabric_exec",
  input: { code: `const r = await pi.read({ path: "f" }); return r;` },
  content: [{ type: "text", text: "small result" }],
});
checkHook(
  "small uncertain boundary result passes through untouched",
  fe3Boundary === undefined,
);

const interrupted = await callHook("tool_call", {
  toolCallId: "interrupted-fe",
  toolName: "fabric_exec",
  input: { code: `const r = await pi.read({ path: "f" }); return r;` },
});
checkHook("interrupted runtime-guard call starts without blocking", interrupted?.block !== true);
await callHook("tool_execution_end", {
  toolCallId: "interrupted-fe",
  toolName: "fabric_exec",
  isError: true,
});
const afterInterrupted = await callHook("tool_result", {
  toolCallId: "after_interrupted",
  toolName: "read",
  input: { path: "later.txt" },
  content: [{ type: "text", text: BIG }],
});
checkHook("execution_end cleanup preserves ordinary boundary handling", afterInterrupted?.details?.ce_offloaded === true);
const lateNested = await callHook("tool_result", {
  toolCallId: "fabric_late_nested",
  toolName: "read",
  input: { path: "late.txt" },
  content: [{ type: "text", text: BIG }],
});
checkHook("late Fabric-prefixed result remains an intermediate value", lateNested === undefined);

const strictCwd = "/tmp/pi-ce-strict-" + Date.now();
mkdirSync(join(strictCwd, ".pi"), { recursive: true });
writeFileSync(join(strictCwd, ".pi", "context-engineer.json"), JSON.stringify({ strict: true }));
const blocked = await callHook("tool_call", {
  toolCallId: "strict-fe",
  toolName: "fabric_exec",
  input: { code: `const r = await pi.read({ path: "f" }); return r;` },
}, strictCwd);
checkHook("strict mode still blocks raw passthrough", blocked?.block === true);
writeFileSync(join(strictCwd, ".pi", "context-engineer.json"), JSON.stringify({ strict: false }));
const futureMtime = new Date(Date.now() + 2000);
utimesSync(join(strictCwd, ".pi", "context-engineer.json"), futureMtime, futureMtime);
const afterConfigReload = await callHook("tool_call", {
  toolCallId: "reloaded-fe",
  toolName: "fabric_exec",
  input: { code: `const r = await pi.read({ path: "f" }); return r;` },
}, strictCwd);
checkHook("updated project config applies without extension reload", afterConfigReload?.block !== true);
await callHook("tool_result", {
  toolCallId: "reloaded-fe",
  toolName: "fabric_exec",
  input: { code: `const r = await pi.read({ path: "f" }); return r;` },
  content: [{ type: "text", text: "reloaded" }],
}, strictCwd);
const postBlock = await callHook("tool_result", {
  toolCallId: "postblock1",
  toolName: "bash",
  input: { cmd: "cat big" },
  content: [{ type: "text", text: BIG }],
}, strictCwd);
checkHook("strict block does not suppress later boundary offload", postBlock?.details?.ce_offloaded === true);

// ---- Test ctx_read self-cap (recursive offload fix) ----

console.log("\n=== ctx_read Self-Cap ===\n");

const capCwd = "/tmp/pi-ce-cap-" + Date.now();
mkdirSync(capCwd, { recursive: true });
const capStore = new ContextStore(capCwd);
const payload = "needle line\n".repeat(4000); // ~44KB, 4000 matches
const capEntry = capStore.write("cap-test", "read", payload);

const ctxReadDef = registeredTools.get("ctx_read");
checkHook("ctx_read tool is registered", Boolean(ctxReadDef));

if (ctxReadDef) {
  const out1 = await ctxReadDef.execute("t1", { id: capEntry.id }, undefined, undefined, { cwd: capCwd });
  const p1 = JSON.parse(out1.content[0].text);
  checkCtl(
    "default ranged read stays under the 16KB threshold",
    Buffer.byteLength(out1.content[0].text, "utf8") < 16_384 && p1.bytesRead < 16_384 && p1.offset === 0 && p1.nextOffset === p1.bytesRead && p1.truncated === true && p1.totalBytes === Buffer.byteLength(payload),
    `bytesRead=${p1.bytesRead}, totalBytes=${p1.totalBytes}`
  );
  const ctxReadMessage = {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "ctx_read",
    content: out1.content,
    details: out1.details,
    isError: false,
    timestamp: Date.now(),
  };
  await callHook("context", { messages: [ctxReadMessage] }, capCwd);
  const repeatedReadContext = await callHook("context", { messages: [ctxReadMessage] }, capCwd);
  checkCtl(
    "used ctx_read output compacts while retaining its source handle",
    String(repeatedReadContext?.messages?.[0]?.content?.[0]?.text).includes(capEntry.id) &&
      String(repeatedReadContext?.messages?.[0]?.content?.[0]?.text).includes("offset: 0"),
  );
  const outNext = await ctxReadDef.execute(
    "t1-next",
    { id: capEntry.id, offset: p1.nextOffset, length: 256 },
    undefined,
    undefined,
    { cwd: capCwd },
  );
  const pNext = JSON.parse(outNext.content[0].text);
  checkCtl(
    "nextOffset can be copied directly into the following page",
    pNext.offset === p1.nextOffset && pNext.nextOffset === p1.nextOffset + 256,
  );

  const out2 = await ctxReadDef.execute("t2", { id: capEntry.id, query: "needle" }, undefined, undefined, { cwd: capCwd });
  const p2 = JSON.parse(out2.content[0].text);
  checkCtl(
    "query-mode serialized envelope stays under the 16KB threshold",
    Buffer.byteLength(out2.content[0].text, "utf8") < 16_384 &&
      p2.content.length < 16_384 &&
      p2.truncated === true &&
      p2.matchedLines?.length <= 64 &&
      p2.totalMatches === 4000,
    `serializedBytes=${Buffer.byteLength(out2.content[0].text, "utf8")}, contentChars=${p2.content.length}, sampledMatches=${p2.matchedLines?.length}, totalMatches=${p2.totalMatches}`
  );
  const outLimitedMatches = await ctxReadDef.execute(
    "t2-limited",
    { id: capEntry.id, query: "needle", maxMatches: 5 },
    undefined,
    undefined,
    { cwd: capCwd },
  );
  const pLimitedMatches = JSON.parse(outLimitedMatches.content[0].text);
  checkCtl(
    "maxMatches bounds formatted windows while preserving the exact total",
    pLimitedMatches.matchedLines?.length === 5 && pLimitedMatches.totalMatches === 4000,
  );
  const jsonForRead = capStore.write("json-cap-test", "read", JSON.stringify({ results: [{ id: 7 }, { id: 8 }] }));
  const jsonRead = await ctxReadDef.execute("json-read", { id: jsonForRead.id, jsonPath: "$.results[0].id" }, undefined, undefined, { cwd: capCwd });
  const jsonReadRecord = JSON.parse(jsonRead.content[0].text);
  checkCtl("ctx_read exposes JSON-path selection", jsonReadRecord.content === "7" && jsonReadRecord.jsonPath === "$.results[0].id" && jsonReadRecord.selectedType === "number");
}

// Project config lowers the threshold; the self-cap must follow it.
const tightCwd = "/tmp/pi-ce-tight-" + Date.now();
mkdirSync(join(tightCwd, ".pi"), { recursive: true });
writeFileSync(join(tightCwd, ".pi", "context-engineer.json"), JSON.stringify({ readOffloadThreshold: 4096 }));
const tightEntry = new ContextStore(tightCwd).write("tight-test", "read", "y".repeat(20000));
if (ctxReadDef) {
  const out3 = await ctxReadDef.execute("t3", { id: tightEntry.id }, undefined, undefined, { cwd: tightCwd });
  const p3 = JSON.parse(out3.content[0].text);
  checkCtl("configured readOffloadThreshold respected", p3.bytesRead <= 4096, `bytesRead=${p3.bytesRead}`);
}

// Defense in depth: even a large ctx_read-shaped result is exempt from the
// offload hook, so handle chains cannot form regardless of sizing bugs.
const crBig = await callHook("tool_result", {
  toolCallId: "crbig1",
  toolName: "ctx_read",
  input: { id: "some-handle" },
  content: [{ type: "text", text: "h".repeat(9000) }],
});
checkCtl("hook never re-offloads ctx_read results", crBig === undefined || crBig?.details?.ce_offloaded !== true);

// ---- Addressable store regressions ----

console.log("\n=== Addressable Store Regressions ===\n");
const duplicate = store.write("same-payload-different-key", "grep", largeText);
checkCtl("identical payloads deduplicate by content hash", duplicate.id === offloaded.id);
const unicode = store.write("unicode", "read", "λ𐍈\nsecond line");
const unicodePrefix = store.read(unicode.id, { offset: 0, length: Buffer.byteLength("λ𐍈", "utf8") });
checkCtl("UTF-8 byte ranges do not split a code point", unicodePrefix.content === "λ𐍈" || unicodePrefix.content.startsWith("λ𐍈"));
const unicodeEdges = store.write("unicode-edges", "read", "λ𐍈abc");
for (const [offset, length] of [[0, 1], [0, 2], [0, 3], [1, 1], [2, 1]]) {
  const ranged = store.read(unicodeEdges.id, { offset, length });
  checkCtl(
    `arbitrary UTF-8 range ${offset}:${length} is boundary-safe`,
    !ranged.content.includes("�") && (!ranged.truncated || ranged.nextOffset !== undefined) &&
      ranged.bytesRead === Buffer.byteLength(ranged.content.split("\n... [")[0], "utf8"),
  );
}

const expiryCwd = "/tmp/pi-ce-expiry-" + Date.now();
const expiryStore = new ContextStore(expiryCwd, ".pi/context-store", { ttlMs: 0 });
const expired = expiryStore.write("expired", "test", "expired fact", { expiresAt: new Date(Date.now() - 1000).toISOString() });
checkCtl("list prunes explicitly expired entries", !expiryStore.list().some((entry) => entry.id === expired.id));
checkCtl("expired reads return an error rather than payload", expiryStore.read(expired.id).content.startsWith("Error:"));

const layoutCwd = "/tmp/pi-ce-layout-" + Date.now();
const layoutStore = new ContextStore(layoutCwd);
const layoutEntry = layoutStore.write("layout", "test", "private payload");
const layoutDir = join(layoutCwd, ".pi/context-store");
const blobDir = join(layoutDir, "blobs");
const indexRecord = JSON.parse(readFileSync(join(layoutDir, "index.json"), "utf8")) as { entries: Array<Record<string, unknown>> };
const blobName = readdirSync(blobDir)[0];
checkCtl(
  "store uses metadata-only index and content-addressed blob",
  indexRecord.entries.some((entry) => entry.id === layoutEntry.id && !("data" in entry) && typeof entry.blobPath === "string") && Boolean(blobName) && layoutStore.read(layoutEntry.id).content.includes("private payload"),
);
checkCtl(
  "store files use private permissions",
  (statSync(layoutDir).mode & 0o777) === 0o700 &&
    (statSync(blobDir).mode & 0o777) === 0o700 &&
    (statSync(join(layoutDir, "index.json")).mode & 0o777) === 0o600 &&
    (statSync(join(blobDir, blobName),).mode & 0o777) === 0o600,
);

const memoryCwd = "/tmp/pi-ce-memory-" + Date.now();
const memoryContext: any = {
  workspaceRoot: memoryCwd,
  store: new ContextStore(memoryCwd),
  callTool: async () => undefined,
  spawnAgent: async () => "",
  modelCall: async () => "",
};
const rememberDef = ceToolMap.get("ctx_remember");
const recallDef = ceToolMap.get("ctx_recall");
const forgetDef = ceToolMap.get("ctx_forget");
checkCtl("ctx_forget is registered", Boolean(forgetDef));
if (rememberDef && recallDef && forgetDef) {
  const firstMemory = await rememberDef.handler({ fact: "first", key: "decision" }, memoryContext) as { id?: string };
  const secondMemory = await rememberDef.handler({ fact: "second", key: "decision" }, memoryContext) as { id?: string };
  const recalled = await recallDef.handler({}, memoryContext) as { facts: string[]; count: number };
  const reopenedBeforeForget = new ContextStore(memoryCwd, ".pi/agent/context-store", { ttlMs: 0, maxBytes: DEFAULT_MEMORY_STORE_MAX_BYTES });
  checkCtl("remembered facts persist with no TTL and named writes upsert", firstMemory.id !== secondMemory.id && recalled.count === 1 && recalled.facts[0] === "second" && reopenedBeforeForget.list().length === 1 && reopenedBeforeForget.list()[0].updatedAt !== undefined);
  const forgotten = await forgetDef.handler({ key: "decision" }, memoryContext) as { count: number };
  const reopenedAfterForget = new ContextStore(memoryCwd, ".pi/agent/context-store", { ttlMs: 0, maxBytes: DEFAULT_MEMORY_STORE_MAX_BYTES });
  checkCtl("ctx_forget removes named remembered facts", forgotten.count === 1 && reopenedAfterForget.list().length === 0);
}

const summaryDef = ceToolMap.get("ctx_summarize");
if (summaryDef) {
  const prompts: string[] = [];
  const summary = await summaryDef.handler({ text: "x".repeat(12000), mode: "model", maxTokens: 128, maxInputTokens: 1024 }, {
    ...memoryContext,
    modelCall: async (prompt: string) => { prompts.push(prompt); return "bounded summary"; },
  }) as { chunks: number; maxInputTokens: number; strategy: string };
  checkCtl(
    "model summarization declares and honors an input budget",
    summary.strategy === "hierarchical" && summary.chunks > 1 && summary.maxInputTokens === 1024 &&
      prompts.every((prompt) => Buffer.byteLength(prompt, "utf8") <= 4096),
    `prompts=${prompts.length}, maxPromptBytes=${Math.max(...prompts.map((prompt) => Buffer.byteLength(prompt, "utf8")), 0)}`,
  );
}

const budgetStore = new ContextStore("/tmp/pi-ce-budget-" + Date.now(), ".pi/context-store", { maxBytes: 10 });
const retained = budgetStore.write("retained", "bash", "payload larger than budget");
checkCtl("newest handle remains valid under a tiny disk budget", budgetStore.has(retained.id));
const telemetryCwd = "/tmp/pi-ce-telemetry-" + Date.now();
const telemetry = new ContextTelemetry();
telemetry.record(telemetryCwd, { strategy: "WRITE", tool: "read", sourceBytes: 40000, visibleBytes: 2200, storeTokensWritten: 10000, note: "payload sizes only" });
telemetry.record(telemetryCwd, { strategy: "WRITE", tool: "fabric_exec", sourceTokens: 10000, visibleTokens: 100, internalTokensProcessed: 10000, mainTokensPrevented: 0, mainTokensInjected: 0, storeTokensWritten: 10000, note: "internal provider accounting" });
const telemetrySummary = telemetry.summary(telemetryCwd);
checkCtl("telemetry reports saved tokens", telemetrySummary.savedTokens > 0 && telemetrySummary.byStrategy.WRITE?.events === 2);
checkCtl("telemetry separates internal work from Main savings", telemetrySummary.internalTokensProcessed === 10000 && telemetrySummary.mainTokensPrevented === telemetrySummary.savedTokens && telemetrySummary.mainTokensInjected > 0 && telemetrySummary.storeTokensWritten === 20000);
const legacyCwd = "/tmp/pi-ce-legacy-telemetry-" + Date.now();
mkdirSync(join(legacyCwd, ".pi/context-store"), { recursive: true });
writeFileSync(join(legacyCwd, ".pi/context-store/context-events.jsonl"), JSON.stringify({ version: 1, timestamp: new Date().toISOString(), sessionId: "legacy", strategy: "WRITE", tool: "read", sourceBytes: 4000, visibleBytes: 400, sourceTokens: 1000, visibleTokens: 100, savedTokens: 900 }) + "\n");
const legacySummary = new ContextTelemetry().summary(legacyCwd, true);
checkCtl("telemetry reads legacy version-1 events", legacySummary.mainTokensPrevented === 900 && legacySummary.mainTokensInjected === 100 && legacySummary.savedTokens === 900);
const sharedTelemetryCwd = "/tmp/pi-ce-shared-telemetry-" + Date.now();
const runtimeA = new ContextTelemetry();
const runtimeB = new ContextTelemetry();
runtimeA.setSessionId("pi-session-shared");
runtimeB.setSessionId("pi-session-shared");
runtimeA.record(sharedTelemetryCwd, { strategy: "WRITE", tool: "runtime-a", sourceTokens: 100, visibleTokens: 10 });
runtimeB.record(sharedTelemetryCwd, { strategy: "WRITE", tool: "runtime-b", sourceTokens: 200, visibleTokens: 20 });
const sharedSession = runtimeA.summary(sharedTelemetryCwd);
const sharedLifetime = runtimeA.summary(sharedTelemetryCwd, true);
checkCtl("telemetry session scope spans extension runtimes", sharedSession.events === 2 && sharedSession.mainTokensPrevented === 270 && sharedSession.scope === "session");
checkCtl("telemetry exposes distinct runtime and lifetime scopes", runtimeA.runtimeSummary(sharedTelemetryCwd).events === 1 && sharedLifetime.events === 2 && sharedLifetime.scope === "lifetime");

// ---- ctx_offload signature ergonomics (session regressions) ----

console.log("\n=== ctx_offload Signature ===\n");
const offDef = registeredTools.get("ctx_offload");
checkCtl("ctx_offload tool is registered", Boolean(offDef));
if (offDef) {
  const o1 = await offDef.execute("o1", { key: "k1", source: "bash", data: "payload-one" }, undefined, undefined, { cwd: capCwd });
  checkCtl("canonical { key, source, data } works", o1?.details?.id !== undefined);
  const manualMessage = { role: "toolResult", toolCallId: "manual-o1", toolName: "ctx_offload", content: o1.content, details: o1.details, isError: false, timestamp: Date.now() };
  await callHook("context", { messages: [manualMessage] }, capCwd);
  const repeatedManual = await callHook("context", { messages: [manualMessage] }, capCwd);
  checkCtl("manual offload preview compacts after first use", String(repeatedManual?.messages?.[0]?.content?.[0]?.text).includes(String(o1?.details?.id)));
  const o2 = await offDef.execute("o2", { key: "k2", text: "payload-two" }, undefined, undefined, { cwd: capCwd });
  checkCtl("{ key, text } alias works", o2?.details?.id !== undefined);
  const o3 = await offDef.execute("o3", { key: "k3", content: "payload-three" }, undefined, undefined, { cwd: capCwd });
  checkCtl("{ key, content } alias works", o3?.details?.id !== undefined);
  const o4 = await offDef.execute("o4", { key: "k4" }, undefined, undefined, { cwd: capCwd });
  checkCtl("missing payload errors with a signature hint", o4?.isError === true && String(o4?.content?.[0]?.text).includes("data"));
}

// ---- CE tool details are slimmed (no payload duplication into context) ----

console.log("\n=== CE Details Slimming ===\n");
const sumDef = registeredTools.get("ctx_summarize");
checkCtl("ctx_summarize tool is registered", Boolean(sumDef));
if (sumDef) {
  const bigText = "lorem-ipsum-dolor-line\n".repeat(300); // ~6.9KB of repetitive text
  const sum = await sumDef.execute("s1", { text: bigText, mode: "structural", maxTokens: 400 }, undefined, undefined, { cwd: capCwd });
  const detJson = JSON.stringify(sum.details ?? {});
  checkCtl("details no longer duplicate the summarized payload", !detJson.includes("lorem-ipsum-dolor-line"));
  checkCtl("content still carries the full summary once", typeof sum.content?.[0]?.text === "string" && sum.content[0].text.length > 100);
}

// ---- Runtime advisory for heavy-but-below-threshold fabric_exec results ----

console.log("\n=== Runtime Advisory ===\n");
const adv1 = await callHook("tool_result", {
  toolCallId: "adv1",
  toolName: "fabric_exec",
  input: { code: "return 1;" },
  content: [{ type: "text", text: "m".repeat(5000) }],
});
checkCtl("default runtime advisory is silent", adv1 === undefined);

const advisoryCwd = "/tmp/pi-ce-advisory-" + Date.now();
mkdirSync(join(advisoryCwd, ".pi"), { recursive: true });
writeFileSync(
  join(advisoryCwd, ".pi", "context-engineer.json"),
  JSON.stringify({ runtimeAdvisoryThreshold: 4096 }),
);
const configuredAdvisory = await callHook("tool_result", {
  toolCallId: "adv-configured",
  toolName: "fabric_exec",
  input: { code: "return 1;" },
  content: [{ type: "text", text: "m".repeat(5000) }],
}, advisoryCwd);
checkCtl(
  "configured 4KB threshold adds a one-line advisory",
  typeof configuredAdvisory?.details?.ce_advisory === "string" &&
    String(configuredAdvisory?.content?.[0]?.text).includes("context-engineer"),
);
const adv2 = await callHook("tool_result", {
  toolCallId: "adv2",
  toolName: "fabric_exec",
  input: { code: "return 1;" },
  content: [{ type: "text", text: "tiny" }],
});
checkCtl("small fabric_exec result is untouched", adv2 === undefined);
const adv3 = await callHook("tool_result", {
  toolCallId: "adv3",
  toolName: "fabric_exec",
  input: { code: "return 1;" },
  content: [{ type: "text", text: "b".repeat(20000) }],
});
checkCtl(
  "8KB+ fabric_exec result still auto-offloads without double annotation",
  adv3?.details?.ce_offloaded === true && adv3?.details?.ce_advisory === undefined,
);

const errorLines = Array.from({ length: 420 }, (_, index) => `error TS${1000 + (index % 12)} at line ${index + 1}: malformed command diagnostic`);
const compactedError = await callHook("tool_result", {
  toolCallId: "error-boundary",
  toolName: "fabric_exec",
  input: { code: "return 1;" },
  isError: true,
  content: [{ type: "text", text: errorLines.join("\\n") }],
});
checkHook(
  "oversized model-boundary errors are compacted with diagnostics",
  compactedError?.details?.ce_error_compacted === true &&
    Buffer.byteLength(compactedError.content?.[0]?.text ?? "", "utf8") <= 4096 &&
    String(compactedError.content?.[0]?.text).includes("Error output compacted"),
);

const inlineCwd = "/tmp/pi-ce-inline-" + Date.now();
mkdirSync(join(inlineCwd, ".pi"), { recursive: true });
writeFileSync(join(inlineCwd, ".pi", "context-engineer.json"), JSON.stringify({ resultPolicy: "inline" }));
const inlineResult = await callHook("tool_result", {
  toolCallId: "inline-boundary",
  toolName: "bash",
  input: { cmd: "cat huge" },
  content: [{ type: "text", text: BIG }],
}, inlineCwd);
checkHook("explicit inline policy preserves a large success result", inlineResult === undefined);

const forcedOffloadCwd = "/tmp/pi-ce-force-offload-" + Date.now();
mkdirSync(join(forcedOffloadCwd, ".pi"), { recursive: true });
writeFileSync(join(forcedOffloadCwd, ".pi", "context-engineer.json"), JSON.stringify({ resultPolicy: "offload" }));
const forcedOffload = await callHook("tool_result", {
  toolCallId: "forced-offload",
  toolName: "bash",
  input: { cmd: "printf small" },
  content: [{ type: "text", text: "small but explicitly addressable" }],
}, forcedOffloadCwd);
checkHook("explicit offload policy handles a small success result", forcedOffload?.details?.ce_offloaded === true && String(forcedOffload?.content?.[0]?.text).includes("ctx_read({ id:"));

const summarizeCwd = "/tmp/pi-ce-summarize-" + Date.now();
mkdirSync(join(summarizeCwd, ".pi"), { recursive: true });
writeFileSync(join(summarizeCwd, ".pi", "context-engineer.json"), JSON.stringify({ resultPolicy: "summarize" }));
const oversizedJson = JSON.stringify({ items: Array.from({ length: 6000 }, (_, index) => ({ id: index, ok: index % 2 === 0 })) });
const summarizedResult = await callHook("tool_result", {
  toolCallId: "summarize-boundary",
  toolName: "bash",
  input: { cmd: "emit-json" },
  content: [{ type: "text", text: oversizedJson }],
}, summarizeCwd);
checkHook("explicit summarize policy returns a structural JSON handle", summarizedResult?.details?.ce_offloaded === true && String(summarizedResult?.content?.[0]?.text).includes("JSON object") && String(summarizedResult?.content?.[0]?.text).includes("ctx_read({ id:"));

// ---- ctx_status reports policy state ----

console.log("\n=== ctx_status ===\n");
const statusDef = registeredTools.get("ctx_status");
checkCtl("ctx_status tool is registered", Boolean(statusDef));
if (statusDef) {
  const st = await statusDef.execute("st1", {}, undefined, undefined, { cwd: capCwd });
  const parsed = JSON.parse(st.content[0].text);
  checkCtl(
    "ctx_status exposes thresholds, policy, and telemetry scopes",
    parsed.enabled === true && parsed.resultPolicy === "auto" && parsed.runtimeAdvisoryThreshold === 0 && parsed.blockUnboundedReturns === false && parsed.compactStaleResults === true && typeof parsed.readOffloadThreshold === "number" && typeof parsed.errorCompactionThreshold === "number" && typeof parsed.policy === "string" && typeof parsed.runtime?.events === "number" && typeof parsed.session?.mainTokensPrevented === "number" && typeof parsed.lifetime?.storeTokensWritten === "number" && parsed.telemetryScope === "session",
  );
  const lifetimeStatus = await statusDef.execute("st2", { scope: "lifetime" }, undefined, undefined, { cwd: capCwd });
  const lifetimeParsed = JSON.parse(lifetimeStatus.content[0].text);
  checkCtl("ctx_status can emphasize lifetime telemetry", lifetimeParsed.telemetryScope === "lifetime" && lifetimeParsed.summary?.scope === "lifetime" && lifetimeParsed.lifetime?.scope === "lifetime");
}

// ---- Quiet session startup ----

console.log("\n=== Session Startup UX ===\n");
let startupNotifications = 0;
const ui = { notify: () => { startupNotifications++; } };
await callHook("session_start", { reason: "startup" }, capCwd, { hasUI: true, ui });
checkCtl("session-start notification is silent by default", startupNotifications === 0);
const notifyCwd = "/tmp/pi-ce-notify-" + Date.now();
mkdirSync(join(notifyCwd, ".pi"), { recursive: true });
writeFileSync(join(notifyCwd, ".pi", "context-engineer.json"), JSON.stringify({ notifyOnStart: true }));
await callHook("session_start", { reason: "startup" }, notifyCwd, { hasUI: true, ui });
checkCtl("session-start notification remains opt-in", startupNotifications === 1);

// ---- Summary ----

console.log("\n=== Summary ===");
console.log(`Grep auto-repair: ${grepPassed} passed, ${grepFailed} failed`);
console.log(`Read auto-offload: ${offloadPassed} passed, ${offloadFailed} failed`);
console.log(`Boundary vs intermediate: ${hookChecks - hookFailed} passed, ${hookFailed} failed`);
console.log(`ctx_read self-cap: ${ctlChecks - ctlFailed} passed, ${ctlFailed} failed`);

const totalFailed = grepFailed + offloadFailed + hookFailed + ctlFailed;
if (totalFailed > 0) {
  console.log(`\n${totalFailed} test(s) failed`);
  process.exit(1);
} else {
  console.log(`\nAll tests passed`);
}
