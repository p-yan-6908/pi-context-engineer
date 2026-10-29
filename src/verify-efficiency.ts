import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import contextEngineer, { projectToolResult } from "./index.js";
import { ContextStore } from "./store.js";
import { ContextTelemetry } from "./telemetry.js";
import { ceToolMap } from "./tools.js";
import { parseBenchmarkEvents, summarizeBenchmarkRuns } from "./benchmark.js";

const roots: string[] = [];
const bytes = (text: string): number => Buffer.byteLength(text);
const text = (result: any): string => result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
const source = Array.from({ length: 1000 }, (_, i) => `row ${String(i).padStart(5, "0")} ordinary output detail\n`).join("");
function root(): string { const path = mkdtempSync(join(tmpdir(), "ce-efficiency-")); roots.push(path); return path; }
function harness(config = {}) {
  const cwd = root(); mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi/context-engineer.json"), JSON.stringify(config));
  const hooks = new Map<string, any[]>(), tools = new Map<string, any>(), commands = new Map<string, any>();
  contextEngineer({ on(name: string, fn: any) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
    registerTool(def: any) { tools.set(def.name, def); }, registerCommand(name: string, def: any) { commands.set(name, def); },
    getActiveTools() { return ["fabric_exec", "ctx_read"]; },
  } as any);
  const run = async (name: string, event: any) => {
    let result: any;
    for (const fn of hooks.get(name) ?? []) {
      const next = await fn({ ...event, ...result }, { cwd });
      if (next) result = { ...result, ...next };
    }
    return result;
  };
  const boundary = async (value: string, id = "output", extra: any = {}) => {
    const event = { toolName: "fabric_exec", toolCallId: id, input: { code: "return data" }, ...extra };
    await run("tool_call", event);
    return run("tool_result", { ...event, details: {}, isError: false, content: [{ type: "text", text: value }] });
  };
  const execute = (name: string, id: string, params: any) => tools.get(name).execute(id, params, undefined, undefined, { cwd });
  const summary = () => new ContextTelemetry().summary(cwd, true);
  return { cwd, hooks, tools, commands, run, boundary, execute, summary };
}

