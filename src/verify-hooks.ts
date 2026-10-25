/**
 * Verify model-boundary offloading, prefix stability, helper tools and telemetry.
 * Runtime safety and child cancellation have dedicated integration regressions.
 */

import contextEngineer from "./index.js";
import { ContextStore, DEFAULT_CONTEXT_STORE_TTL_MS, MAX_CONTEXT_STORE_BYTES } from "./store.js";
import { ceToolMap } from "./tools.js";
import { ContextTelemetry } from "./telemetry.js";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { editJson, editYaml } from "./verify-preview.js";

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
const registeredCommands = new Map<string, any>();
const piStub: any = {
  on: (name: string, fn: HookFn) => {
    (hooks[name] ??= []).push(fn);
  },
  registerTool: (def: any) => {
    registeredTools.set(def.name, def);
  },
  registerCommand: (name: string, def: any) => registeredCommands.set(name, def),
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
    if (result !== undefined) {
      out = { ...out, ...result };
      if (name === "tool_result") event = { ...event, ...result };
    }
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
const fabricRecipe = await callHook("tool_result", { toolCallId: "recipe-parent", toolName: "fabric_exec", input: {}, content: [{ type: "text", text: BIG }] });
checkHook("Fabric boundary recovery uses the available extensions namespace", String(fabricRecipe?.content?.[0]?.text).includes("extensions.ctx_read({ id:"));
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
// Once a result reaches Main, later requests must retain the same prefix.
// Shortening a previously exposed preview invalidates provider prompt caches.
async function checkStableContextPrefix(label: string, messages: any[], cwd = hookCwd) {
  const snapshot = JSON.stringify(messages);
  const continuations = [
    [], // first exposure
    [], // retry / repeated context event
    [{ role: "assistant", content: [{ type: "text", text: "Continue inspecting." }], timestamp: 1 }],
    [{ role: "user", content: [{ type: "text", text: "Inspect another branch." }], timestamp: 2 }],
    [], // return to the original branch
  ];
  for (const [index, tail] of continuations.entries()) {
    const input = structuredClone([...messages, ...tail]);
    const before = JSON.stringify(input);
    const result = await callHook("context", { messages: input }, cwd);
    const visible = result?.messages ?? input;
    checkHook(`${label}: stable model prefix on request ${index + 1}`,
      JSON.stringify(visible.slice(0, messages.length)) === snapshot &&
      JSON.stringify(visible) === before && JSON.stringify(input) === before);
  }
  checkHook(`${label}: session history remains unchanged`, JSON.stringify(messages) === snapshot);
}
await checkStableContextPrefix("automatic offload preview", [addressableMessage]);
await callHook("session_start", {});
await checkStableContextPrefix("resumed offload preview", [addressableMessage]);
checkHook("CE does not install a historical context rewrite hook", (hooks.context?.length ?? 0) === 0);
const mediaMessage = { ...addressableMessage, toolCallId: "prefix-media", content: [
  ...addressableMessage.content,
  { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
] };
await checkStableContextPrefix("mixed text/image preview", [mediaMessage]);
for (const compactStaleResults of [true, false]) {
  const legacyCwd = `/tmp/pi-ce-prefix-${compactStaleResults}-${Date.now()}`;
  mkdirSync(join(legacyCwd, ".pi"), { recursive: true });
  writeFileSync(join(legacyCwd, ".pi", "context-engineer.json"), JSON.stringify({ compactStaleResults }));
  await checkStableContextPrefix(`legacy compactStaleResults=${compactStaleResults}`, [addressableMessage], legacyCwd);
  let settings = "";
  await registeredCommands.get("ce").handler("settings", { cwd: legacyCwd, ui: { notify: (text: string) => { settings = text; } } });
  checkHook(`legacy setting ${compactStaleResults}: settings flags it as removed`, JSON.parse(settings).warnings.some((warning: string) => warning.includes("compactStaleResults")));
}

for (const [label, config, expected] of [
  ["removed settings", JSON.stringify({ strict: true, policy: { maxBytes: 1 } }), "Ignored removed settings: strict, policy. readOffloadThreshold sets the offload budget."],
  ["non-object config", "null", "must contain a JSON object"],
] as const) {
  const configCwd = `/tmp/pi-ce-config-${label.replace(/\W/g, "-")}-${Date.now()}`;
  mkdirSync(join(configCwd, ".pi"), { recursive: true });
  writeFileSync(join(configCwd, ".pi", "context-engineer.json"), config);
  let settings = "";
  await registeredCommands.get("ce").handler("settings", { cwd: configCwd, ui: { notify: (text: string) => { settings = text; } } });
  const parsed = JSON.parse(settings);
  checkHook(`${label} surface as a settings warning`, parsed.warnings.some((warning: string) => warning.includes(expected)) && parsed.readOffloadThreshold === 16384);
}

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

// Provider proxies carry program data, even when their serialized size is large.
const providerValue = { rows: [{ id: 7, output: BIG }] };
const providerEvent = {
  toolCallId: "fabric_nested_provider_1", toolName: "mcp.test.search", input: { query: "large" },
  details: { kind: "pi-fabric.tool-result-proxy.v1", ref: "mcp.test.search", result: providerValue },
  content: [{ type: "text", text: BIG }],
};
const nestedProxy = await callHook("tool_result", providerEvent);
checkHook("nested provider result is untouched", nestedProxy === undefined);
checkHook("nested consumer can still map the original rows", providerEvent.details.result === providerValue && providerValue.rows.map(row => row.id).join() === "7");

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

const reloadCwd = "/tmp/pi-ce-reload-" + Date.now();
mkdirSync(join(reloadCwd, ".pi"), { recursive: true });
writeFileSync(join(reloadCwd, ".pi", "context-engineer.json"), JSON.stringify({ enabled: false }));
const reloadEvent = (toolCallId: string) => ({ toolCallId, toolName: "bash", input: { cmd: "cat big" }, content: [{ type: "text", text: BIG }] });
checkHook("disabled project config leaves boundary results alone", await callHook("tool_result", reloadEvent("reload-disabled"), reloadCwd) === undefined);
writeFileSync(join(reloadCwd, ".pi", "context-engineer.json"), JSON.stringify({ enabled: true }));
const futureMtime = new Date(Date.now() + 2000);
utimesSync(join(reloadCwd, ".pi", "context-engineer.json"), futureMtime, futureMtime);
const afterConfigReload = await callHook("tool_result", reloadEvent("reload-enabled"), reloadCwd);
checkHook("updated project config applies without extension reload", afterConfigReload?.details?.ce_offloaded === true);

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
  await checkStableContextPrefix("ctx_read result", [ctxReadMessage], capCwd);
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

const budgetStore = new ContextStore("/tmp/pi-ce-budget-" + Date.now(), ".pi/context-store", { maxBytes: 10 });
const retained = budgetStore.write("retained", "bash", "payload larger than budget");
checkCtl("newest handle remains valid under a tiny disk budget", budgetStore.has(retained.id));
const telemetryCwd = "/tmp/pi-ce-telemetry-" + Date.now();
const telemetry = new ContextTelemetry();
telemetry.record(telemetryCwd, { strategy: "WRITE", tool: "read", sourceBytes: 40000, visibleBytes: 2200, storeTokensWritten: 10000, note: "payload sizes only" });
telemetry.record(telemetryCwd, { strategy: "WRITE", tool: "fabric_exec", sourceTokens: 10000, visibleTokens: 100, mainTokensPrevented: 0, mainTokensInjected: 0, storeTokensWritten: 10000, note: "nested store accounting" });
const telemetrySummary = telemetry.summary(telemetryCwd);
checkCtl("telemetry reports saved tokens", telemetrySummary.savedTokens > 0 && telemetrySummary.byStrategy.WRITE?.events === 2);
checkCtl("telemetry separates stored tokens from Main savings", telemetrySummary.mainTokensPrevented === telemetrySummary.savedTokens && telemetrySummary.mainTokensInjected > 0 && telemetrySummary.storeTokensWritten === 20000);
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
checkCtl("telemetry exposes a lifetime scope", sharedLifetime.events === 2 && sharedLifetime.scope === "lifetime");

// ---- ctx_offload signature ergonomics (session regressions) ----

console.log("\n=== ctx_offload Signature ===\n");
const offDef = registeredTools.get("ctx_offload");
checkCtl("ctx_offload tool is registered", Boolean(offDef));
if (offDef) {
  const o1 = await offDef.execute("o1", { key: "k1", source: "bash", data: "payload-one" }, undefined, undefined, { cwd: capCwd });
  checkCtl("canonical { key, source, data } works", o1?.details?.id !== undefined);
  const nestedManual = await offDef.execute("fabric_manual_recipe", { key: "nested-manual", data: "nested payload" }, undefined, undefined, { cwd: capCwd });
  checkCtl("nested manual offload points at extensions.ctx_read", nestedManual.content[0].text.includes("extensions.ctx_read({ id:"));
  const manualMessage = { role: "toolResult", toolCallId: "manual-o1", toolName: "ctx_offload", content: o1.content, details: o1.details, isError: false, timestamp: Date.now() };
  await checkStableContextPrefix("manual offload preview", [manualMessage], capCwd);
  const o2 = await offDef.execute("o2", { key: "k2", text: "payload-two" }, undefined, undefined, { cwd: capCwd });
  checkCtl("{ key, text } alias works", o2?.details?.id !== undefined);
  const o3 = await offDef.execute("o3", { key: "k3", content: "payload-three" }, undefined, undefined, { cwd: capCwd });
  checkCtl("{ key, content } alias works", o3?.details?.id !== undefined);
  await assert.rejects(() => offDef.execute("o4", { key: "k4" }, undefined, undefined, { cwd: capCwd }), /requires a payload.*data/);
  checkCtl("missing payload rejects with a signature hint", true);
}

// ---- Exact structured results survive nested execution ----

console.log("\n=== CE Structured Result Preservation ===\n");
const sumDef = registeredTools.get("ctx_summarize");
checkCtl("ctx_summarize tool is registered", Boolean(sumDef));
if (sumDef) {
  const bigText = "lorem-ipsum-dolor-line\n".repeat(300); // ~6.9KB of repetitive text
  const sum = await sumDef.execute("s1", { text: bigText, mode: "structural", maxTokens: 400 }, undefined, undefined, { cwd: capCwd });
  assert.deepEqual(sum.details.result, JSON.parse(sum.content[0].text));
  checkCtl("details retain the exact summary for programmatic consumers", true);
  checkCtl("content still carries the full summary once", typeof sum.content?.[0]?.text === "string" && sum.content[0].text.length > 100);
}

// ---- Boundary policies ----

console.log("\n=== Boundary Policies ===\n");
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
checkCtl("large fabric_exec result auto-offloads", adv3?.details?.ce_offloaded === true);

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

// ---- Compact acknowledgments and mixed-result previews ----
console.log("\n=== Boundary UX ===\n");
for (const [format, text] of [["json", editJson], ["yaml", editYaml]]) {
  const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
  const event = { toolCallId: `ack-${format}`, toolName: "fabric_exec", input: { code: "return await pi.edit({path:'example.ts',old:'a',new:'b'});" }, content: [{ type: "text", text }, image, { type: "text", text: "independent note" }] };
  const result = await callHook("tool_result", event);
  checkHook(`${format} successful edit acknowledgment compacts below the ordinary threshold`, Buffer.byteLength(text) < 16384 && result?.details?.ce_compacted_edit_ack === true);
  checkHook(`${format} edit status/path stay inline with recovery handle`, result?.content?.[0]?.text.includes("Successfully replaced 3 block(s)") && result.content[0].text.includes("/project/src/example.ts") && result.content[0].text.includes("ctx_read({ id:"));
  checkHook(`${format} media and sibling text are preserved exactly`, result?.content?.[1] === image && JSON.stringify(result?.content?.[2]) === JSON.stringify(event.content[2]));
  const stored = new ContextStore(hookCwd).read(result.details.ce_handle, { length: Number.MAX_SAFE_INTEGER });
  checkHook(`${format} complete original diff/patch remains retrievable`, JSON.parse(stored.content).textBlocks[0].text === text);
  const inner = await callHook("tool_result", { ...event, toolCallId: `fabric_ack-inner-${format}`, toolName: "edit" });
  checkHook(`${format} ordinary nested Pi result remains byte-for-byte untouched`, inner === undefined);
}
const noCompactCwd = "/tmp/pi-ce-no-edit-compact-" + Date.now();
mkdirSync(join(noCompactCwd, ".pi"), { recursive: true });
writeFileSync(join(noCompactCwd, ".pi", "context-engineer.json"), JSON.stringify({ compactEditResults: false }));
const ackEvent = { toolCallId: "edit-optout", toolName: "fabric_exec", input: {}, content: [{ type: "text", text: editJson }] };
checkHook("edit compaction opt-out leaves subthreshold acknowledgments inline", await callHook("tool_result", ackEvent, noCompactCwd) === undefined);
const failedAck = await callHook("tool_result", { ...ackEvent, isError: true });
checkHook("error results use error handling, not successful-edit compaction", failedAck?.details?.ce_compacted_edit_ack === undefined && failedAck?.details?.ce_error_compacted === true && typeof failedAck?.details?.ce_handle === "string");
checkHook("small edit acknowledgments remain inline", await callHook("tool_result", { ...ackEvent, content: [{ type: "text", text: JSON.stringify({ ok: true, output: "Successfully replaced", details: { diff: "tiny" } }) }] }) === undefined);
const mixedBoundary = JSON.stringify({ catalog: Array.from({ length: 3000 }, (_, i) => ({ name: `tool${i}`, schema: "schema".repeat(10) })), check: { ok: true, path: "library.blend", cameras: 4 } });
const mixedResult = await callHook("tool_result", { toolCallId: "mixed-boundary", toolName: "fabric_exec", input: {}, content: [{ type: "text", text: mixedBoundary }] });
checkHook("large mixed boundary preserves independently useful nested facts", mixedResult?.content?.[0]?.text.includes("$.check.ok: true") && mixedResult.content[0].text.includes("$.check.cameras: 4"));
checkHook("mixed boundary still stores the entire exact payload", new ContextStore(hookCwd).read(mixedResult.details.ce_handle, { length: Buffer.byteLength(mixedBoundary) }).content === mixedBoundary);
const selectedMixed = new ContextStore(hookCwd).read(mixedResult.details.ce_handle, { jsonPath: "$.check.path" });
checkHook("preview field paths can be selected through ctx_read", selectedMixed.content === '"library.blend"');

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
console.log(`Read auto-offload: ${offloadPassed} passed, ${offloadFailed} failed`);
console.log(`Boundary vs intermediate: ${hookChecks - hookFailed} passed, ${hookFailed} failed`);
console.log(`ctx_read self-cap: ${ctlChecks - ctlFailed} passed, ${ctlFailed} failed`);

const totalFailed = offloadFailed + hookFailed + ctlFailed;
if (totalFailed > 0) {
  console.log(`\n${totalFailed} test(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`\nAll tests passed`);
}
