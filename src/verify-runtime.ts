import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as extension from "./index.js";
import { ContextStore } from "./store.js";

const root = mkdtempSync(join(tmpdir(), "ce-runtime-"));
let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
const hooks: Record<string, Array<(e: any, c: any) => Promise<any>>> = {};
extension.default({ on: (name: string, fn: any) => (hooks[name] ??= []).push(fn), registerTool() {}, registerCommand() {} } as any);
let count = 0;
function workspace(config: object = {}) {
  const cwd = join(root, String(++count));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi/context-engineer.json"), JSON.stringify(config));
  return cwd;
}
async function hook(name: string, event: any, cwd: string) {
  let result: any;
  for (const fn of hooks[name] ?? []) { const next = await fn(event, { cwd }); if (next !== undefined) result = next; }
  return result;
}
const large = Array.from({ length: 700 }, (_, i) => `error TS${1000 + i}: unique-${i} ${"🌍".repeat(20)}`).join("\n");
function event(content: any[], extra: object = {}): any {
  return { toolCallId: `result-${++count}`, toolName: "custom", input: {}, details: {}, content, ...extra };
}
function readBack(cwd: string, result: any) {
  return new ContextStore(cwd).read(result.details.ce_handle, { length: Number.MAX_SAFE_INTEGER }).content;
}
try {
  const cwd = workspace();
  check("repair exports removed", !("repairGrepInput" in extension) && !("isLikelyRegexParseError" in extension));
  for (const pattern of ["(?i)hello", "(?P<word>hello)", "broken(", "state = {}", "a|b"]) {
    for (const literal of [undefined, false, true]) {
      const call = { toolName: "grep", toolCallId: "grep", input: { pattern, literal } };
      const original = structuredClone(call);
      check("grep call not blocked or repaired", await hook("tool_call", call, cwd) === undefined);
      assert.deepEqual(call, original); checks++;
    }
  }
  {
    const scoped = workspace();
    for (const toolName of ["mcp.test.fetch", "extensions.ctx_read", "extensions.fovea_focus"]) {
      const value = { rows: [{ id: 7, text: large }], exact: 123n };
      const nested = event([{ type: "text", text: large }], {
        toolCallId: "fabric_provider_test", toolName, input: { maxTokens: 500 },
        details: { kind: "pi-fabric.tool-result-proxy.v1", ref: toolName, result: value },
      });
      const original = structuredClone(nested);
      check(`nested ${toolName} unchanged`, await hook("tool_result", nested, scoped) === undefined);
      assert.deepEqual(nested, original); checks++;
      check("consumer still maps rows", nested.details.result.rows.map((row: any) => row.id).join() === "7");
    }
  }

  const blocks = [{ type: "text", text: "ok" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }, { type: "text", text: large }];
  const multiEvent = event(blocks);
  const multiSnapshot = structuredClone(multiEvent);
  const multi = await hook("tool_result", multiEvent, cwd);
  assert.deepEqual(multiEvent, multiSnapshot); checks++;
  check("large secondary block is offloaded", multi?.details.ce_offloaded);
  check("aggregate visible text is bounded", multi.content.reduce((n: number, b: any) => n + (b.type === "text" ? Buffer.byteLength(b.text) : 0), 0) < 3200);
  assert.deepEqual(multi.content.map((b: any) => b.type), blocks.map(b => b.type)); checks++;
  assert.deepEqual(multi.content[1], blocks[1]); checks++;
  assert.deepEqual(JSON.parse(readBack(cwd, multi)).textBlocks, [{ index: 0, text: "ok" }, { index: 2, text: large }]); checks++;
  const many = Array.from({ length: 20 }, () => ({ type: "text", text: "x".repeat(1000) }));
  check("aggregate of small blocks is budgeted", (await hook("tool_result", event(many), cwd))?.details.ce_offloaded);
  const artifact = await hook("tool_result", event(blocks, { toolName: "fabric_exec", details: { artifactPath: "/tmp/result.txt" } }), cwd);
  check("artifact metadata does not exempt huge secondary text", artifact?.details.ce_offloaded);
  const boundedFovea = event([{ type: "text", text: "x".repeat(18000) }], { toolName: "fovea_focus", input: { maxTokens: 5000 } });
  check("honored Fovea budget is not redundantly offloaded in auto mode", await hook("tool_result", boundedFovea, cwd) === undefined);
  check("exceeded Fovea budget uses actual boundary guard", (await hook("tool_result", { ...boundedFovea, input: { maxTokens: 500 } }, cwd))?.details.ce_offloaded);
  const disabled = workspace({ enabled: false });
  check("disabled boundary preserves everything", await hook("tool_result", event(blocks), disabled) === undefined);

  for (const budget of [256, 4096]) {
    const scoped = workspace({ errorCompactionPreviewBytes: budget });
    for (const content of [[{ type: "text", text: large }], blocks]) {
      const err = await hook("tool_result", event(content, { isError: true }), scoped);
      check("error has recovery and retains error status", err?.details.ce_error_compacted && err.details.ce_handle && err.isError !== false);
      check("error recipe fits complete byte budget", err.content.reduce((n: number, b: any) => n + (b.type === "text" ? Buffer.byteLength(b.text) : 0), 0) <= budget);
      check("error recovery preserves every diagnostic", content.length === 1 ? readBack(scoped, err) === large : JSON.parse(readBack(scoped, err)).textBlocks[1].text === large);
    }
  }
  check("ctx_read avoids recursive offload", await hook("tool_result", event([{ type: "text", text: large }], { toolName: "ctx_read" }), cwd) === undefined);
  {
    const legacy = workspace();
    const dir = join(legacy, ".pi/context-store");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "read-0123456789ab.json"), JSON.stringify({ id: "read-0123456789ab", key: "read", data: "old payload" }));
    writeFileSync(join(dir, "notes.json"), JSON.stringify({ id: "other", key: "k", data: "kept" }));
    writeFileSync(join(dir, "broken.json"), "{");
    const store = new ContextStore(legacy);
    const handle = store.write("fresh", "test", "new payload");
    check("legacy entry files are deleted, not migrated", !existsSync(join(dir, "read-0123456789ab.json")) && store.list().length === 1);
    check("unrecognized json files are kept", existsSync(join(dir, "notes.json")) && existsSync(join(dir, "broken.json")));
    check("store works after legacy cleanup", store.read(handle.id).content === "new payload");
  }
  const brokenStore = workspace();
  writeFileSync(join(brokenStore, ".pi/context-store"), "not a directory");
  check("storage failure keeps original success", await hook("tool_result", event(blocks), brokenStore) === undefined);
  check("storage failure keeps original error", await hook("tool_result", event(blocks, { isError: true }), brokenStore) === undefined);
  console.log(`Runtime safety: ${checks} checks passed`);
} catch (error) { process.exitCode = 1; throw error; } finally { rmSync(root, { recursive: true, force: true }); }