async function queryChecks(): Promise<void> {
  const cwd = root(), store = new ContextStore(cwd);
  const dense = Array.from({ length: 100 }, (_, i) => `row ${i} match detail`).join("\n");
  const handle = store.write("dense", "fixture", dense);
  const merged = store.read(handle.id, { query: "match" });
  const rows = [...merged.content.matchAll(/^(?:>>|  ) (\d+): /gm)].map(match => Number(match[1]));
  assert.equal(rows.length, 100); assert.equal(new Set(rows).size, 100);
  assert(bytes(merged.content) < bytes(dense) * 2);
  const read = ceToolMap.get("ctx_read")!;
  const ctx = { store, workspaceRoot: cwd, maxReturnBytes: 16_384 };
  let cursor: string | undefined;
  const seen: number[] = [];
  do {
    const page: any = await read.handler({ id: handle.id, query: "match", maxMatches: 7, cursor }, ctx);
    assert(!page.isError); assert.equal(page.totalMatches, 100);
    seen.push(...[...page.content.matchAll(/^>> (\d+): /gm)].map((m: any) => Number(m[1])));
    assert(!cursor || page.nextCursor !== cursor);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, Array.from({ length: 100 }, (_, i) => i + 1));
  const first = store.read(handle.id, { query: "match", maxMatches: 2 });
  assert(first.nextCursor);
  assert(!store.read(handle.id, { query: "other", cursor: first.nextCursor }).ok);
  assert(!store.read(handle.id, { query: "match", ignoreCase: true, cursor: first.nextCursor }).ok);
  const other = store.write("other", "fixture", dense + "different");
  assert(!store.read(other.id, { query: "match", cursor: first.nextCursor }).ok);
  assert(!store.read(handle.id, { query: "match", cursor: "not-a-cursor" }).ok);
  const sparse = store.write("sparse", "fixture", Array.from({ length: 60 }, (_, i) => i % 9 === 0 ? `match ${i}` : `context ${i}`).join("\n"));
  cursor = undefined; const sparseRows: number[] = [];
  do {
    const page: any = await read.handler({ id: sparse.id, query: "match", maxMatches: 2, contextLines: 2, cursor }, ctx);
    sparseRows.push(...[...page.content.matchAll(/^(?:>>|  ) (\d+): /gm)].map((m: any) => Number(m[1])));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(sparseRows.length, new Set(sparseRows).size);
  const longLine = "match " + "😀\\\"".repeat(1500);
  const long = store.write("long", "fixture", longLine + "\nlast match");
  cursor = undefined; let reconstructed = "", pages = 0;
  do {
    const page: any = await read.handler({ id: long.id, query: "match", contextLines: 0, cursor }, { ...ctx, maxReturnBytes: 2048 });
    assert(!page.isError); assert(bytes(JSON.stringify(page)) <= 1024);
    assert(!page.content.includes("�"));
    const row = /^>> 1: (?:\[continued at byte \d+\] )?(.*)$/m.exec(page.content);
    if (row) reconstructed += row[1];
    cursor = page.nextCursor;
    assert(++pages < 100);
  } while (cursor);
  assert.equal(reconstructed, longLine);
  assert(pages > 1);
  const late = store.write("regex-prefix", "fixture", "x".repeat(530_000) + "\nmatch");
  const regex = store.read(late.id, { query: "match", regex: true });
  assert(regex.scanTruncated && regex.truncated && !regex.nextCursor);
  const noQuery: any = await read.handler({ id: handle.id, cursor: first.nextCursor }, ctx);
  assert(noQuery.isError);
  const emptyContext = store.write("long-label-".repeat(10), "fixture", ["", "match", ...Array.from({ length: 20_000 }, (_, i) => `padding ${i}`)].join("\n"));
  const emptyPage: any = await read.handler({ id: emptyContext.id, query: "match", contextLines: 1 }, { ...ctx, maxReturnBytes: 1536 });
  assert(!emptyPage.isError && bytes(JSON.stringify(emptyPage)) <= 512);
  assert(emptyPage.content.includes("  1: ") && emptyPage.nextCursor);
  // Independent context/page budgets catch cursor gaps, duplicates, escaping,
  // long handle overhead and Unicode fragments, not just adjacent ASCII hits.
  for (let seed = 1; seed <= 16; seed++) {
    const contextLines = seed % 4;
    const byteLimit = [512, 1024, 2048, 4096][Math.floor((seed - 1) / 4)];
    const matrixLines = Array.from({ length: 36 }, (_, i) => i % 11 === 0 ? "" :
      `${i === 1 || i % 5 === 0 ? "match" : "row"} ${i} ` + ["plain", "😀", '\\"', "\t"][i % 4].repeat(i % 9 === 0 ? 500 : 3));
    const matrixHandle = store.write(`matrix-${seed}-${"long".repeat(20)}`, "fixture", matrixLines.join("\n"));
    const expected = new Map<number, string>(), actual = new Map<number, string>();
    for (let i = 0; i < matrixLines.length; i++) if (matrixLines[i].includes("match")) {
      for (let j = Math.max(0, i - contextLines); j <= Math.min(matrixLines.length - 1, i + contextLines); j++) expected.set(j + 1, matrixLines[j]);
    }
    let next: string | undefined, pages = 0;
    do {
      const page: any = await read.handler({ id: matrixHandle.id, query: "match", contextLines, maxMatches: seed % 7 + 1, cursor: next }, { ...ctx, maxReturnBytes: byteLimit + 1024 });
      assert(!page.isError && bytes(JSON.stringify(page)) <= byteLimit, `matrix seed ${seed}`);
      for (const match of page.content.matchAll(/^(?:>>|  ) (\d+): (?:\[continued at byte \d+\] )?(.*)$/gm)) {
        const line = Number(match[1]); actual.set(line, (actual.get(line) ?? "") + match[2]);
      }
      assert(!next || next !== page.nextCursor); next = page.nextCursor;
      assert(++pages < 1000);
    } while (next);
    assert.deepEqual([...actual].sort((a, b) => a[0] - b[0]), [...expected].sort((a, b) => a[0] - b[0]), `matrix seed ${seed}`);
  }
  console.log("[ok] merged query windows, query-bound cursors, 16-case UTF-8/budget matrix, and regex scan limits");
}

async function boundaryChecks(): Promise<void> {
  const h = harness();
  const offload = await h.boundary(source);
  assert(offload?.details.ce_offloaded);
  const before = h.summary();
  let offset = 0, visible = bytes(text(offload));
  while (offset < bytes(source)) {
    const read = await h.execute("ctx_read", `read-${offset}`, { id: offload.details.ce_handle, offset, length: 12000 });
    visible += bytes(text(read));
    const result = read.details.result;
    offset = result.nextOffset ?? result.offset + result.bytesRead;
  }
  const after = h.summary();
  assert(visible > bytes(source)); assert(after.mainTokensPrevented > 0);
  assert(after.netTokensSaved < 0 && after.readbackTokens > 0);
  assert.equal(after.netTokensSaved, after.mainTokensPrevented - after.readbackTokens);
  assert.equal(after.mainTokensPrevented, before.mainTokensPrevented);
  const repeated = await h.boundary(source, "repeated");
  assert.equal(repeated.details.ce_handle, offload.details.ce_handle);
  assert(bytes(text(repeated)) < bytes(text(offload)) / 2);
  assert(!text(repeated).includes("Preview"));
  await h.run("session_start", {});
  const again = await h.boundary(source, "new-session");
  assert(text(again).includes("Preview"));
  const small = harness({ readOffloadThreshold: 256 });
  assert.equal(await small.boundary("x".repeat(256)), undefined);
  const strict = harness({ minimumSavingsBytes: 100_000 });
  assert.equal(await strict.boundary(source), undefined);
  const nearCapacity = harness({ storeMaxBytes: 5000 });
  const limitedStore = new ContextStore(nearCapacity.cwd, ".pi/context-store", { maxBytes: 5000 });
  const prior = limitedStore.write("prior", "fixture", "a".repeat(1000));
  const indexPath = join(nearCapacity.cwd, ".pi/context-store/index.json");
  const beforeAdmission = readFileSync(indexPath, "utf8");
  assert.equal(limitedStore.writeIf("duplicate", "fixture", "a".repeat(1000), () => false), undefined);
  assert.equal(readFileSync(indexPath, "utf8"), beforeAdmission);
  assert.throws(() => limitedStore.writeIf("throw", "fixture", "b".repeat(4097), () => { throw new Error("admission failure"); }));
  const expiredRoot = root(), expiredStore = new ContextStore(expiredRoot);
  expiredStore.write("expired", "fixture", "expired data");
  const expiredIndex = join(expiredRoot, ".pi/context-store/index.json");
  const expiredData = JSON.parse(readFileSync(expiredIndex, "utf8"));
  expiredData.entries[0].expiresAt = new Date(0).toISOString();
  writeFileSync(expiredIndex, JSON.stringify(expiredData));
  const expiredSnapshot = readFileSync(expiredIndex, "utf8");
  assert.equal(expiredStore.writeIf("rejected", "fixture", "new data", () => false), undefined);
  assert.equal(readFileSync(expiredIndex, "utf8"), expiredSnapshot, "rejected admission must not even prune the index");
  assert.equal(await nearCapacity.boundary("ERROR " + "x".repeat(4091), "rejected-error", { isError: true }), undefined);
  assert(limitedStore.read(prior.id).ok, "a rejected offload must not evict an earlier handle");
  assert.equal(limitedStore.list().length, 1);
  assert.equal(nearCapacity.summary().storeTokensWritten, 0);
  const accepted = await nearCapacity.boundary("b".repeat(20_000), "accepted");
  assert(accepted?.details.ce_offloaded && limitedStore.read(accepted.details.ce_handle).ok);
  assert(!limitedStore.read(prior.id).ok, "an accepted write may enforce the configured capacity");
  const budget = harness({ turnBudgetBytes: 20_000 });
  let finalBytes = 0, rewrites = 0;
  const snapshots: string[] = [];
  for (let i = 0; i < 10; i++) {
    const value = (`row ${i} ordinary detail\n`).repeat(1000).slice(0, 15_000);
    const result = await budget.boundary(value, `batch-${i}`);
    if (result) rewrites++;
    const shown = result ? text(result) : value;
    snapshots.push(shown); finalBytes += bytes(shown);
  }
  assert(rewrites >= 8); assert(finalBytes < 25_000);
  const snapshot = JSON.stringify(snapshots);
  await budget.run("turn_start", {});
  assert.equal(await budget.boundary("z".repeat(15_000), "next-turn"), undefined);
  assert.equal(JSON.stringify(snapshots), snapshot);
  const disabled = harness({ turnBudgetBytes: 0 });
  for (let i = 0; i < 3; i++) assert.equal(await disabled.boundary("x".repeat(15_000), `disabled-${i}`), undefined);
  const derived = harness();
  const initial = await derived.boundary(source);
  const handle = initial.details.ce_handle;
  await derived.run("tool_call", { toolName: "fabric_exec", toolCallId: "program", input: { code: "return selection" } });
  await derived.run("tool_call", { toolName: "ctx_read", toolCallId: "arbitrary-child", parentToolCallId: "program", input: { id: handle } });
  const raw = await derived.execute("ctx_read", "arbitrary-child", { id: handle, length: 30_000 });
  assert.equal(bytes(text(raw)), 30_000);
  assert(!("content" in raw.details.result));
  assert.equal(await derived.run("tool_result", { toolName: "ctx_read", toolCallId: "arbitrary-child", parentToolCallId: "program", content: raw.content }), undefined);
  const gross = derived.summary().mainTokensPrevented;
  const final = await derived.run("tool_result", { toolName: "fabric_exec", toolCallId: "program", input: { code: "return selection" }, details: {}, isError: false, content: [{ type: "text", text: source }] });
  assert(final?.details.ce_offloaded);
  const net = derived.summary();
  assert(net.mainTokensPrevented > gross);
  assert.equal(net.netTokensSaved, gross - Math.ceil(bytes(text(final)) / 4));
  const events = readFileSync(join(derived.cwd, ".pi/context-store/context-events.jsonl"), "utf8");
  assert(!events.includes("ordinary output detail")); assert(events.includes('"derivedFrom"'));
  const scoped = new ContextTelemetry();
  const scopedRoot = root();
  scoped.setSessionId("old");
  scoped.record(scopedRoot, { strategy: "WRITE", tool: "fabric_exec", handle: "prior-handle", sourceTokens: 100, visibleTokens: 10 });
  scoped.setSessionId("new");
  scoped.record(scopedRoot, { strategy: "SELECT", tool: "ctx_read", handle: "prior-handle", mainTokensPrevented: 0, mainTokensInjected: 120 });
  assert.equal(scoped.summary(scopedRoot).netTokensSaved, -120);
  assert.equal(scoped.summary(scopedRoot, true).netTokensSaved, -30);
  const privateEvents = readFileSync(join(scopedRoot, ".pi/context-store/context-events.jsonl"), "utf8");
  assert(!privateEvents.includes("prior-handle"));
  assert(privateEvents.includes('"handle":"sha256:'));
  if (process.platform !== "win32") assert.equal(statSync(join(scopedRoot, ".pi/context-store/context-events.jsonl")).mode & 0o077, 0);
  const sensitive = harness();
  const privateResult = await sensitive.boundary(source, "private", { input: { code: "FAKETOKEN1234567890" } });
  assert(privateResult.details.ce_handle.includes("faketoken"));
  const privateLog = readFileSync(join(sensitive.cwd, ".pi/context-store/context-events.jsonl"), "utf8");
  assert(!privateLog.toLowerCase().includes("faketoken"));
  assert(!privateLog.includes(privateResult.details.ce_handle));
  const legacyRoot = root(), legacyDir = join(legacyRoot, ".pi/context-store");
  mkdirSync(legacyDir, { recursive: true });
  const legacyFile = join(legacyDir, "context-events.jsonl");
  writeFileSync(legacyFile, JSON.stringify({ version: 2, sessionId: "older", strategy: "WRITE", tool: "fabric_exec", handle: "old-handle", mainTokensPrevented: 90 }) + "\n");
  const migration = new ContextTelemetry(); migration.setSessionId("newer");
  migration.record(legacyRoot, { strategy: "SELECT", tool: "ctx_read", handle: "old-handle", mainTokensPrevented: 0, mainTokensInjected: 20 });
  migration.recordStorageFailure(legacyRoot, "fabric_exec", Object.assign(new Error("FAKETOKEN1234567890"), { code: "EACCES" }));
  migration.recordStorageFailure(legacyRoot, "fabric_exec", Object.assign(new Error("ignored"), { code: "FAKETOKEN1234567890" }));
  assert.equal(migration.summary(legacyRoot, true).netTokensSaved, 70);
  assert.equal(migration.summary(legacyRoot, true).offloadFollowUp.handlesRead, 1);
  const newEvents = readFileSync(legacyFile, "utf8").trim().split("\n").slice(1).join("\n");
  assert(!newEvents.includes("old-handle") && !newEvents.includes("FAKETOKEN"));
  assert(newEvents.includes("storage-failure: EACCES"));
  const foveaBudget = harness({ turnBudgetBytes: 10_000 });
  assert((await foveaBudget.boundary("f".repeat(15_000), "bounded", { toolName: "fovea_focus", input: { maxTokens: 4000 } }))?.details.ce_offloaded);
  let settings: any;
  await budget.commands.get("ce").handler("settings", { cwd: budget.cwd, ui: { notify(message: string) { settings = JSON.parse(message); } } });
  assert.equal(settings.turnBudgetBytes, 20_000); assert.equal(settings.minimumSavingsBytes, 256);
  console.log("[ok] negative net readback savings, cross-session and derived-offload attribution, shorter repeats, minimum savings, and turn budgets");
}

async function callBudgetChecks(): Promise<void> {
  const h = harness();
  const tokens = Math.ceil(bytes(source) / 4);
  const call = (extra: Record<string, unknown>) => ({ input: { code: "return data", ...extra } });
  assert.equal(await h.boundary(source, "fits", call({ maxOutputTokens: tokens })), undefined);
  assert.equal(await h.boundary(source, "fits-alias", call({ max_output_tokens: tokens })), undefined);
  const events = readFileSync(join(h.cwd, ".pi/context-store/context-events.jsonl"), "utf8");
  assert.equal(events.split("kept inline: fits the output budget its call set").length - 1, 2);
  assert((await h.boundary(source, "over", call({ maxOutputTokens: tokens - 1 })))?.details.ce_offloaded);
  // Fabric's truncation notice means the whole output did not fit the budget.
  const truncated = `${source}\n\n[Full output (${source.length * 3} chars) saved to: /nonexistent/pi-fabric-output-x/output.txt]`;
  const cut = await h.boundary(truncated, "truncated", call({ maxOutputTokens: tokens * 2 }));
  assert(cut?.details.ce_offloaded && cut.details.ce_fabric_output_incomplete);
  const turn = harness({ turnBudgetBytes: 10_000 });
  assert((await turn.boundary(source, "turn", call({ maxOutputTokens: tokens })))?.details.ce_offloaded);
  // A handle-reading program that overflows is told the budget that keeps it inline.
  const reader = { code: "return (await extensions.ctx_read({ id: 'h', section: 'a' })).text" };
  const derived = text(await h.boundary(source, "derived", { input: reader }));
  assert(derived.includes(`This program read stored handles: filter inside the program and return only the selection or a digest, or set maxOutputTokens: ${tokens} to keep a result this size inline.`));
  assert.equal(await h.boundary(source, "derived-budget", { input: { ...reader, maxOutputTokens: tokens } }), undefined);
  const huge = Array.from({ length: 2000 }, (_, i) => `row ${String(i).padStart(5, "0")} ordinary output detail\n`).join("");
  const past = text(await h.boundary(huge, "derived-huge", { input: reader }));
  assert(bytes(huge) > 50_000 && past.includes("read stored handles") && !past.includes("maxOutputTokens"));
  assert(!text(await turn.boundary(source, "derived-turn", { input: reader })).includes("maxOutputTokens"));
  assert(!text(await h.boundary(source, "plain")).includes("maxOutputTokens"));
  console.log("[ok] results that fit their call's maxOutputTokens stay inline; truncation and turn budgets still offload; handle-reading overflows name the budget");
}

async function nativeChecks(): Promise<void> {
  const cwd = root(); mkdirSync(join(cwd, "agent"));
  const handle = new ContextStore(cwd).write("native", "fixture", source);
  const providerId = "ce-native-origin-faux";
  const faux = fauxProvider({ provider: providerId, api: "ce-native-origin-faux-api" });
  const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("fabric_exec", { code: "emit" }, { id: "native-emit" }), { stopReason: "toolUse" }),
    fauxAssistantMessage([
      fauxToolCall("fabric_exec", { code: "consume" }, { id: "native-program" }),
      fauxToolCall("ctx_read", { id: handle.id, length: 30_000 }, { id: "native-direct" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("native checks complete"),
  ]);
  const observed: any[] = []; let nested: any;
  const fixture = (pi: any) => {
    pi.on("tool_call", (event: any) => { observed.push(event); });
    pi.registerTool({ name: "fabric_exec", label: "native program fixture", description: "Deterministic native executeTool test, no external Fabric or provider.",
      parameters: Type.Object({ code: Type.String() }),
      async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
        if (params.code === "emit") return { content: [{ type: "text", text: source }], details: {} };
        nested = await ctx.executeTool("ctx_read", { id: handle.id, length: 30_000 }, { signal: ctx.signal });
        assert.equal(bytes(text(nested.result)), 30_000);
        assert(!text(nested.result).startsWith("[ctx_read"));
        assert(!("content" in nested.result.details.result));
        return { content: [{ type: "text", text: "native selection ok" }], details: {} };
      },
    });
  };
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, "agent"), settingsManager: settings,
    extensionFactories: [contextEngineer as any, fixture], noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Run the supplied deterministic fixture." });
  await loader.reload();
  let session: any;
  try {
    ({ session } = await createAgentSession({ cwd, agentDir: join(cwd, "agent"), model: faux.getModel(), modelRuntime: runtime,
      resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager: settings, tools: ["fabric_exec", "ctx_read"] }));
    await session.prompt("Exercise the native tool path.");
    assert(nested && !nested.isError);
    assert(observed.some(event => event.toolName === "ctx_read" && event.parentToolCallId === "native-program" && !event.toolCallId.startsWith("fabric_")));
    const direct = session.messages.find((message: any) => message.role === "toolResult" && message.toolCallId === "native-direct");
    assert(direct && !direct.isError && text(direct).startsWith("[ctx_read"));
    assert(bytes(text(direct)) < 16_384);
    assert(session.messages.filter((message: any) => message.role === "toolResult").every((message: any) => !message.isError));
    assert.equal(faux.state.callCount, 3);
    const summary = new ContextTelemetry().summary(cwd, true);
    assert.equal(summary.offloadFollowUp.reads.inProgram, 1);
    assert(summary.readbackTokens > 0);
    console.log("[ok] real Pi native executeTool: explicit parent IDs, 30 KB bare program reads, and capped direct siblings");
  } finally { session?.dispose(); runtime.unregisterProvider(providerId); }
}

