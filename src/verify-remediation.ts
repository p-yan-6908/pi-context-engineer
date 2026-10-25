import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import contextEngineer from "./index.js";
import { FABRIC_NESTED_TOOL_CALL_ID_PREFIX } from "./compat/fabric.js";
import { ContextStore } from "./store.js";
import { ContextTelemetry } from "./telemetry.js";
import { mergeUsage, readUsage } from "./usage.js";
import { ceToolMap, isErrorResult, type ToolContext } from "./tools.js";

/**
 * Deterministic remediation regression suite.
 *
 * This file intentionally owns no production code and is not imported by the
 * extension. Main can add it to the verification script when the concurrent
 * implementation work is ready.
 */

let checks = 0;
const temporaryRoots: string[] = [];

function check(condition: unknown, message: string): void {
  assert.ok(condition, message);
  checks++;
}

function equal<T>(actual: T, expected: T, message: string): void {
  assert.deepEqual(actual, expected, message);
  checks++;
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function tool(name: string) {
  const definition = ceToolMap.get(name);
  assert.ok(definition, `missing CE tool definition: ${name}`);
  return definition!;
}

function makeToolContext(
  root: string,
  store: ContextStore,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    store,
    workspaceRoot: root,
    signal: undefined,
    callTool: async () => ({}),
    spawnAgent: async () => "",
    modelCall: async () => "",
    ...overrides,
  };
}

function exactStored(store: ContextStore, id: string): string {
  const probe = store.read(id, { offset: 0, length: 0 });
  check(probe.ok === true, `recovery probe succeeds for ${id}`);
  const result = store.read(id, { offset: 0, length: probe.totalBytes });
  check(result.ok === true, `recovery read succeeds for ${id}`);
  equal(result.bytesRead, probe.totalBytes, `recovery covers all bytes for ${id}`);
  check(result.truncated === false, `recovery is not truncated for ${id}`);
  return result.content;
}

function boundarySource(): string {
  // maxInputTokens=1024 gives the implementation a 2048-byte input budget and
  // a 2045-byte store request. This places the third byte of 😀 at the first
  // requested boundary, forcing UTF-8 expansion rather than replacement text.
  const prefix = "p".repeat(2043) + "😀";
  const records = Array.from(
    { length: 300 },
    (_, index) => `\nError: source-record-${index} — payload 😀 ${"x".repeat(19)}`,
  ).join("");
  return prefix + records;
}

