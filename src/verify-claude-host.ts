/**
 * Verify the Claude Code host in claude-code/: the ops the `ce` Claude Code mod
 * sends run this extension as Pi's own events would, and the guide the host
 * hands over is this package's, with the limits it states.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contextEngineer from "./index.js";

type Reply = Record<string, any>;
type Host = {
  ops: Record<string, (request?: Record<string, unknown>) => Promise<Reply>>;
  load(extension: unknown): Promise<string[]>;
  drain(): unknown[];
};
type HostModule = { PACKAGE_DIR: string; VERSION: string; createHost(options: { cwd: string; sessionId: string }): Host };

// From the build output in .tmp/pi-ce-build, the package root is two folders up.
const { PACKAGE_DIR, VERSION, createHost } = await import(new URL("../../claude-code/host.mjs", import.meta.url).href) as HostModule;

const workspaces: string[] = [];
let checks = 0;
let calls = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  checks++;
  assert.ok(condition, detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
};

/** A host for a fresh workspace, with its .pi/context-engineer.json when given. */
const session = async (config?: Record<string, unknown>): Promise<Host> => {
  const cwd = mkdtempSync(join(tmpdir(), "ce-claude-host-"));
  workspaces.push(cwd);
  if (config) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "context-engineer.json"), JSON.stringify(config));
  }
  const host = createHost({ cwd, sessionId: `verify-claude-host-${workspaces.length}` });
  await host.load(contextEngineer);
  return host;
};

/** ASCII output of exactly `bytes` bytes, distinct per tag. */
const output = (bytes: number, tag: string): string => {
  let text = "";
  for (let line = 0; text.length < bytes; line++) text += `${tag} line ${line} ${"x".repeat(48)}\n`;
  return text.slice(0, bytes);
};

/** One fabric_exec result as Fabric hands it over. */
const result = (host: Host, text: string, input: Record<string, unknown> = { code: "return out" }, isError = false): Promise<Reply> =>
  host.ops.result({ toolCallId: `toolu_${++calls}`, input, isError, text });

try {
  const host = await session();
  const hello = await host.ops.hello();
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as { version: string };
  const tools = hello.tools as { name: string; parameters: { type?: string } }[];
  const names = tools.map((tool) => tool.name);
  check("hello names this package's version", hello.version === manifest.version && VERSION === manifest.version, hello.version);
  check("hello lists the extension's tools with JSON schemas",
    ["ctx_read", "ctx_summarize", "ctx_offload"].every((name) => names.includes(name)) && tools.every((tool) => tool.parameters.type === "object"), names);
  check("hello lists /ce", (hello.commands as string[]).includes("ce"), hello.commands);
  const guide = String(hello.guide);
  const skill = join(PACKAGE_DIR, "skills", "context-engineer", "SKILL.md");
  check("the guide is this package's, filled in",
    guide.startsWith(`# Context Engineer (pi-context-engineer ${manifest.version})`) && guide.includes(skill) && existsSync(skill) && !guide.includes("{{"),
    guide.slice(0, 200));
  // The checks below hold the host to what the guide tells the model.
  check("the guide states the limits checked below", ["16 KB", "4 KB", "512 KB", "`maxOutputTokens`"].every((term) => guide.includes(term)));
  console.log("[ok] hello: the package's version, tools, /ce and guide");

  const small = await result(host, output(15 * 1024, "small"));
  check("a result under 16 KB stays inline", small.text === null, small.text);
  const big = output(17 * 1024, "big");
  const offloaded = await result(host, big);
  const id = /handle "([^"]+)"/.exec(String(offloaded.text))?.[1];
  check("a result over 16 KB is offloaded behind a handle", id !== undefined && String(offloaded.text).length < big.length, String(offloaded.text).slice(0, 200));
  const nested = await host.ops.tool({ name: "ctx_read", params: { id }, id: "toolu_read_1", isNested: true });
  check("a program reads the whole payload back as data", nested.text === big && nested.details?.result?.totalBytes === big.length, nested.details?.result);
  const direct = await host.ops.tool({ name: "ctx_read", params: { id, offset: 0, length: 100 }, id: "toolu_read_2", isNested: false });
  check("a direct read shows its slice under a locating header",
    String(direct.text).startsWith(`[ctx_read "${id}"`) && String(direct.text).includes(big.slice(0, 100)), String(direct.text).slice(0, 200));
  const budgeted = await result(host, output(17 * 1024, "budgeted"), { code: "return out", maxOutputTokens: Math.ceil((17 * 1024) / 4) });
  check("a result that fits its call's maxOutputTokens stays inline", budgeted.text === null, budgeted.text);
  const error = `Error: boom\n${"    at frame (src/file.ts:1:1)\n".repeat(300)}`;
  const compacted = await result(host, error, { code: "throw new Error('boom')" }, true);
  check("an error over 4 KB is compacted",
    typeof compacted.text === "string" && compacted.text.length < error.length && compacted.text.includes("Error: boom"), String(compacted.text).slice(0, 200));
  console.log("[ok] result and tool: offload, program and direct reads, call budgets, error compaction");

  const status = await host.ops.command({ name: "ce", args: "status" });
  check("/ce status counts the read that followed the offload", String(status.text).includes("Next call after an offload read its handle: 1/1"), status.text);
  console.log("[ok] command: /ce status reports the session");

  const turns = await session({ turnBudgetBytes: 20 * 1024 });
  const first = await result(turns, output(12 * 1024, "turn-a"));
  const second = await result(turns, output(12 * 1024, "turn-b"));
  await turns.ops.turn({ index: 1 });
  const third = await result(turns, output(12 * 1024, "turn-c"));
  check("each model request starts a turn: the turn budget resets",
    first.text === null && typeof second.text === "string" && third.text === null, [first.text, String(second.text).slice(0, 80), third.text]);
  console.log("[ok] turn: turn_start for each model request resets the turn budget");

  await host.ops.shutdown();
  await turns.ops.shutdown();
  console.log(`Claude Code host: ${checks} checks passed`);
} finally {
  for (const cwd of workspaces) rmSync(cwd, { recursive: true, force: true });
}
