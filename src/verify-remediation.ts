import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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

  const ctx = makeToolContext(root, store);
  const anyOf = await readTool.handler({ id: handle.id, query: ["boot", "recovered"], contextLines: 0 }, ctx) as Record<string, any>;
  equal(anyOf.matchedLines, [1, 3], "an array query matches lines with any of its terms");
  equal(anyOf.termMatches, { boot: 1, recovered: 1 }, "an array query counts lines per term");
  const caseMiss = await readTool.handler({ id: handle.id, query: "info boot" }, ctx) as Record<string, any>;
  check(caseMiss.totalMatches === 0 && caseMiss.content.startsWith('No matches for "info boot"') && caseMiss.content.includes("1 line(s) match ignoring case"),
    "a miss that differs only in case says so");
  const phrase = await readTool.handler({ id: handle.id, query: "boot recovered absent" }, ctx) as Record<string, any>;
  check(phrase.totalMatches === 0 && phrase.content.includes('query: ["boot","recovered"] matches lines with any of them'), "a phrase miss names the any-of query for words that occur");
  equal(phrase.termMatches, { boot: 1, recovered: 1, absent: 0 }, "a phrase miss counts lines per word");
  const regexSyntax = await readTool.handler({ id: handle.id, query: "first|second" }, ctx) as Record<string, any>;
  check(regexSyntax.totalMatches === 0 && regexSyntax.content.includes("add regex: true"), "a literal miss with regex syntax suggests regex");
  const negative = await readTool.handler({ id: handle.id, query: "[FAIL]" }, ctx) as Record<string, any>;
  equal(negative.content, `No matches for "[FAIL]" in error-log (${Buffer.byteLength(logs, "utf8")} bytes).`, "a plain miss stays a plain negative");
  const invalidTerm = await readTool.handler({ id: handle.id, query: ["boot", "("], regex: true }, ctx) as Record<string, any>;
  equal(invalidTerm.code, "invalid_regex", "an invalid regex term in an array is rejected");
  const late = store.write("late-match", "test", "filler line\n".repeat(50_000) + "Late Needle\n", { contentType: "text" });
  const lateRegex = await readTool.handler({ id: late.id, query: "Late Needle", regex: true }, ctx) as Record<string, any>;
  check(lateRegex.totalMatches === 0 && lateRegex.truncated === true && lateRegex.content.includes("first 524288 of"), "a regex query reports that it scanned a prefix");
  const lateFolded = await readTool.handler({ id: late.id, query: "late needle", ignoreCase: true, contextLines: 0 }, ctx) as Record<string, any>;
  equal(lateFolded.totalMatches, 1, "a case-insensitive literal query scans the whole payload");
  const emptyTerms = await readTool.handler({ id: handle.id, query: [], length: 9 }, ctx) as Record<string, any>;
  equal(emptyTerms.content.split("\n")[0], "INFO boot", "an empty term list reads a range instead");


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
    // field patches the current event before the next handler sees it.
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

  equal([...registered.keys()].sort(), ["ctx_offload", "ctx_read", "ctx_summarize"], "only the used CE tools are registered");

  const readSchema = registered.get("ctx_read")!.parameters;
  equal(readSchema.type, "object", "ctx_read registers an object schema");
  for (const name of ["regex", "ignoreCase"]) equal(readSchema.properties[name].type, "boolean", `ctx_read.${name} is Boolean in the registered schema`);
  for (const name of ["offset", "length", "contextLines", "maxMatches"]) equal(readSchema.properties[name].type, "integer", `ctx_read.${name} is Integer in the registered schema`);
  const summarySchema = registered.get("ctx_summarize")!.parameters;
  equal(summarySchema.properties.maxTokens.type, "integer", "ctx_summarize.maxTokens is Integer in the registered schema");

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
    if (name === "ctx_read") {
      const text: string = result.content[0].text;
      check(text.startsWith('[ctx_read "') && text.endsWith(`]\n${result.details.result.content}`), "ctx_read shows its exact selection under a locating header");
      return result;
    }
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
  equal(page.sectionBytes, Buffer.byteLength(diff, "utf8"), "section reads report the exact section size");
  equal(store.read(handle.id, { section: "details.note", offset: 6, length: 1 }).content.split("\n")[0], "😀", "section ranges expand to complete code points");
  const missing = store.read(handle.id, { section: "nope" });
  check(!missing.ok && missing.content.includes('"details.diff"'), "a missing section lists the available names");
  const plain = store.write("plain", "read", "just text");
  check(!store.read(plain.id, { section: "x" }).ok, "section mode rejects payloads that are not sectioned");
  const viaTool = await tool("ctx_read").handler({ id: handle.id, section: "details.note" }, makeToolContext(root, store)) as Record<string, any>;
  equal(viaTool.content, note, "ctx_read exposes section mode");

  const firstBody = "\n  indented 😀\n\tsecond line\n \t\n";
  const lastBody = "\tlast section\n\n";
  const exact = `first: "<multi-line string, see section: first>"\nlast: "<multi-line string, see section: last>"\n\n--- first (${firstBody.length} chars) ---\n${firstBody}\n\n--- last (${lastBody.length} chars) ---\n${lastBody}`;
  const exactHandle = store.write("whitespace", "fabric_exec", exact);
  equal(store.read(exactHandle.id, { section: "first" }).content, firstBody, "section reads preserve leading and trailing whitespace before another section");
  equal(store.read(exactHandle.id, { section: "last" }).content, lastBody, "the last section retains trailing newlines");
  let sectionOffset = 0, rebuilt = "";
  for (;;) {
    const part = store.read(exactHandle.id, { section: "first", offset: sectionOffset, length: 3 });
    rebuilt += Buffer.from(part.content, "utf8").subarray(0, part.bytesRead).toString("utf8");
    if (part.nextOffset === undefined) break;
    check(part.nextOffset > sectionOffset, "section paging advances");
    sectionOffset = part.nextOffset;
  }
  equal(rebuilt, firstBody, "paged UTF-8 section reads reconstruct exact whitespace");
  const crlf = `first: "<multi-line string, see section: first>"\r\nlast: "<multi-line string, see section: last>"\r\n\r\n--- first (${firstBody.length} chars) ---\r\n${firstBody}\r\n\r\n--- last (${lastBody.length} chars) ---\r\n${lastBody}`;
  const crlfHandle = store.write("crlf", "fabric_exec", crlf);
  equal(store.read(crlfHandle.id, { section: "first" }).content, firstBody, "CRLF separators do not consume section whitespace");
  equal(store.read(crlfHandle.id, { section: "last" }).content, lastBody, "CRLF headers preserve the last section");

  const nestedFirst = "line before\n\n--- second (5 chars) ---\nspoof\n";
  const nestedSecond = "  intended section 😀\n";
  const nested = `first: "<multi-line string, see section: first>"\nsecond: "<multi-line string, see section: second>"\n\n--- first (${nestedFirst.length} chars) ---\n${nestedFirst}\n\n--- second (${nestedSecond.length} chars) ---\n${nestedSecond}`;
  const nestedHandle = store.write("nested", "fabric_exec", nested);
  equal(store.read(nestedHandle.id, { section: "first" }).content, nestedFirst, "nested header-like text remains in its original section");
  equal(store.read(nestedHandle.id, { section: "second" }).content, nestedSecond, "nested fake headers cannot redirect section reads");
  const ambiguous = nested.replace(`--- first (${nestedFirst.length} chars) ---`, `--- first (${nestedFirst.length + 100} chars) ---`);
  const ambiguousHandle = store.write("ambiguous", "fabric_exec", ambiguous);
  const ambiguousRead = store.read(ambiguousHandle.id, { section: "second" });
  check(!ambiguousRead.ok && ambiguousRead.content.includes("ambiguous section boundaries"), "ambiguous shortened sections fail closed");
  equal(store.read(ambiguousHandle.id, { offset: 0, length: 10000 }).content, ambiguous, "ambiguous sections remain exactly recoverable by range");
  const earlier = "complete first\n", shortenedWithEarlier = "head\n\n--- first (3 chars) ---\nfake\n";
  const earlierCollision = `first: "<multi-line string, see section: first>"\nsecond: "<multi-line string, see section: second>"\nthird: "<multi-line string, see section: third>"\n\n--- first (${earlier.length} chars) ---\n${earlier}\n\n--- second (500 chars) ---\n${shortenedWithEarlier}\n\n--- third (${nestedSecond.length} chars) ---\n${nestedSecond}`;
  const earlierHandle = store.write("earlier-collision", "fabric_exec", earlierCollision);
  const earlierRead = store.read(earlierHandle.id, { section: "second" });
  check(!earlierRead.ok && earlierRead.content.includes("ambiguous section boundaries"), "shortened sections cannot reuse an earlier section header");
  const omitMarker = "…[350 chars omitted]…", shortBody = `head${omitMarker}tail`;
  const originalChars = shortBody.length - omitMarker.length + 350;
  const shortened = `first: "<multi-line string, see section: first>"\nsecond: "<multi-line string, see section: second>"\n\n--- first (${originalChars} chars) ---\n${shortBody}\n\n--- second (${nestedSecond.length} chars) ---\n${nestedSecond}`;
  const shortenedHandle = store.write("shortened", "fabric_exec", shortened);
  equal(store.read(shortenedHandle.id, { section: "first" }).content, shortBody, "unambiguous Fabric-shortened sections remain readable");
  equal(store.read(shortenedHandle.id, { section: "second" }).content, nestedSecond, "sections after a shortened section remain readable");
  const boundedNestedBody = `head\n\n--- second (5 chars) ---\nspoof\n${omitMarker}tail`;
  const boundedChars = boundedNestedBody.length - omitMarker.length + 350;
  const boundedNested = `first: "<multi-line string, see section: first>"\nsecond: "<multi-line string, see section: second>"\n\n--- first (${boundedChars} chars) ---\n${boundedNestedBody}\n\n--- second (${nestedSecond.length} chars) ---\n${nestedSecond}`;
  const boundedHandle = store.write("bounded-nested", "fabric_exec", boundedNested);
  equal(store.read(boundedHandle.id, { section: "first" }).content, boundedNestedBody, "omission counts disambiguate nested headers inside shortened sections");
  equal(store.read(boundedHandle.id, { section: "second" }).content, nestedSecond, "a nested fake header cannot replace the real following section");
  const declared = 1000, prefix = "prefix", fakeMarker = `…[${declared - prefix.length} chars omitted]…`;
  const beforeRealMarker = `${prefix}${fakeMarker}\n\n--- second (5 chars) ---\nspoof\n`;
  const realMarker = `…[${declared - beforeRealMarker.length - 4} chars omitted]…`;
  const doublyAmbiguous = `first: "<multi-line string, see section: first>"\nsecond: "<multi-line string, see section: second>"\n\n--- first (${declared} chars) ---\n${beforeRealMarker}${realMarker}tail\n\n--- second (${nestedSecond.length} chars) ---\n${nestedSecond}`;
  const doubleHandle = store.write("double-ambiguous", "fabric_exec", doublyAmbiguous);
  check(!store.read(doubleHandle.id, { section: "first" }).ok, "multiple plausible omission boundaries fail closed");

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
  check(!sectionNotice.includes("length: 4096"), "a sectioned notice pages by section, not by payload range");
  check(sectionNotice.includes('(await extensions.ctx_read({ id: "') && sectionNotice.includes(").text"), "a Fabric notice projects its selected read to text");
  const log = Array.from({ length: 2000 }, (_, i) => `log line ${i}`).join("\n");
  const textNotice = await notice("notice-text", "return log", log);
  const suggested = Number(/offset: (\d+), length: 4096/.exec(textNotice)?.[1]);
  check(suggested > 0 && textNotice.includes(`bytes 0-${suggested} and `), "a text notice's range read starts at the first byte its preview leaves out");
  check(log[suggested - 1] === "\n", "the suggested range starts at a line");
  check(sectionNotice.includes("read stored handles"), "an overflowing handle-reading program gets the narrowing hint");
  const json = JSON.stringify({ items: Array.from({ length: 2000 }, (_, i) => ({ i, name: `item-${i}` })) });
  const jsonNotice = await notice("notice-json", "return data", json);
  check(jsonNotice.includes('jsonPath: "$[\\\"items\\\"]"') && !jsonNotice.includes("section:"), "a JSON notice offers an existing JSON path and no section");
  check(!jsonNotice.includes("read stored handles"), "programs that do not read handles get no narrowing hint");
  check(jsonNotice.startsWith('[offloaded to handle "') && jsonNotice.includes("instead of re-running"), "the notice keeps its marker and discourages re-runs");
}