function readTelemetry(root: string): Array<Record<string, any>> {
  const path = join(root, ".pi", "context-store", "context-events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

function prevented(events: Array<Record<string, any>>): number {
  return events.reduce((sum, event) => sum + Number(event.mainTokensPrevented ?? 0), 0);
}

function deepFreeze(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== "object") return;
  const object = value as object;
  if (seen.has(object)) return;
  seen.add(object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  Object.freeze(object);
}

async function testStoreAndToolReads(): Promise<void> {
  const root = tempRoot("ce-remediation-store-");
  const store = new ContextStore(root, ".store", { ttlMs: 0 });
  const logs = [
    "INFO boot",
    "Error: first failure 😀",
    "INFO recovered",
    "Error: SECOND failure",
    "done",
  ].join("\n");
  const handle = store.write("error-log", "test", logs, { contentType: "text" });

  const full = store.read(handle.id, { offset: 0, length: Buffer.byteLength(logs, "utf8") });
  check(full.ok === true, "a valid Error:-prefixed log has ReadResult.ok=true");
  check(full.content.startsWith("INFO boot\nError:"), "normal read preserves Error:-prefixed payload text");

  const firstErrorOffset = Buffer.byteLength("INFO boot\n", "utf8");
  const ranged = store.read(handle.id, {
    offset: firstErrorOffset,
    length: Buffer.byteLength("Error: first failure 😀", "utf8"),
  });
  check(ranged.ok === true, "a ranged valid Error:-prefixed log has ReadResult.ok=true");
  check(ranged.content.startsWith("Error: first failure 😀"), "ranged read starts at the requested error line");
  equal(ranged.offset, firstErrorOffset, "ranged read reports its actual byte offset");

  const literal = store.read(handle.id, { query: "Error:" });
  check(literal.ok === true, "literal query over Error:-prefixed logs is successful");
  equal(literal.totalMatches, 2, "literal query counts both error lines");
  equal(literal.matchedLines, [2, 4], "literal query reports matching line numbers");

  const readTool = tool("ctx_read");
  const regex = await readTool.handler(
    { id: handle.id, query: "^error: (first|second) failure", regex: true, ignoreCase: true, contextLines: 0 },
    makeToolContext(root, store),
  ) as Record<string, any>;
  check(regex.ok === true, "regex query over Error:-prefixed logs is successful");
  equal(regex.matchedLines, [2, 4], "regex query matches both case variants");
  equal(regex.totalMatches, 2, "regex query counts every match");

  const ignoreCase = await readTool.handler(
    { id: handle.id, query: "ERROR: SECOND FAILURE", ignoreCase: true, contextLines: 0 },
    makeToolContext(root, store),
  ) as Record<string, any>;
  check(ignoreCase.ok === true, "ignoreCase query over Error:-prefixed logs is successful");
  equal(ignoreCase.matchedLines, [4], "ignoreCase query finds the upper/lower-case error line");

  const invalidRegex = await readTool.handler(
    { id: handle.id, query: "[", regex: true },
    makeToolContext(root, store),
  ) as Record<string, any>;
  check(isErrorResult(invalidRegex), "invalid regex query is an explicit handler error");
  equal(invalidRegex.code, "invalid_regex", "invalid regex query has a stable error code");

  const json = store.write(
    "valid-json",
    "test",
    JSON.stringify({ message: "Error: valid JSON value", values: [1, 2, 3] }),
    { contentType: "json" },
  );
  const selected = store.read(json.id, { jsonPath: "$.message" });
  check(selected.ok === true, "JSON-path selection of an Error:-prefixed string is successful");
  equal(selected.content, JSON.stringify("Error: valid JSON value", null, 2), "JSON-path selection preserves the value");

  const missing = store.read("does-not-exist");
  check(missing.ok === false, "a missing stored id is a transport error");
  check(missing.content.startsWith("Error:"), "missing-id error is explicitly Error:-prefixed");

  const invalidJson = store.write("invalid-json", "test", "Error: this is a log, not JSON", { contentType: "text" });
  const invalidJsonResult = store.read(invalidJson.id, { jsonPath: "$.message" });
  check(invalidJsonResult.ok === false, "JSON-path selection rejects invalid JSON");
  check(invalidJsonResult.content.startsWith("Error:"), "invalid-JSON error is explicitly Error:-prefixed");

  const missingPath = store.read(json.id, { jsonPath: "$.missing.value" });
  check(missingPath.ok === false, "a missing JSON path is a transport error");
  check(missingPath.content.startsWith("Error:"), "missing JSON path error is explicitly Error:-prefixed");

  const malformedPath = store.read(json.id, { jsonPath: "$.values[" });
  check(malformedPath.ok === false, "a malformed JSON path is a transport error");
  check(malformedPath.content.startsWith("Error:"), "malformed JSON path error is explicitly Error:-prefixed");

  // Invalid JSON is still valid stored text when it is read as a range. The
  // payload prefix must never be used as an implicit error discriminator.
  const invalidAsText = store.read(invalidJson.id, { offset: 0, length: Buffer.byteLength("Error: this is a log, not JSON") });
  check(invalidAsText.ok === true, "valid text transport remains ok even when payload starts with Error:");

  const structural = await tool("ctx_summarize").handler(
    {
      text: JSON.stringify({ errors: ["Error: structural fact"], items: [1, 2, 3, 4, 5, 6] }),
      mode: "structural",
      maxTokens: 256,
    },
    makeToolContext(root, store),
  ) as Record<string, any>;
  check(structural.isError !== true, "structural summary is not mistaken for an error");
  equal(structural.mode, "structural", "structural summary reports its mode");
  equal(structural.kind, "json-object", "structural summary recognizes JSON objects");
  equal(structural.keys, 2, "structural summary retains object shape");

  const rememberedFact = "Error: remembered fact is valid data 😀";
  const remembered = await tool("ctx_remember").handler(
    { fact: rememberedFact, key: "incident" },
    makeToolContext(root, store),
  ) as Record<string, any>;
  const memoryStore = new ContextStore(root, ".pi/agent/context-store", { ttlMs: 0 });
  const rememberedRead = memoryStore.read(remembered.id as string, { offset: 0, length: Buffer.byteLength(rememberedFact, "utf8") });
  check(rememberedRead.ok === true, "an Error:-prefixed remembered fact has ReadResult.ok=true");
  equal(rememberedRead.content, rememberedFact, "remembered fact is stored without error-text rewriting");

  const recalled = await tool("ctx_recall").handler(
    { query: "Error:", limit: 20, maxTokens: 1000 },
    makeToolContext(root, store),
  ) as Record<string, any>;
  check(recalled.isError !== true, "recall of an Error:-prefixed fact is successful");
  check((recalled.facts as string[]).includes(rememberedFact), "recall returns the Error:-prefixed remembered fact");
}

async function testModelSummaryBudgets(): Promise<void> {
  const root = tempRoot("ce-remediation-model-");
  const store = new ContextStore(root, ".store", { ttlMs: 0 });
  const summarize = tool("ctx_summarize");
  const source = boundarySource();
  const sourceBytes = Buffer.byteLength(source, "utf8");
  const buffer = Buffer.from(source, "utf8");
  check((buffer[2045] & 0xc0) === 0x80, "model fixture places an emoji continuation byte at the input boundary");

  const calls: Array<{ prompt: string; maxTokens?: number; signal?: AbortSignal }> = [];
  const context = makeToolContext(root, store, {
    modelCall: async (prompt, maxTokens, options) => {
      if (!options?.signal) throw new Error("modelCall did not receive a cancellation signal");
      calls.push({ prompt, maxTokens, signal: options.signal });
      // Force every partial and final response through the implementation's
      // output cap; reductions must still make progress without a token leak.
      return "VERBOSE MOCK RESPONSE — ".repeat(2_000);
    },
  });
  const result = await summarize.handler(
    {
      text: source,
      mode: "model",
      strategy: "hierarchical",
      maxInputTokens: 1024,
      maxTokens: 1024,
      maxChunks: 16,
      maxCalls: 128,
    },
    context,
  ) as Record<string, any>;

  check(!isErrorResult(result), "bounded hierarchical model summary succeeds");
  equal(result.mode, "model", "model summary reports model mode");
  check(result.chunks > 1, "unicode fixture requires multiple model-input chunks");
  equal(result.totalBytes, sourceBytes, "model summary reports the complete source byte size");
  equal(result.coveredBytes, sourceBytes, "hierarchical summary covers every source byte");
  check(result.complete === true, "hierarchical summary is complete");
  equal(result.modelCalls, calls.length, "modelCalls telemetry matches actual fake calls");
  check(calls.length <= 2 * result.chunks - 1, "hierarchical reduction converges in at most 2*n-1 model calls");
  check(calls.every((call) => call.signal?.aborted === false), "normal model calls receive live cancellation signals");
  check(Buffer.byteLength(result.summary, "utf8") <= 1024 * 4, "verbose model output is bounded to maxTokens");
  equal(exactStored(store, result.recovery.id), source, "model summary recovery exactly reconstructs the whole source");

  const overflowSource = source + "\n" + "z".repeat(7_000);
  let overflowCalls = 0;
  const overflow = await summarize.handler(
    {
      text: overflowSource,
      mode: "model",
      strategy: "hierarchical",
      maxInputTokens: 1024,
      maxTokens: 1024,
      maxChunks: 2,
      maxCalls: 128,
    },
    makeToolContext(root, store, { modelCall: async () => { overflowCalls++; return "should not run"; } }),
  ) as Record<string, any>;
  check(isErrorResult(overflow), "input beyond maxChunks returns an explicit handler error");
  equal(overflow.code, "summary_input_budget_exceeded", "maxChunks overflow has the documented error code");
  equal(overflowCalls, 0, "maxChunks overflow performs no model calls");
  check(!Object.prototype.hasOwnProperty.call(overflow, "summary"), "maxChunks overflow has no implicit prefix summary");
  check(overflow.recovery && typeof overflow.recovery.id === "string", "maxChunks overflow includes source recovery");
  equal(exactStored(store, overflow.recovery.id), overflowSource, "maxChunks overflow recovery is exact");

  const direct = await summarize.handler(
    {
      text: overflowSource,
      mode: "model",
      strategy: "direct",
      maxInputTokens: 1024,
      maxTokens: 1024,
    },
    makeToolContext(root, store, { modelCall: async () => "direct response" }),
  ) as Record<string, any>;
  check(!isErrorResult(direct), "explicit direct strategy succeeds on a large source");
  check(direct.inputTruncated === true, "direct strategy reports input truncation");
  check(direct.coveredBytes > 0 && direct.coveredBytes < direct.totalBytes, "direct strategy reports a strict covered-byte prefix");
  equal(direct.nextOffset, direct.coveredBytes, "direct strategy reports the next recovery offset");
  equal(direct.modelCalls, 1, "direct strategy uses one model call");
  equal(exactStored(store, direct.recovery.id), overflowSource, "direct strategy retains exact source recovery");

  const budgeted = await summarize.handler(
    {
      text: source,
      mode: "model",
      strategy: "hierarchical",
      maxInputTokens: 1024,
      maxTokens: 1024,
      maxChunks: 16,
      maxCalls: 1,
    },
    makeToolContext(root, store, { modelCall: async () => "partial" }),
  ) as Record<string, any>;
  check(isErrorResult(budgeted), "low maxCalls returns an explicit handler error");
  equal(budgeted.code, "summary_call_budget_exceeded", "low maxCalls has the documented error code");
  equal(budgeted.requiredCalls, 2 * result.chunks - 1, "fail-fast budget reports the exact binary reduction call count");
  equal(budgeted.modelCalls, 0, "low maxCalls fails before spending any model call");
  check(budgeted.recovery && typeof budgeted.recovery.id === "string", "low maxCalls includes source recovery");
  equal(exactStored(store, budgeted.recovery.id), source, "low maxCalls recovery is exact");

  // An already-aborted request must fail before inline input is written or
  // even probed. A throwing spy makes an accidental pre-abort store access
  // observable without relying on filesystem timing.
  const preAborted = new AbortController();
  preAborted.abort(new Error("pre-aborted summary"));
  const preAbortStoreCalls: string[] = [];
  const preAbortStore = {
    write: () => { preAbortStoreCalls.push("write"); throw new Error("unexpected pre-abort write"); },
    read: () => { preAbortStoreCalls.push("read"); throw new Error("unexpected pre-abort read"); },
  } as unknown as ContextStore;
  await assert.rejects(
    () => summarize.handler(
      { text: source, mode: "model", strategy: "hierarchical", maxInputTokens: 1024, maxTokens: 1024 },
      makeToolContext(root, preAbortStore, { signal: preAborted.signal, modelCall: async () => "must not run" }),
    ),
    /pre-aborted summary/,
  );
  checks++;
  equal(preAbortStoreCalls, [], "pre-aborted model summary does not write or read source input");

  const cancelledRoot = tempRoot("ce-remediation-cancel-");
  const cancelledStore = new ContextStore(cancelledRoot, ".store", { ttlMs: 0 });
  const parent = new AbortController();
  let cancelledCalls = 0;
  let thirdSignal: AbortSignal | undefined;
  const cancellation = summarize.handler(
    {
      text: source,
      mode: "model",
      strategy: "hierarchical",
      maxInputTokens: 1024,
      maxTokens: 1024,
      maxChunks: 16,
      maxCalls: 128,
    },
    makeToolContext(cancelledRoot, cancelledStore, {
      signal: parent.signal,
      modelCall: async (_prompt, _maxTokens, options) => {
        cancelledCalls++;
        if (cancelledCalls === 3) {
          thirdSignal = options?.signal;
          parent.abort(new Error("cancel on third model call"));
          return "late third response";
        }
        return "partial";
      },
    }),
  );
  await assert.rejects(cancellation, /cancel on third model call/);
  checks++;
  equal(cancelledCalls, 3, "cancellation stops immediately at the third model call");
  check(thirdSignal?.aborted === true, "parent cancellation reaches the third modelCall opts.signal");
}

async function testUsageAndTelemetry(): Promise<void> {
  const usageA: any = {
    input: 11, output: 7, cacheRead: 2, cacheWrite: 1, totalTokens: 21, reasoning: 3, cacheWrite1h: 1,
    cost: { input: 0.11, output: 0.07, cacheRead: 0.02, cacheWrite: 0.01, total: 0.21 },
  };
  const usageB: any = {
    input: 5, output: 4, cacheRead: 0, cacheWrite: 2, totalTokens: 11, reasoning: 2, cacheWrite1h: 4,
    cost: { input: 0.05, output: 0.04, cacheRead: 0, cacheWrite: 0.02, total: 0.11 },
  };
  const usageSnapshot = structuredClone(usageA);
  equal(readUsage(usageA), usageA, "readUsage accepts a complete provider Usage report");
  equal(usageA, usageSnapshot, "readUsage does not mutate a provider Usage report");
  check(readUsage(undefined) === undefined, "readUsage treats absent usage as unknown");
  check(readUsage({ ...usageA, totalTokens: -1 }) === undefined, "readUsage rejects negative token counts");
  check(readUsage({ ...usageA, cost: { ...usageA.cost, total: Number.NaN } }) === undefined, "readUsage rejects non-finite costs");
  check(readUsage({ ...usageA, cost: undefined }) === undefined, "readUsage rejects incomplete cost reports");

  const merged = mergeUsage(usageA, usageB);
  // Normalize only for the human-readable decimal comparison; mergeUsage must
  // retain ordinary JavaScript arithmetic rather than inventing a rounding policy.
  const normalizedMerged = merged && { ...merged, cost: { ...merged.cost, output: Number(merged.cost.output.toFixed(12)) } };
  equal(normalizedMerged, {
    input: 16, output: 11, cacheRead: 2, cacheWrite: 3, totalTokens: 32, reasoning: 5, cacheWrite1h: 5,
    cost: { input: 0.16, output: 0.11, cacheRead: 0.02, cacheWrite: 0.03, total: 0.32 },
  }, "mergeUsage sums observed token, optional, and cost fields");
  check(mergeUsage(undefined, undefined) === undefined, "mergeUsage does not fabricate zero usage");
  equal(mergeUsage(usageA), usageA, "mergeUsage preserves a single observed report");

  const root = tempRoot("ce-remediation-telemetry-");
  const telemetry = new ContextTelemetry();
  telemetry.setSessionId("usage-regression-session");
  telemetry.record(root, {
    strategy: "ISOLATE", tool: "ctx_delegate-success",
    childUsage: usageA, childUsageComplete: true, usageInParent: true,
    internalTokensProcessed: usageA.totalTokens,
  });
  telemetry.record(root, {
    strategy: "ISOLATE", tool: "ctx_delegate-failed",
    childUsage: usageB, childUsageComplete: false, usageInParent: false,
    internalTokensProcessed: usageB.totalTokens,
  });
  telemetry.record(root, {
    strategy: "ISOLATE", tool: "ctx_delegate-no-report",
    childUsageComplete: false, usageInParent: false,
  });

  const summary = telemetry.summary(root);
  equal(summary.childCalls, 3, "telemetry counts complete and incomplete child calls");
  equal(summary.childUsage, merged, "telemetry summary merges every observed child Usage");
  equal(summary.childUsageComplete, false, "telemetry summary reports incomplete child usage conservatively");
  equal(summary.childUsageOutsideParent, usageB, "telemetry isolates only usage missing from native parent totals");
  check(summary.childUsageOutsideParent?.input !== usageA.input, "usage included in the native parent is not double-counted outside it");
  const recent = telemetry.recent(root, 10);
  check(recent.some((event) => event.tool === "ctx_delegate-success" && event.usageInParent === true), "recent telemetry retains usageInParent=true");
  check(recent.some((event) => event.tool === "ctx_delegate-failed" && event.childUsageComplete === false && event.usageInParent === false), "recent telemetry retains failed child usage flags");
}

interface RegisteredTool {
  name: string;
  parameters: Record<string, any>;
  execute: (...args: any[]) => Promise<any>;
}

async function testBoundaryAndRegisteredTools(): Promise<void> {
  const root = tempRoot("ce-remediation-index-");
  const hooks = new Map<string, Array<(event: any, context: any) => Promise<any>>>();
  const registered = new Map<string, RegisteredTool>();
  contextEngineer({
    on(name: string, handler: (event: any, context: any) => Promise<any>) {
      const list = hooks.get(name) ?? [];
      list.push(handler);
      hooks.set(name, list);
    },
    registerTool(definition: RegisteredTool) {
      registered.set(definition.name, definition);
    },
    registerCommand() {},
  } as any);

  async function hook(name: string, event: any, cwd = root, extra: Record<string, any> = {}): Promise<any> {
    // Pi runs every matching middleware in registration order. Each returned
    // field patches the current event before the next handler sees it; returning
    // only the last handler's value would lose the early failed-usage patch.
    const current: any = { ...event };
    let modified = false;
    for (const handler of hooks.get(name) ?? []) {
      const next = await handler(current, { cwd, ...extra });
      if (!next) continue;
      if (next.content !== undefined) { current.content = next.content; modified = true; }
      if (next.details !== undefined) { current.details = next.details; modified = true; }
      if (next.isError !== undefined) { current.isError = next.isError; modified = true; }
      if (next.usage !== undefined) { current.usage = next.usage; modified = true; }
    }
    return modified
      ? { content: current.content, details: current.details, isError: current.isError, usage: current.usage }
      : undefined;
  }

  await hook("session_start", {}, root, {
    hasUI: false,
    sessionManager: { getSessionId: () => "remediation-session" },
  });

  const names = ["ctx_read", "ctx_summarize", "ctx_remember", "ctx_recall", "ctx_forget", "ctx_delegate", "ctx_offload", "ctx_status", "ce_exec"];
  for (const name of names) check(registered.has(name), `registered tool exists: ${name}`);

  const readSchema = registered.get("ctx_read")!.parameters;
  equal(readSchema.type, "object", "ctx_read registers an object schema");
  for (const name of ["regex", "ignoreCase"]) equal(readSchema.properties[name].type, "boolean", `ctx_read.${name} is Boolean in the registered schema`);
  for (const name of ["offset", "length", "contextLines", "maxMatches"]) equal(readSchema.properties[name].type, "integer", `ctx_read.${name} is Integer in the registered schema`);
  const summarySchema = registered.get("ctx_summarize")!.parameters;
  for (const name of ["maxTokens", "maxInputTokens", "maxChunks", "maxCalls", "timeoutSeconds"]) equal(summarySchema.properties[name].type, "integer", `ctx_summarize.${name} is Integer in the registered schema`);
  const recallSchema = registered.get("ctx_recall")!.parameters;
  equal(recallSchema.properties.limit.type, "integer", "ctx_recall.limit is Integer in the registered schema");
  equal(recallSchema.properties.maxTokens.type, "integer", "ctx_recall.maxTokens is Integer in the registered schema");

  const execContext = (signal?: AbortSignal) => ({ cwd: root, signal, model: undefined });
  const execute = (name: string, id: string, params: Record<string, unknown>, signal?: AbortSignal) =>
    registered.get(name)!.execute(id, params, signal, undefined, execContext(signal));

  await assert.rejects(
    () => execute("ctx_summarize", "invalid-mode", { mode: "invalid", text: "x" }),
    /invalid_summary_mode/,
  );
  checks++;
  await assert.rejects(
    () => execute("ctx_read", "missing-read", {}),
    /missing_id/,
  );
  checks++;
  await assert.rejects(
    () => execute("ctx_offload", "missing-offload", { key: "missing" }),
    /requires a payload/,
  );
  checks++;

  const sharedStore = new ContextStore(root, ".pi/context-store", { ttlMs: 0 });
  const invalidJson = sharedStore.write("registered-invalid-json", "test", "Error: not JSON", { contentType: "text" });
  await assert.rejects(
    () => execute("ctx_read", "invalid-json-read", { id: invalidJson.id, jsonPath: "$.value" }),
    /stored_read_failed/,
  );
  checks++;
  const validJson = sharedStore.write("registered-valid-json", "test", JSON.stringify({ present: true }), { contentType: "json" });
  await assert.rejects(
    () => execute("ctx_read", "invalid-path-read", { id: validJson.id, jsonPath: "$.missing" }),
    /stored_read_failed/,
  );
  checks++;

  async function successful(name: string, id: string, params: Record<string, unknown>): Promise<any> {
    const result = await execute(name, id, params);
    check(Array.isArray(result.content) && result.content[0]?.type === "text", `${name} returns text content`);
    const parsed = JSON.parse(result.content[0].text);
    equal(result.details?.result, parsed, `${name} details.result exactly matches parsed content`);
    return result;
  }

  const readText = "Error: registered read is data\nsecond line";
  const readHandle = sharedStore.write("registered-read", "test", readText, { contentType: "text" });
  const readResult = await successful("ctx_read", "successful-read", {
    id: readHandle.id,
    offset: 0,
    length: Buffer.byteLength(readText, "utf8"),
  });
  check(readResult.details.result.ok === true, "registered ctx_read keeps explicit ReadResult.ok=true");
  check(readResult.details.result.content.startsWith("Error:"), "registered ctx_read returns Error:-prefixed data as successful content");

  const array = Array.from({ length: 8 }, (_, index) => ({ index, value: `Error: array-${index}` }));
  const arrayHandle = sharedStore.write("registered-array", "test", JSON.stringify(array), { contentType: "json" });
  const arrayRead = await successful("ctx_read", "successful-array-read", { id: arrayHandle.id, jsonPath: "$" });
  equal(arrayRead.details.result.selectedType, "array", "registered JSON-path read identifies arrays");
  equal(JSON.parse(arrayRead.details.result.content).length, 8, "registered JSON-path read preserves arrays larger than five");

  for (let index = 0; index < 7; index++) {
    await successful("ctx_remember", `remember-${index}`, {
      key: `long-fact-${index}`,
      fact: `Error: long remembered fact ${index} 😀 ${"fact-value-".repeat(35)}`,
    });
  }
  const recalled = await successful("ctx_recall", "successful-recall", {
    query: "Error: long remembered fact",
    limit: 20,
    maxTokens: 10_000,
  });
  equal(recalled.details.result.facts.length, 7, "registered recall returns all seven long facts");
  check(recalled.details.result.facts.every((fact: string) => fact.startsWith("Error:")), "registered recall preserves Error:-prefixed long facts");

  const summaryArray = Array.from({ length: 8 }, (_, index) => ({ index, value: `Error: summary-${index}` }));
  const summary = await successful("ctx_summarize", "successful-summary", {
    text: JSON.stringify(summaryArray),
    mode: "structural",
    maxTokens: 256,
  });
  equal(summary.details.result.kind, "json-array", "registered structural summary identifies an array");
  equal(summary.details.result.length, 8, "registered structural summary preserves source array length");

  const telemetryBefore = readTelemetry(root);
  const boundaryText = "Error: boundary telemetry 😀\n".repeat(2_000);
  const boundaryEvent: any = {
    toolCallId: "boundary-parent",
    toolName: "read",
    input: { path: "fixture.log" },
    details: {
      preserved: "details survive offload",
      nested: { values: [{ keep: true }, { number: 7 }] },
      metadata: { source: "concurrent-change" },
    },
    content: [
      { type: "text", text: "short note" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png", nested: { keep: "image metadata" } },
      { type: "text", text: boundaryText },
      { type: "image", data: "d29ybGQ=", mimeType: "image/jpeg", nested: { keep: "second image" } },
      { type: "text", text: "tail note" },
    ],
    isError: false,
  };
  const boundarySnapshot = structuredClone(boundaryEvent);
  deepFreeze(boundaryEvent);
  const offloaded = await hook("tool_result", boundaryEvent, root);
  check(offloaded?.details?.ce_offloaded === true, "large boundary result is offloaded");
  check(offloaded?.details?.ce_handle, "offloaded result exposes a recovery handle");
  equal(boundaryEvent, boundarySnapshot, "offload never mutates the original event or nested values");
  equal(offloaded.details.preserved, boundarySnapshot.details.preserved, "offload preserves original scalar details");
  equal(offloaded.details.nested, boundarySnapshot.details.nested, "offload preserves original nested details");
  equal(offloaded.details.metadata, boundarySnapshot.details.metadata, "offload preserves original metadata details");
  equal(offloaded.content.map((item: any) => item.type), boundarySnapshot.content.map((item: any) => item.type), "offload preserves media/text positions");
  equal(offloaded.content[1], boundarySnapshot.content[1], "offload preserves the first media block");
  equal(offloaded.content[3], boundarySnapshot.content[3], "offload preserves the second media block");
  check(offloaded.content[2].text.includes(String(offloaded.details.ce_handle)), "offload replacement contains exact recovery recipe");

  const boundaryStore = new ContextStore(root, ".pi/context-store", { ttlMs: 0 });
  const recoveredBlocks = JSON.parse(exactStored(boundaryStore, offloaded.details.ce_handle));
  equal(
    recoveredBlocks.textBlocks,
    boundarySnapshot.content
      .map((item: any, index: number) => item.type === "text" ? { index, text: item.text } : undefined)
      .filter(Boolean),
    "offload recovery retains every original text block and its original index",
  );

  const afterBoundary = readTelemetry(root);
  check(afterBoundary.length > telemetryBefore.length, "large boundary offload records telemetry");
  const savingsBeforeHelpers = prevented(afterBoundary);

  const nestedEvent: any = {
    toolCallId: `${FABRIC_NESTED_TOOL_CALL_ID_PREFIX}provider-result`,
    toolName: "mcp.fake.fetch",
    input: {},
    details: { nested: { value: "provider data" } },
    content: [{ type: "text", text: boundaryText }],
    isError: false,
  };
  const nestedSnapshot = structuredClone(nestedEvent);
  const nestedResult = await hook("tool_result", nestedEvent, root);
  equal(nestedResult, undefined, "nested provider result is not rewritten by the Main boundary hook");
  equal(nestedEvent, nestedSnapshot, "nested provider result is not mutated");
  equal(readTelemetry(root).length, afterBoundary.length, "nested helper result creates no telemetry event");

  const repeatedReadEvent: any = {
    toolCallId: "repeated-read-result",
    toolName: "ctx_read",
    input: { id: offloaded.details.ce_handle },
    details: { totalBytes: boundaryStore.read(offloaded.details.ce_handle, { offset: 0, length: 0 }).totalBytes },
    content: [{ type: "text", text: boundaryText }],
    isError: false,
  };
  const repeatedSnapshot = structuredClone(repeatedReadEvent);
  equal(await hook("tool_result", repeatedReadEvent, root), undefined, "ctx_read result is not recursively offloaded");
  equal(repeatedReadEvent, repeatedSnapshot, "repeated ctx_read result is not mutated");
  equal(readTelemetry(root).length, afterBoundary.length, "repeated ctx_read boundary result creates no savings event");

  const helperPayload = "helper payload\n".repeat(3000);
  const helperHandle = boundaryStore.write("helper-read", "test", helperPayload, { contentType: "text" });
  const beforeRegisteredReads = readTelemetry(root);
  const firstRead = await execute("ctx_read", "registered-read-one", { id: helperHandle.id, offset: 0, length: 1024 });
  const secondRead = await execute("ctx_read", "registered-read-two", { id: helperHandle.id, offset: 0, length: 1024 });
  const nestedRead = await execute("ctx_read", `${FABRIC_NESTED_TOOL_CALL_ID_PREFIX}registered-helper-read`, { id: helperHandle.id, offset: 0, length: 1024 });
  check(firstRead.details.result.ok === true && secondRead.details.result.ok === true && nestedRead.details.result.ok === true, "repeated registered ctx_read calls succeed");
  const afterRegisteredReads = readTelemetry(root);
  const readEvents = afterRegisteredReads.slice(beforeRegisteredReads.length).filter((event) => event.tool === "ctx_read");
  check(readEvents.length === 3, "all three registered ctx_read calls have isolated telemetry records");
  check(readEvents.every((event) => event.mainTokensPrevented === 0 && event.savedTokens === 0), "ctx_read totalBytes never becomes fresh Main savings");
  check(readEvents.some((event) => event.mainTokensInjected > 0), "ordinary ctx_read exposure is accounted as injected, not prevented");
  check(readEvents.find((event) => event.handle === undefined || event.mainTokensInjected === 0) !== undefined, "nested helper ctx_read does not inject Main tokens");
  equal(prevented(afterRegisteredReads), savingsBeforeHelpers, "helpers and repeated ctx_read add no new Main savings");
}

async function testNativeChildUsage(): Promise<void> {
  // The repository's existing verify-child suite covers the process tree and
  // parser in detail. This focused probe exercises the index wrapper: successful
  // child Usage must reach native Pi, failed Usage must survive the early
  // tool_result middleware, and Fabric captures must be marked outside parent
  // totals. The fixture never contacts a provider.
  if (process.platform === "win32") {
    console.log("Native child usage propagation: POSIX executable fixture skipped on Windows");
    return;
  }

  const root = tempRoot("ce-remediation-child-usage-");
  const fixture = join(root, "fake-child-pi.mjs");
  const usage: any = {
    input: 13, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 21,
    reasoning: 1, cacheWrite1h: 1,
    cost: { input: 0.013, output: 0.025, cacheRead: 0.002, cacheWrite: 0.001, total: 0.041 },
  };
  writeFileSync(fixture, `#!/usr/bin/env node
const usage = ${JSON.stringify(usage)};
const emit = (event) => console.log(JSON.stringify(event));
const assistant = (text, reportedUsage = usage) => ({
  role: "assistant", content: [{ type: "text", text }], api: "openai-completions",
  provider: "fixture", model: "fixture", usage: reportedUsage, stopReason: "stop", timestamp: Date.now()
});
if (process.env.CE_REMEDIATION_CHILD_MODE === "failure") {
  emit({ type: "turn_start", turnIndex: 0 });
  emit({ type: "message_start", message: assistant("", undefined) });
  emit({ type: "message_update", usage });
  console.error("fixture child failure after usage");
  process.exit(7);
}
emit({ type: "turn_start", turnIndex: 0 });
const final = assistant("fixture child success");
if (process.env.CE_REMEDIATION_CHILD_MODE === "length") final.stopReason = "length";
if (process.env.CE_REMEDIATION_CHILD_MODE === "codex") final.api = "openai-codex-responses";
emit({ type: "agent_end", messages: [final] });
`, { mode: 0o700 });
  const previousPiBin = process.env.PI_BIN;
  const previousMode = process.env.CE_REMEDIATION_CHILD_MODE;
  const hooks = new Map<string, Array<(event: any, context: any) => Promise<any>>>();
  const registered = new Map<string, RegisteredTool>();
  contextEngineer({
    on(name: string, handler: (event: any, context: any) => Promise<any>) {
      const list = hooks.get(name) ?? [];
      list.push(handler);
      hooks.set(name, list);
    },
    registerTool(definition: RegisteredTool) { registered.set(definition.name, definition); },
    registerCommand() {},
  } as any);

  // Match Pi's native ExtensionRunner: all handlers see the accumulated event
  // and each patch is applied before the next handler runs.
  async function applyToolResult(event: any): Promise<any> {
    const current: any = { ...event };
    let modified = false;
    for (const handler of hooks.get("tool_result") ?? []) {
      const patch = await handler(current, { cwd: root });
      if (!patch) continue;
      if (patch.content !== undefined) { current.content = patch.content; modified = true; }
      if (patch.details !== undefined) { current.details = patch.details; modified = true; }
      if (patch.isError !== undefined) { current.isError = patch.isError; modified = true; }
      if (patch.usage !== undefined) { current.usage = patch.usage; modified = true; }
    }
    return modified
      ? { content: current.content, details: current.details, isError: current.isError, usage: current.usage }
      : undefined;
  }
  const execute = (id: string, params: Record<string, unknown>) =>
    registered.get("ctx_delegate")!.execute(id, params, undefined, undefined, { cwd: root, signal: undefined, model: undefined });

  process.env.PI_BIN = fixture;
  try {
    process.env.CE_REMEDIATION_CHILD_MODE = "success";
    const success = await execute("native-child-success", { prompt: "success", maxTokens: 64, maxTurns: 1 });
    equal(success.usage, usage, "successful registered child propagates measured Usage to native Pi");
    equal(success.details.ce_child_calls, 1, "successful child result reports child call count");
    equal(success.details.ce_child_usage, usage, "successful child details retain measured Usage");
    equal(success.details.ce_child_usage_complete, true, "successful child result marks Usage complete");

    process.env.CE_REMEDIATION_CHILD_MODE = "success";
    await execute(`${FABRIC_NESTED_TOOL_CALL_ID_PREFIX}nested-child-success`, { prompt: "nested success", maxTokens: 64, maxTurns: 1 });

    process.env.CE_REMEDIATION_CHILD_MODE = "length";
    const lengthLimited = await execute("native-child-length", { prompt: "length", maxTokens: 64, maxTurns: 1 });
    equal(JSON.parse(lengthLimited.content[0].text).childOutputTruncated, true, "provider-length truncation is visible to Main, not only hidden in details");
    process.env.CE_REMEDIATION_CHILD_MODE = "codex";
    const codex = await execute("native-child-codex", { prompt: "codex", maxTokens: 64, maxTurns: 1 });
    equal(JSON.parse(codex.content[0].text).generationBudget, { enforcement: "stream", approximate: true, mayOvershoot: true }, "Codex streamed guard is not presented as an exact billed-token cap");

    process.env.CE_REMEDIATION_CHILD_MODE = "failure";
    const failedId = "native-child-failure";
    let failedError: any;
    try { await execute(failedId, { prompt: "failure", maxTokens: 64, maxTurns: 1 }); }
    catch (error) { failedError = error; }
    check(failedError instanceof Error, "failed registered child rejects instead of returning success");
    equal(failedError.usage, usage, "failed child error retains partial measured Usage");
    equal(failedError.usageComplete, false, "failed child error marks Usage incomplete");

    const failedEvent: any = {
      toolCallId: failedId,
      toolName: "ctx_delegate",
      input: { prompt: "failure" },
      details: { preserved: { nested: true } },
      content: [{ type: "text", text: "fixture child failure" }],
      isError: true,
    };
    const failedSnapshot = structuredClone(failedEvent);
    const failedPatch = await applyToolResult(failedEvent);
    check(failedPatch?.isError === true, "failed native tool_result remains an error after usage patching");
    equal(failedPatch?.usage, usage, "early failed-child tool_result hook restores measured Usage");
    equal(failedPatch?.details?.preserved, failedSnapshot.details.preserved, "early usage patch preserves prior tool details");
    equal(failedPatch?.details?.ce_child_usage_complete, false, "early usage patch exposes incomplete Usage metadata");
    equal(failedEvent, failedSnapshot, "native middleware emulation does not mutate the original failed event");

    process.env.CE_REMEDIATION_CHILD_MODE = "failure";
    const nestedFailedId = `${FABRIC_NESTED_TOOL_CALL_ID_PREFIX}nested-child-failure`;
    try { await execute(nestedFailedId, { prompt: "nested failure", maxTokens: 64, maxTurns: 1 }); }
    catch (error) { check(error instanceof Error, "nested Fabric child failure still rejects"); }

    const childEvents = readTelemetry(root).filter((event) => event.tool === "ctx_delegate" && event.childUsage !== undefined);
    check(childEvents.some((event) => event.childUsageComplete === true && event.usageInParent === true), "native child telemetry marks successful Usage as included in parent");
    check(childEvents.some((event) => event.childUsageComplete === false && event.usageInParent === true), "native child telemetry records failed partial Usage");
    check(childEvents.some((event) => event.usageInParent === false), "Fabric child telemetry marks captured Usage outside parent totals");
    const fabricEvent = childEvents.find((event) => event.usageInParent === false);
    equal(fabricEvent?.childUsage, usage, "Fabric outside-parent telemetry retains the captured Usage for benchmark accounting");
  } finally {
    if (previousPiBin === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = previousPiBin;
    if (previousMode === undefined) delete process.env.CE_REMEDIATION_CHILD_MODE; else process.env.CE_REMEDIATION_CHILD_MODE = previousMode;
  }
}

async function testWholeSummaryDeadline(): Promise<void> {
  const root = tempRoot("ce-remediation-deadline-");
  const store = new ContextStore(root);
  let calls = 0;
  let childSignal: AbortSignal | undefined;
  const source = "Evidence must survive a hung model callback.";
  const result = await tool("ctx_summarize").handler({ text: source, mode: "model", timeoutSeconds: 10 }, makeToolContext(root, store, {
    modelCall: async (_prompt, _tokens, options) => {
      calls++;
      childSignal = options?.signal;
      // Deliberately ignore the signal: the wrapper must still enforce its deadline.
      return new Promise<string>(() => {});
    },
  })) as Record<string, any>;
  equal(result.code, "summary_timeout", "whole-operation deadline stops a hung model callback");
  equal(calls, 1, "timeout never starts another model call");
  check(childSignal?.aborted === true, "deadline reaches the child's signal");
  equal(exactStored(store, result.recovery.id), source, "timeout retains exact input recovery");
}

async function testNativePiErrorSignal(): Promise<void> {
  const root = tempRoot("ce-remediation-native-");
  mkdirSync(join(root, "agent"), { recursive: true });
  const providerId = "remediation-faux-provider";
  const faux = fauxProvider({ provider: providerId, api: "remediation-faux-api" });
  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("ctx_summarize", { mode: "not-a-real-mode", text: "Error: native fixture" }, { id: "native-invalid-mode" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("native follow-up after tool error"),
  ]);

  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    settingsManager: settings,
    extensionFactories: [contextEngineer as any],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Use ctx_summarize for the requested operation.",
  });
  await loader.reload();

  let session: any;
  try {
    const created = await createAgentSession({
      cwd: root,
      agentDir: join(root, "agent"),
      model: faux.getModel(),
      modelRuntime: runtime,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root),
      settingsManager: settings,
      tools: ["ctx_summarize"],
    });
    session = created.session;
    const events: any[] = [];
    session.subscribe((event: any) => events.push(event));
    await session.prompt("Call ctx_summarize with the supplied fixture.");

    const resultMessage = session.messages.find(
      (message: any) => message.role === "toolResult" && message.toolName === "ctx_summarize",
    );
    check(resultMessage?.isError === true, "actual Pi Agent wrapper marks a throwing CE execute as isError=true");
    check(
      events.some((event) => event.type === "tool_execution_end" && event.toolName === "ctx_summarize" && event.isError === true),
      "actual Pi Agent lifecycle emits tool_execution_end with native error signaling",
    );
    check(faux.state.callCount >= 1, "native probe used the deterministic faux model only");
  } finally {
    session?.dispose();
    runtime.unregisterProvider(providerId);
  }
}

async function testSectionReadsAndOffloadNotice(): Promise<void> {
  const root = tempRoot("ce-remediation-section-");
  const store = new ContextStore(root, ".store", { ttlMs: 0 });
  const diff = "-old\n+new\n".repeat(2000);
  const note = "note 😀 ok";
  const sectioned = `ok: true\ndetails:\n  diff: "<multi-line string, see section: details.diff>"\n  note: "<multi-line string, see section: details.note>"\n\n--- details.diff (${diff.length} chars) ---\n${diff}\n\n--- details.note (${note.length} chars) ---\n${note}`;
  const handle = store.write("sectioned", "fabric_exec", sectioned);

  equal(store.read(handle.id, { section: "details.note" }).content, note, "section mode returns one named Fabric section");
  const page = store.read(handle.id, { section: "details.diff", offset: 0, length: 100 });
  check(page.ok && page.truncated && page.nextOffset === 100, "section reads page within the section");
  equal(page.sectionBytes, Buffer.byteLength(diff.trim(), "utf8"), "section reads report the section size");
  equal(store.read(handle.id, { section: "details.note", offset: 6, length: 1 }).content.split("\n")[0], "😀", "section ranges expand to complete code points");
  const missing = store.read(handle.id, { section: "nope" });
  check(!missing.ok && missing.content.includes('"details.diff"'), "a missing section lists the available names");
  const plain = store.write("plain", "read", "just text");
  check(!store.read(plain.id, { section: "x" }).ok, "section mode rejects payloads that are not sectioned");
  const viaTool = await tool("ctx_read").handler({ id: handle.id, section: "details.note" }, makeToolContext(root, store)) as Record<string, any>;
  equal(viaTool.content, note, "ctx_read exposes section mode");

  // The boundary notice offers only access modes that fit the payload.
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<any>>>();
  contextEngineer({
    on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool() {},
    registerCommand() {},
  } as any);
  const run = async (name: string, event: any): Promise<any> => {
    let last: any;
    for (const handler of handlers.get(name) ?? []) last = (await handler(event, { cwd: root })) ?? last;
    return last;
  };
  const notice = async (toolCallId: string, code: string, text: string): Promise<string> => {
    await run("tool_call", { toolName: "fabric_exec", toolCallId, input: { code } });
    const result = await run("tool_result", { toolName: "fabric_exec", toolCallId, input: { code }, details: {}, isError: false, content: [{ type: "text", text }] });
    return result?.content?.[0]?.text ?? "";
  };
  const sectionNotice = await notice("notice-sectioned", "return await extensions.ctx_read({ id: 'h' })", sectioned);
  check(sectionNotice.includes('extensions.ctx_read({ id: "') && sectionNotice.includes('section: "details.diff"'), "a sectioned notice offers a real section name");
  check(!sectionNotice.includes("jsonPath"), "a sectioned text notice does not offer jsonPath");
  check(sectionNotice.includes("read stored handles"), "an overflowing handle-reading program gets the narrowing hint");
  const json = JSON.stringify({ items: Array.from({ length: 2000 }, (_, i) => ({ i, name: `item-${i}` })) });
  const jsonNotice = await notice("notice-json", "return data", json);
  check(jsonNotice.includes('jsonPath: "$.field"') && !jsonNotice.includes("section:"), "a JSON notice offers jsonPath and no section");
  check(!jsonNotice.includes("read stored handles"), "programs that do not read handles get no narrowing hint");
  check(jsonNotice.startsWith('[offloaded to handle "') && jsonNotice.includes("instead of re-running"), "the notice keeps its marker and discourages re-runs");
}

try {
  await testStoreAndToolReads();
  await testSectionReadsAndOffloadNotice();
  await testModelSummaryBudgets();
  await testUsageAndTelemetry();
  await testBoundaryAndRegisteredTools();
  await testNativeChildUsage();
  await testNativePiErrorSignal();
  await testWholeSummaryDeadline();
  console.log(`Remediation regression: ${checks} checks passed`);
} catch (error) {
  process.exitCode = 1;
  throw error;
} finally {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
}
