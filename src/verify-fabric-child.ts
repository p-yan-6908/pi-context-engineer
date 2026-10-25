import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import contextEngineer from "./index.js";
import { enableFabricContextReadForChild, FABRIC_CONTEXT_READ_TOOL } from "./compat/fabric.js";

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
  console.log(`Fabric child: ${checks} checks passed`);
} catch (error) {
  process.exitCode = 1;
  throw error;
} finally {
  for (const [key, value] of Object.entries(envBefore)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
}
