import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import childBudgetExtension, { capProviderPayload, CHILD_MAX_TOKENS_FLAG, CHILD_MAX_TURNS_FLAG, CHILD_BUDGET_METADATA_KEY } from "./child-budget.js";
import { CONTEXT_ENGINEER_CHILD_ENV, MAX_CHILD_INLINE_PROMPT_BYTES, MAX_CHILD_STDERR_BYTES, MAX_CHILD_STDOUT_BYTES, runChildPi, runChildPiResult, type Usage } from "./child.js";
import contextEngineer from "./index.js";
import { enableFabricContextReadForChild, FABRIC_CONTEXT_READ_TOOL } from "./compat/fabric.js";
import { ceToolMap } from "./tools.js";
import { ContextStore } from "./store.js";

const root = mkdtempSync(join(tmpdir(), "ce-child-"));
const envBefore = {
  PI_BIN: process.env.PI_BIN,
  CE_TEST_READY: process.env.CE_TEST_READY,
  CE_TEST_ARGS: process.env.CE_TEST_ARGS,
  CE_TEST_ENV: process.env.CE_TEST_ENV,
  PI_FABRIC_DEPTH: process.env.PI_FABRIC_DEPTH,
  PI_FABRIC_TOOL_ALLOWLIST: process.env.PI_FABRIC_TOOL_ALLOWLIST,
  PI_CONTEXT_ENGINEER_CHILD: process.env.PI_CONTEXT_ENGINEER_CHILD,
};
const fixture = join(root, "fake-pi.mjs");
const ready = join(root, "ready.json");
const argsFile = join(root, "args.json");
const envFile = join(root, "env.json");
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let checks = 0;
async function waitFor(test: () => boolean, label: string) {
  const deadline = Date.now() + 4000;
  while (!test() && Date.now() < deadline) await pause(15);
  assert.ok(test(), label); checks++;
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    // Linux init may not have reaped a killed orphan yet; zombies cannot run.
    if (process.platform === "linux" && readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z")) return false;
    return true;
  } catch { return false; }
}
async function readyPids(): Promise<number[]> {
  await waitFor(() => existsSync(ready), "child reached ready state");
  return JSON.parse(readFileSync(ready, "utf8"));
}
async function stopped(pids: number[]) {
  await waitFor(() => pids.every(pid => !alive(pid)), "root and descendants terminated");
  rmSync(ready, { force: true });
}
function fixtureUsage(): Usage {
  return {
    input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 16,
    reasoning: 1, cacheWrite1h: 1,
    cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
  };
}
try {
  const fabricEnvBefore = {
    depth: process.env.PI_FABRIC_DEPTH,
    allowlist: process.env.PI_FABRIC_TOOL_ALLOWLIST,
  };
  const grant = (allowlist: string, enabled = true) => {
    process.env.PI_FABRIC_TOOL_ALLOWLIST = allowlist;
    return { permitted: enableFabricContextReadForChild(enabled), allowlist: process.env.PI_FABRIC_TOOL_ALLOWLIST };
  };
  process.env.PI_FABRIC_DEPTH = "1";
  assert.deepEqual(grant('["read","grep","fabric_exec"]'), { permitted: true, allowlist: JSON.stringify(["read", "grep", "fabric_exec", FABRIC_CONTEXT_READ_TOOL]) });
  assert.equal(enableFabricContextReadForChild(true), true);
  assert.deepEqual(JSON.parse(process.env.PI_FABRIC_TOOL_ALLOWLIST!), ["read", "grep", "fabric_exec", FABRIC_CONTEXT_READ_TOOL]);
  assert.deepEqual(grant('["read"]', false), { permitted: false, allowlist: '["read"]' });
  // Fabric's own child grants skip an explicit empty tool list and +/- modifier lists.
  assert.deepEqual(grant('["fabric_exec"]'), { permitted: false, allowlist: '["fabric_exec"]' });
  assert.deepEqual(grant('["+read"]'), { permitted: false, allowlist: '["+read"]' });
  assert.deepEqual(grant('["ctx_*"]'), { permitted: true, allowlist: '["ctx_*"]' });
  assert.deepEqual(grant("not-json"), { permitted: false, allowlist: "not-json" });
  delete process.env.PI_FABRIC_DEPTH;
  assert.deepEqual(grant('["read"]'), { permitted: true, allowlist: '["read"]' });
  checks += 9;

  // A child that cannot read a handle keeps the result inline instead.
  const offloadedText = async (allowlist: string): Promise<string | undefined> => {
    process.env.PI_FABRIC_DEPTH = "1";
    process.env.PI_FABRIC_TOOL_ALLOWLIST = allowlist;
    const handlers: Array<(event: any, ctx: any) => Promise<any>> = [];
    contextEngineer({ on: (name: string, handler: any) => { if (name === "tool_result") handlers.push(handler); }, registerTool() {}, registerCommand() {} } as any);
    const event = { toolName: "fabric_exec", toolCallId: "child-call", input: {}, details: {}, isError: false, content: [{ type: "text", text: "x".repeat(40_000) }] };
    let text: string | undefined;
    for (const handler of handlers) text = (await handler(event, { cwd: root }))?.content?.[0]?.text ?? text;
    return text;
  };
  assert.equal(await offloadedText('["fabric_exec"]'), undefined);
  assert.match((await offloadedText('["read","fabric_exec"]')) ?? "", /^\[offloaded to handle "[^"]+"[\s\S]*extensions\.ctx_read/);
  checks += 2;
  if (fabricEnvBefore.depth === undefined) delete process.env.PI_FABRIC_DEPTH;
  else process.env.PI_FABRIC_DEPTH = fabricEnvBefore.depth;
  if (fabricEnvBefore.allowlist === undefined) delete process.env.PI_FABRIC_TOOL_ALLOWLIST;
  else process.env.PI_FABRIC_TOOL_ALLOWLIST = fabricEnvBefore.allowlist;

  process.env[CONTEXT_ENGINEER_CHILD_ENV] = "delegate";
  const delegateTools: string[] = [];
  contextEngineer({ on() {}, registerTool: (tool: any) => delegateTools.push(tool.name), registerCommand() {} } as any);
  delete process.env[CONTEXT_ENGINEER_CHILD_ENV];
  assert.deepEqual(delegateTools, [FABRIC_CONTEXT_READ_TOOL]); checks++;

  const cancelled = new AbortController();
  cancelled.abort(new Error("cancel before spawn"));
  process.env.PI_BIN = join(root, "does-not-exist");
  await assert.rejects(runChildPi("never", { cwd: root, signal: cancelled.signal }), /cancel before spawn/); checks++;
  await assert.rejects(runChildPi("missing", { cwd: root }), /ENOENT/); checks++;

  // A model summary must stop its hierarchy even when the injected modelCall
  // resolves after cancelling the parent signal.
  const ctl = new AbortController();
  let calls = 0;
  const summaryTool = ceToolMap.get("ctx_summarize")!;
  await assert.rejects(summaryTool.handler({ text: "long input\n".repeat(2000), mode: "model", maxInputTokens: 1024 }, {
    store: new ContextStore(root), workspaceRoot: root, signal: ctl.signal,
    callTool: async () => ({}), spawnAgent: async () => "",
    modelCall: async () => { calls++; ctl.abort(new Error("stop hierarchy")); return "partial"; },
  }), /stop hierarchy/);
  assert.equal(calls, 1); checks += 2;

  // The budget hook only rewrites provider fields that Pi's adapters support.
  const anthropic = capProviderPayload({ max_tokens: 4096 }, { api: "anthropic-messages" }, 512) as Record<string, unknown>;
  assert.equal(anthropic.max_tokens, 512);
  const openai = capProviderPayload({ max_completion_tokens: 4096 }, { api: "openai-completions" }, 512) as Record<string, unknown>;
  assert.equal(openai.max_completion_tokens, 512);
  const response = capProviderPayload({ max_output_tokens: 4096 }, { api: "openai-responses" }, 8) as Record<string, unknown>;
  assert.equal(response.max_output_tokens, 16);
  const codexPayload = {
    model: "gpt-5.6-luna", store: false, stream: true, instructions: "You are helpful.", input: [],
    text: { verbosity: "low" }, include: ["reasoning.encrypted_content"],
    prompt_cache_key: "cache-key", tool_choice: "auto", parallel_tool_calls: true,
  };
  const codexUnchanged = capProviderPayload(codexPayload, { api: "openai-codex-responses" }, 512) as Record<string, unknown>;
  assert.deepEqual(codexUnchanged, codexPayload);
  assert.equal(Object.hasOwn(codexUnchanged, "max_output_tokens"), false);
  const google = capProviderPayload({ config: { temperature: 0.1 } }, { api: "google-generative-ai" }, 512) as any;
  assert.equal(google.config.maxOutputTokens, 512);
  const bedrock = capProviderPayload({ inferenceConfig: { temperature: 0.1 } }, { api: "bedrock-converse-stream" }, 512) as any;
  assert.equal(bedrock.inferenceConfig.maxTokens, 512);
  const unchanged = { max_tokens: 4096 };
  capProviderPayload(unchanged, { api: "anthropic-messages" }, 512);
  assert.equal(unchanged.max_tokens, 4096);
  assert.throws(() => capProviderPayload({ model: "fixture" }, { api: "unknown" }, 512), /Unsupported Pi provider payload/);
  const flags = new Map<string, boolean | string | undefined>();
  const handlers = new Map<string, (...args: any[]) => any>();
  childBudgetExtension({
    registerFlag: (name: string, options: { default?: boolean | string }) => flags.set(name, options.default),
    getFlag: (name: string) => flags.get(name),
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
  } as any);
  assert.equal(flags.get(CHILD_MAX_TURNS_FLAG), "8");
  assert.equal(flags.get(CHILD_MAX_TOKENS_FLAG), undefined);
  flags.set(CHILD_MAX_TOKENS_FLAG, "321");
  const hooked = await handlers.get("before_provider_request")!({ payload: { config: { maxOutputTokens: 4096 } } }, { model: { api: "google-generative-ai" }, abort() {} });
  assert.equal((hooked as any).config.maxOutputTokens, 321);

  const beforeProvider = handlers.get("before_provider_request")!;
  const codexHooked = await beforeProvider({ payload: codexPayload }, { model: { api: "openai-codex-responses" }, abort() {} });
  assert.equal(codexHooked, undefined);
  assert.deepEqual(codexPayload, codexUnchanged);
  const streamUpdate = handlers.get("message_update")!;
  flags.set(CHILD_MAX_TOKENS_FLAG, "2");
  await beforeProvider({ payload: codexPayload }, { model: { api: "openai-codex-responses" }, abort() {} });
  let streamAborted = false;
  const streamDelta = async (type: string, delta: string) => streamUpdate(
    { assistantMessageEvent: { type, contentIndex: 0, delta } },
    { abort: () => { streamAborted = true; } },
  );
  await streamDelta("text_delta", "abcd");
  await streamDelta("thinking_delta", "abcd");
  assert.equal(streamAborted, false);
  await streamDelta("toolcall_delta", "x");
  assert.equal(streamAborted, true);
  flags.set(CHILD_MAX_TOKENS_FLAG, "3");
  await beforeProvider({ payload: codexPayload }, { model: { api: "openai-codex-responses" }, abort() {} });
  streamAborted = false;
  await streamDelta("text_delta", "abcd");
  await streamDelta("thinking_delta", "abcd");
  await streamDelta("toolcall_delta", "abcd");
  assert.equal(streamAborted, false);
  for (const type of ["text_end", "thinking_end", "toolcall_end"]) {
    await streamUpdate({ assistantMessageEvent: { type, contentIndex: 0, content: "abcd", toolCall: { arguments: "abcd" } } }, { abort: () => { streamAborted = true; } });
  }
  assert.equal(streamAborted, false, "end events must not count already-observed deltas twice");
  checks++;
  const codexEnd: any = { messages: [{ role: "assistant", content: [], api: "openai-codex-responses", stopReason: "stop" }] };
  await handlers.get("agent_end")!(codexEnd, {});
  assert.equal(codexEnd[CHILD_BUDGET_METADATA_KEY].mode, "stream");
  assert.equal(codexEnd[CHILD_BUDGET_METADATA_KEY].flags.approximate, true);
  assert.equal(codexEnd[CHILD_BUDGET_METADATA_KEY].flags.mayOvershoot, true);
  flags.set(CHILD_MAX_TURNS_FLAG, "1");
  let aborted = false;
  const turnHandler = handlers.get("turn_start")!;
  await turnHandler({ turnIndex: 0 }, { abort: () => { aborted = true; } });
  await turnHandler({ turnIndex: 1 }, { abort: () => { aborted = true; } });
  assert.equal(aborted, true);
  checks += 11;

  if (process.platform !== "win32") {
    writeFileSync(fixture, `#!/usr/bin/env node
import { writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const promptArgument = process.argv.at(-1);
const prompt = promptArgument?.startsWith('@') ? readFileSync(promptArgument.slice(1), 'utf8') : promptArgument;
if (process.env.CE_TEST_ARGS) writeFileSync(process.env.CE_TEST_ARGS, JSON.stringify(process.argv.slice(2)));
if (process.env.CE_TEST_ENV) writeFileSync(process.env.CE_TEST_ENV, JSON.stringify({ ceChild: process.env.PI_CONTEXT_ENGINEER_CHILD ?? null }));
const usage1 = {input:10, output:4, cacheRead:2, cacheWrite:1, totalTokens:16, reasoning:1, cacheWrite1h:1, cost:{input:0.01, output:0.02, cacheRead:0.003, cacheWrite:0.004, total:0.037}};
const usage2 = {input:20, output:5, cacheRead:3, cacheWrite:0, totalTokens:28, cost:{input:0.02, output:0.025, cacheRead:0.004, cacheWrite:0, total:0.049}};
const assistant = (text, usage, stopReason='stop', errorMessage, api='openai-completions') => ({role:'assistant', content:[{type:'text', text}], api, provider:'fixture', model:'fixture', ...(usage === undefined ? {} : {usage}), stopReason, ...(errorMessage ? {errorMessage} : {}), timestamp:Date.now()});
const codexAssistant = (text, usage, stopReason='stop', errorMessage) => assistant(text, usage, stopReason, errorMessage, 'openai-codex-responses');
const emit = event => console.log(JSON.stringify(event));
if (prompt === 'success' || prompt === '-leading') { emit({type:'turn_start', turnIndex:0}); emit({type:'agent_end', messages:[assistant(prompt === '-leading' ? 'dash-safe' : 'complete', usage1)]}); process.exit(0); }
if (prompt.startsWith('large-prompt:')) { emit({type:'turn_start', turnIndex:0}); emit({type:'agent_end', messages:[assistant('large-roundtrip', usage1)]}); process.exit(0); }
if (prompt === 'truncated') { emit({type:'turn_start', turnIndex:0}); emit({type:'agent_end', messages:[assistant('partial summary', usage1, 'length')]}); process.exit(0); }
if (prompt === 'codex-within-budget') { emit({type:'turn_start', turnIndex:0}); emit({type:'agent_end', messages:[codexAssistant('codex complete', usage1)]}); process.exit(0); }
if (prompt === 'codex-aborted-usage') { const budget = {mode:'stream', flags:{approximate:true, providerCap:false, streamGuard:true, mayOvershoot:true, usageMayBeUnknown:true, limitExceeded:true}, estimatedTokens:3}; emit({type:'turn_start', turnIndex:0}); emit({type:'message_update', usage:usage1, assistantMessageEvent:{type:'text_delta', contentIndex:0, delta:'partial'}}); emit({type:'agent_end', __ce_child_budget:budget, messages:[codexAssistant('partial', usage1, 'aborted', 'Request was aborted') ]}); process.exit(0); }
if (prompt === 'incomplete-usage') { emit({type:'turn_start', turnIndex:0}); emit({type:'agent_end', messages:[assistant('first complete', usage1)]}); emit({type:'turn_start', turnIndex:1}); emit({type:'message_start', message:assistant('', undefined, 'pending')}); process.exit(0); }
if (prompt === 'nested-usage') { emit({type:'turn_start', turnIndex:0}); emit({type:'turn_start', turnIndex:1}); emit({type:'agent_end', messages:[assistant('first', usage1), {role:'toolResult', toolCallId:'x', toolName:'fixture', content:[], isError:false, timestamp:Date.now()}, assistant('done', usage2)]}); process.exit(0); }
if (prompt === 'too-many-turns') { emit({type:'turn_start', turnIndex:0}); emit({type:'turn_start', turnIndex:1}); emit({type:'turn_start', turnIndex:2}); emit({type:'agent_end', messages:[assistant('one', usage1), assistant('two', usage1), assistant('three', usage1)]}); process.exit(0); }
if (prompt === 'nested-message-usage') { emit({type:'turn_start', turnIndex:0}); emit({type:'message_end', message:assistant('done', undefined)}); emit({type:'agent_end', messages:[assistant('done', usage1)]}); process.exit(0); }
if (prompt === 'missing-usage') { emit({type:'turn_start', turnIndex:0}); emit({type:'agent_end', messages:[assistant('known text', undefined)]}); process.exit(0); }
if (prompt === 'failure-with-usage') { emit({type:'message_end', message:assistant('', usage1, 'error', 'provider failed after usage')}); console.error('fixture failure'); process.exit(7); }
if (prompt === 'malformed') { console.log('{not json'); process.exit(0); }
if (prompt === 'empty') process.exit(0);
if (prompt === 'huge') { process.stdout.write('x'.repeat(${MAX_CHILD_STDOUT_BYTES + 1024})); setInterval(()=>{},1000); }
if (prompt === 'huge-stderr') { process.stderr.write('e'.repeat(${MAX_CHILD_STDERR_BYTES + 1024})); setInterval(()=>{},1000); }
if (prompt === 'tree' || prompt.includes('tree') || prompt.includes('long text')) { emit({type:'message_update', usage:usage1, assistantMessageEvent:{type:'text_delta', contentIndex:0, delta:'partial'}}); process.on('SIGTERM', () => {}); const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {stdio:'ignore'}); writeFileSync(process.env.CE_TEST_READY, JSON.stringify([process.pid, descendant.pid])); setInterval(()=>{},1000); }
if (prompt === 'failure') { console.error('fixture failure'); process.exit(7); }
`, { mode: 0o700 });
    process.env.PI_BIN = fixture;
    process.env.CE_TEST_READY = ready;
    process.env.CE_TEST_ARGS = argsFile;
    process.env.CE_TEST_ENV = envFile;

    assert.equal(await runChildPi("success", { cwd: root, model: "fixture/model", maxTokens: 321, maxTurns: 3 }), "complete"); checks++;
    const childArgs = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    const argValue = (name: string) => childArgs[childArgs.indexOf(name) + 1];
    assert.equal(argValue("--mode"), "json");
    assert.equal(argValue("--model"), "fixture/model");
    assert.equal(argValue("--ce-child-max-tokens"), "321");
    assert.equal(argValue("--ce-child-max-turns"), "3");
    assert.ok(childArgs.includes("--extension"));
    assert.equal(childArgs[childArgs.indexOf("--") + 1], "success");
    const extensionPaths = childArgs.flatMap((arg, index) => arg === "--extension" ? [childArgs[index + 1]] : []);
    assert.equal(extensionPaths.length, 1);
    assert.match(extensionPaths[0]!, /child-budget\.(?:ts|js)$/);
    assert.deepEqual(JSON.parse(readFileSync(envFile, "utf8")), { ceChild: null });
    assert.equal(await runChildPi("success", { cwd: root, loadContextEngineer: true }), "complete");
    const ceChildArgs = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    const ceExtensionPaths = ceChildArgs.flatMap((arg, index) => arg === "--extension" ? [ceChildArgs[index + 1]] : []);
    assert.equal(ceExtensionPaths.length, 2);
    assert.match(ceExtensionPaths[0]!, /index\.(?:ts|js)$/);
    assert.match(ceExtensionPaths[1]!, /child-budget\.(?:ts|js)$/);
    assert.deepEqual(JSON.parse(readFileSync(envFile, "utf8")), { ceChild: "delegate" });
    checks += 13;

    assert.equal(await runChildPi("-leading", { cwd: root, maxTokens: 321, maxTurns: 1 }), "dash-safe");
    const dashArgs = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    assert.equal(dashArgs[dashArgs.indexOf("--") + 1], "-leading");
    const largePrompt = `large-prompt:${"x".repeat(MAX_CHILD_INLINE_PROMPT_BYTES + 1)}`;
    const largeRoundTrip = await runChildPiResult(largePrompt, { cwd: root, maxTokens: 321, maxTurns: 1 });
    assert.equal(largeRoundTrip.text, "large-roundtrip");
    const largeArgs = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    const largeArgument = largeArgs[largeArgs.length - 1]!;
    assert.ok(largeArgument.startsWith("@"));
    assert.equal(largeArgs[largeArgs.indexOf("--") + 1], largeArgument);
    assert.equal(existsSync(largeArgument.slice(1)), false);
    checks += 7;

    const noToolsArgsPromise = runChildPi("success", { cwd: root, noTools: true, maxTokens: 64, maxTurns: 1 });
    assert.equal(await noToolsArgsPromise, "complete");
    const noToolsArgs = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    assert.ok(noToolsArgs.includes("--no-tools"));
    assert.ok(noToolsArgs.includes("--no-context-files"));
    assert.equal(noToolsArgs[noToolsArgs.indexOf("--thinking") + 1], "off");
    assert.ok(noToolsArgs.includes("--system-prompt"));
    checks += 4;

    const aggregate = await runChildPiResult("nested-usage", { cwd: root, maxTokens: 512, maxTurns: 2 });
    assert.equal(aggregate.text, "done");
    assert.deepEqual(aggregate.usage, {
      input: 30, output: 9, cacheRead: 5, cacheWrite: 1, totalTokens: 44,
      reasoning: 1, cacheWrite1h: 1,
      cost: { input: 0.03, output: 0.045, cacheRead: 0.007, cacheWrite: 0.004, total: 0.086 },
    });
    assert.equal(aggregate.usageComplete, true);
    assert.equal(aggregate.missingUsage, false);
    assert.equal(aggregate.turns, 2);
    assert.equal(aggregate.outputTruncated, false);
    assert.equal(aggregate.budgetEnforcement, "provider");
    assert.equal(aggregate.budgetEnforcementFlags.providerCap, true);
    checks += 9;

    const codexComplete = await runChildPiResult("codex-within-budget", { cwd: root, maxTokens: 8, maxTurns: 1 });
    assert.equal(codexComplete.text, "codex complete");
    assert.equal(codexComplete.budgetEnforcement, "stream");
    assert.equal(codexComplete.budgetEnforcementFlags.approximate, true);
    assert.equal(codexComplete.budgetEnforcementFlags.usageMayBeUnknown, true);
    assert.equal(codexComplete.usageComplete, true);
    const truncated = await runChildPiResult("truncated", { cwd: root, maxTokens: 8, maxTurns: 1 });
    assert.equal(truncated.text, "partial summary");
    assert.equal(truncated.outputTruncated, true);
    const incomplete = await runChildPiResult("incomplete-usage", { cwd: root, maxTokens: 512, maxTurns: 2 });
    assert.equal(incomplete.text, "first complete");
    assert.equal(incomplete.usage?.totalTokens, 16);
    assert.equal(incomplete.usageComplete, false);
    assert.equal(incomplete.missingUsage, true);
    let codexAbort: any;
    try { await runChildPiResult("codex-aborted-usage", { cwd: root, maxTokens: 2, maxTurns: 1 }); }
    catch (error) { codexAbort = error; }
    assert.ok(codexAbort);
    assert.match(codexAbort.message, /approximate stream budget exceeded/);
    assert.equal(codexAbort.usage?.totalTokens, 16);
    assert.equal(codexAbort.budgetEnforcementFlags.limitExceeded, true);
    assert.equal(codexAbort.usageComplete, false);
    assert.equal(codexAbort.missingUsage, true);
    assert.equal(codexAbort.budgetEnforcement, "stream");
    checks += 17;

    await assert.rejects(runChildPiResult("too-many-turns", { cwd: root, maxTurns: 2 }), /maxTurns/); checks++;

    const nestedMessageUsage = await runChildPiResult("nested-message-usage", { cwd: root });
    assert.equal(nestedMessageUsage.text, "done");
    assert.equal(nestedMessageUsage.usage?.input, 10);
    assert.equal(nestedMessageUsage.usageComplete, true);
    checks += 3;

    const missing = await runChildPiResult("missing-usage", { cwd: root });
    assert.equal(missing.text, "known text");
    assert.equal(missing.usage, undefined);
    assert.equal(missing.usageComplete, false);
    assert.equal(missing.missingUsage, true);
    checks += 4;

    let usageFailure: any;
    try { await runChildPiResult("failure-with-usage", { cwd: root }); }
    catch (error) { usageFailure = error; }
    assert.ok(usageFailure);
    assert.match(usageFailure.message, /code 7: fixture failure/);
    assert.equal(usageFailure.usage.input, 10);
    assert.equal(usageFailure.usageComplete, true);
    checks += 4;

    await assert.rejects(runChildPiResult("malformed", { cwd: root }), /malformed JSON/); checks++;
    await assert.rejects(runChildPiResult("empty", { cwd: root }), /empty or non-JSON/); checks++;
    await assert.rejects(runChildPiResult("huge", { cwd: root }), new RegExp(`stdout exceeded ${MAX_CHILD_STDOUT_BYTES} bytes`)); checks++;
    await assert.rejects(runChildPiResult("huge-stderr", { cwd: root }), new RegExp(`stderr exceeded ${MAX_CHILD_STDERR_BYTES} bytes`)); checks++;

    const controller = new AbortController();
    const running = runChildPiResult("tree", { cwd: root, signal: controller.signal });
    const pids = await readyPids();
    controller.abort(new Error("cancel running tree"));
    let cancellationError: any;
    try { await running; } catch (error) { cancellationError = error; }
    assert.match(cancellationError.message, /cancel running tree/);
    assert.equal(cancellationError.usage.output, 4);
    assert.equal(cancellationError.usageComplete, false);
    await stopped(pids); checks += 4;

    const timed = runChildPi("tree", { cwd: root, timeoutMs: 1000 });
    const timeout = assert.rejects(timed, /timed out after 1000 ms/);
    const timedPids = await readyPids();
    await timeout; checks++;
    await stopped(timedPids);

    // Verify actual registered tool closures pass both Pi cancellation surfaces
    // to the child runner, not just the runner in isolation. Pi now propagates
    // thrown cancellation errors instead of converting them to isError output.
    const tools = new Map<string, any>();
    contextEngineer({ on() {}, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {} } as any);
    for (const name of ["ctx_delegate", "ctx_summarize"]) {
      const abort = new AbortController();
      const params = name === "ctx_delegate" ? { prompt: "tree" } : { text: "long text", mode: "model" };
      const result = tools.get(name).execute("child", params, name === "ctx_delegate" ? abort.signal : undefined, undefined, { cwd: root, signal: abort.signal });
      const toolPids = await readyPids();
      const delegatedArgs = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
      const delegatedExtensions = delegatedArgs.flatMap((arg, index) => arg === "--extension" ? [delegatedArgs[index + 1]] : []);
      const delegatedEnv = JSON.parse(readFileSync(envFile, "utf8"));
      if (name === "ctx_delegate") {
        assert.equal(delegatedExtensions.length, 2);
        assert.match(delegatedExtensions[0]!, /index\.(?:ts|js)$/);
        assert.deepEqual(delegatedEnv, { ceChild: "delegate" });
      } else {
        assert.equal(delegatedExtensions.length, 1);
        assert.deepEqual(delegatedEnv, { ceChild: null });
      }
      abort.abort(new Error("parent cancelled"));
      await assert.rejects(result, /parent cancelled/); checks++;
      await stopped(toolPids);
    }
  } else console.log("POSIX fixture process-tree tests skipped on Windows");
  console.log(`Child cancellation: ${checks} checks passed`);
} catch (error) {
  process.exitCode = 1;
  throw error;
} finally {
  // Best effort teardown if an assertion fails mid-flight.
  if (existsSync(ready) && process.platform !== "win32") {
    const pids = JSON.parse(readFileSync(ready, "utf8")) as number[];
    try { process.kill(-pids[0], "SIGKILL"); } catch { /* already exited */ }
  }
  for (const [key, value] of Object.entries(envBefore)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
}