async function pagedProgramReadChecks(): Promise<void> {
  const h = harness();
  const payload = "normal 😀\n".repeat(60_000) + "ERROR:first\n" + "x".repeat(525_000) + "\nERROR:tail 😀\n";
  const handle = new ContextStore(h.cwd).write("paged", "fixture", payload);
  await h.run("tool_call", { toolName: "fabric_exec", toolCallId: "paging-program", input: { code: "read pages" } });
  const read = async (id: string, params: Record<string, unknown>) => {
    await h.run("tool_call", { toolName: "ctx_read", toolCallId: id, parentToolCallId: "paging-program", input: params });
    return h.execute("ctx_read", id, params);
  };
  let offset = 0, carry = "", errors = 0, rebuilt = "", pages = 0;
  for (;;) {
    const page = await read(`page-${pages++}`, { id: handle.id, offset });
    const selected = text(page);
    if (pages === 1) {
      assert(page.details.result.truncated);
      assert(!selected.includes("ERROR:tail"));
      assert(!selected.includes("nextOffset"));
    }
    rebuilt += selected;
    const lines = (carry + selected).split("\n");
    carry = lines.pop() ?? "";
    errors += lines.filter(line => line.startsWith("ERROR")).length;
    const next = page.details.result.nextOffset;
    if (next === undefined) break;
    assert(next > offset && pages < 10);
    offset = next;
  }
  if (carry.startsWith("ERROR")) errors++;
  assert(pages > 1); assert.equal(rebuilt, payload); assert.equal(errors, 2);
  const query = await read("count-lines", { id: handle.id, query: "ERROR", contextLines: 0, maxMatches: 1 });
  assert.equal(query.details.result.totalMatches, 2);
  console.log("[ok] paged program reads preserve UTF-8 and split lines; literal counts cover the whole payload");
}

