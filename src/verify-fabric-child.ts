import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import contextEngineer from "./index.js";
import { enableFabricContextReadForChild, FABRIC_CONTEXT_READ_TOOL, readFabricFullOutput } from "./compat/fabric.js";
import { ContextStore } from "./store.js";

const root = mkdtempSync(join(tmpdir(), "ce-fabric-child-"));
const envBefore = {
  PI_FABRIC_DEPTH: process.env.PI_FABRIC_DEPTH,
  PI_FABRIC_TOOL_ALLOWLIST: process.env.PI_FABRIC_TOOL_ALLOWLIST,
};
let checks = 0;
try {
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

  // Fabric truncates a final output over its cap and keeps the full text in a
  // scratch artifact; CE stores that full text instead of the truncated view.
  delete process.env.PI_FABRIC_DEPTH;
  delete process.env.PI_FABRIC_TOOL_ALLOWLIST;
  const scratch = mkdtempSync(join(tmpdir(), "pi-fabric-output-"));
  const artifact = join(scratch, "output.txt");
  const full = `head 😀\n${"middle line\n".repeat(8000)}tail-marker`;
  writeFileSync(artifact, full);
  const notice = (path: string, chars = full.length) => `\n\n[Full output (${chars} chars) saved to: ${path}]`;
  const visible = `${full.slice(0, 20_000)}\n…\n${full.slice(-20_000)}${notice(artifact)}`;
  const boundary = async (text: string) => {
    const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<any>>>();
    contextEngineer({ on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]), registerTool() {}, registerCommand() {} } as any);
    let result: any;
    for (const [name, event] of [
      ["tool_call", { toolName: "fabric_exec", toolCallId: "capped", input: { code: "return big" } }],
      ["tool_result", { toolName: "fabric_exec", toolCallId: "capped", input: { code: "return big" }, details: {}, isError: false, content: [{ type: "text", text }] }],
    ] as const) for (const handler of handlers.get(name) ?? []) result = (await handler(event, { cwd: root })) ?? result;
    const stored = new ContextStore(root).read(result.details.ce_handle, { length: Number.MAX_SAFE_INTEGER }).content;
    return { result, stored };
  };
  const capped = await boundary(visible);
  assert.equal(capped.stored, full);
  assert.equal(capped.result.details.ce_fabric_full_output, true);
  assert.match(capped.result.content[0].text, new RegExp(`— ${Buffer.byteLength(full)} bytes`));
  assert.ok(!capped.result.content[0].text.includes("[Full output ("), "the preview comes from the full output, not Fabric's notice");
  checks += 4;
  const mismatched = await boundary(`${full.slice(0, 20_000)}${notice(artifact, full.length + 1)}`);
  assert.ok(mismatched.stored.endsWith(notice(artifact, full.length + 1)) && mismatched.result.details.ce_fabric_full_output === undefined);
  checks++;
  // Only a Fabric output scratch file directly under the temp root qualifies.
  const elsewhere = join(root, "output.txt");
  writeFileSync(elsewhere, full);
  assert.equal(readFabricFullOutput(`x${notice(elsewhere)}`), undefined);
  assert.equal(readFabricFullOutput(`x${notice(join(scratch, "..", "pi-fabric-output-x", "output.txt"))}`), undefined);
  const linked = mkdtempSync(join(tmpdir(), "pi-fabric-output-"));
  symlinkSync(elsewhere, join(linked, "output.txt"));
  assert.equal(readFabricFullOutput(`x${notice(join(linked, "output.txt"))}`), undefined);
  assert.equal(readFabricFullOutput(`x${notice(artifact)}`), full);
  checks += 4;
  rmSync(scratch, { recursive: true, force: true });
  rmSync(linked, { recursive: true, force: true });
  console.log(`Fabric child: ${checks} checks passed`);
} catch (error) {
  process.exitCode = 1;
  throw error;
} finally {
  for (const [key, value] of Object.entries(envBefore)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
}