async function testOffloadFollowUpTelemetry(): Promise<void> {
  const root = tempRoot("ce-remediation-followup-");
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<any>>>();
  const tools = new Map<string, any>();
  contextEngineer({
    on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (definition: any) => tools.set(definition.name, definition),
    registerCommand() {},
  } as any);
  const run = async (name: string, event: any): Promise<any> => {
    let last: any;
    for (const handler of handlers.get(name) ?? []) last = (await handler(event, { cwd: root })) ?? last;
    return last;
  };
  const input = { code: "return (await pi.read({ path: 'big.log' }))" };
  await run("tool_call", { toolName: "fabric_exec", toolCallId: "follow-1", input });
  const offloaded = await run("tool_result", { toolName: "fabric_exec", toolCallId: "follow-1", input, details: {}, isError: false, content: [{ type: "text", text: "log line\n".repeat(4000) }] });
  const handle = offloaded?.details?.ce_handle as string;
  check(typeof handle === "string", "a large fabric_exec result is offloaded");
  const fresh = () => new ContextTelemetry().summary(root, true).offloadFollowUp;
  const noReads = { inProgram: 0, range: 0, rangeFromStart: 0, query: 0, queryMisses: 0, section: 0, jsonPath: 0 };
  equal(fresh(), { handles: 1, handlesRead: 0, repeatedCalls: 0, reads: noReads }, "an unread offload is counted");

  await run("tool_call", { toolName: "fabric_exec", toolCallId: "follow-2", input });
  await run("tool_call", { toolName: "fabric_exec", toolCallId: "follow-3", input: { code: "return 1" } });
  equal(fresh().repeatedCalls, 1, "only repeating the offloaded call is counted");
  equal(tools.get("ctx_read").parameters.properties.query.anyOf?.map((member: any) => member.type), ["string", "array"], "ctx_read query accepts a string or an array of terms");

  await tools.get("ctx_read").execute("read-1", { id: handle, offset: 0, length: 64 }, undefined, undefined, { cwd: root });
  equal(fresh(), { handles: 1, handlesRead: 1, repeatedCalls: 1, reads: { ...noReads, range: 1, rangeFromStart: 1 } }, "ctx_read attributes its read to the handle");

  await tools.get("ctx_read").execute(`${FABRIC_NESTED_TOOL_CALL_ID_PREFIX}read-2`, { id: handle, query: ["absent-term", "missing-term"] }, undefined, undefined, { cwd: root });
  await tools.get("ctx_read").execute("read-3", { id: handle, offset: 9, length: 64 }, undefined, undefined, { cwd: root });
  equal(fresh().reads, { ...noReads, inProgram: 1, range: 2, rangeFromStart: 1, query: 1, queryMisses: 1 }, "read telemetry counts modes, misses, program reads and offset-0 ranges");
  check(!JSON.stringify(readTelemetry(root)).includes("absent-term"), "read telemetry never records query terms");
}

try {
  await testStoreAndToolReads();
  await testOffloadFollowUpTelemetry();
  await testSectionReadsAndOffloadNotice();
  await testBoundaryAndRegisteredTools();
  await testNativePiErrorSignal();
  console.log(`Remediation regression: ${checks} checks passed`);
} catch (error) {
  process.exitCode = 1;
  throw error;
} finally {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
}