function projectionAndBenchmarkChecks(): void {
  const media = { type: "image", data: "abc", mimeType: "image/png" };
  const envelope = { text: "selected", content: [{ type: "text", text: "selected" }, media], details: { result: { content: "selected", bytesRead: 8 } }, source: { path: "transport-only" }, isError: false };
  const snapshot = JSON.stringify(envelope);
  const lean: any = projectToolResult(envelope);
  assert.equal(lean.text, "selected"); assert.deepEqual(lean.content, [media]);
  assert(!("source" in lean) && !("content" in lean.details.result));
  assert.equal(JSON.stringify(envelope), snapshot);
  assert.deepEqual(projectToolResult({ text: "one", content: [{ type: "text", text: "two" }], isError: true }), { text: "one", content: [{ type: "text", text: "two" }], isError: true });
  assert.equal(projectToolResult(7), 7);
  const payload = { text: "business data", source: "important payload field" };
  assert.equal(projectToolResult(payload), payload);
  const message = { role: "assistant", content: [{ type: "toolCall", name: "ctx_read", arguments: {} }], usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 40, cost: { total: 0.5 } } };
  const log = [ { type: "message_update", message }, { type: "message_end", message }, { type: "agent_end", messages: [message] },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "42" }], usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 } } },
    { type: "message_end", message: { role: "toolResult", nestedCalls: { calls: [{ id: "nested-1" }], complete: false } } } ].map(value => JSON.stringify(value)).join("\n");
  const metrics = parseBenchmarkEvents(log);
  assert.equal(metrics.inputTokens, 175); assert.equal(metrics.outputTokens, 22);
  assert.equal(metrics.modelRequests, 2); assert.equal(metrics.toolCalls, 1); assert.equal(metrics.recoveryCalls, 1);
  assert.equal(metrics.answer, "42"); assert.equal(metrics.reportedCost, 0.5);
  assert.equal(metrics.nestedToolCalls, 1); assert.equal(metrics.nestedCallsComplete, false);
  assert(metrics.usageComplete); assert(metrics.costReported); assert(!metrics.costComplete);
  assert(!metrics.malformed && parseBenchmarkEvents("bad json").malformed);
  assert.equal(parseBenchmarkEvents("").usageRecords, 0);
  const partial = parseBenchmarkEvents([JSON.stringify({ type: "message_end", message }), JSON.stringify({ type: "message_end", message: { role: "assistant", content: [] } })].join("\n"));
  assert.equal(partial.modelRequests, 2); assert.equal(partial.usageRecords, 1);
  assert.equal(partial.missingUsageRequests, 1); assert(!partial.usageComplete && !partial.costComplete);
  const missingCounter = parseBenchmarkEvents(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 10, output: 1, cacheRead: 0 } } }));
  assert.equal(missingCounter.incompleteUsageRecords, 1); assert(!missingCounter.usageComplete);
  const malformed = parseBenchmarkEvents(`${JSON.stringify({ type: "message_end", message })}\nnot-json`);
  assert(!malformed.usageComplete);
  const summaries = summarizeBenchmarkRuns([
    { enabled: true, succeeded: true, measured: true, costComplete: true, inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0, reportedCost: 1 },
    { enabled: true, succeeded: true, measured: false, costComplete: false, inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reportedCost: 0 },
    { enabled: false, succeeded: true, measured: true, costComplete: true, inputTokens: 60, cacheReadTokens: 10, cacheWriteTokens: 5, reportedCost: 0.5 },
  ]);
  const complete = summaries.find(summary => summary.enabled === false)!;
  const incomplete = summaries.find(summary => summary.enabled === true)!;
  assert.equal(complete.inputTokens, 60); assert.equal(complete.reportedCost, 0.5);
  assert.equal(incomplete.measuredRuns, 1); assert.equal(incomplete.inputTokens, null);
  assert.equal(incomplete.cacheReadTokens, null); assert.equal(incomplete.reportedCost, null);
  console.log("[ok] opt-in projection preserves media/status; benchmark rejects partial usage and unknown cost totals");
}

try {
  await queryChecks(); await boundaryChecks(); await callBudgetChecks(); await nativeChecks(); await pagedProgramReadChecks(); projectionAndBenchmarkChecks();
  console.log("Efficiency regressions passed");
} finally { for (const cwd of roots) rmSync(cwd, { recursive: true, force: true }); }
