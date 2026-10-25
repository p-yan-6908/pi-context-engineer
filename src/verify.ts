/**
 * Execution-scope and deterministic ctx_summarize checks.
 */

import { ceToolMap } from "./tools.js";
import { FabricExecutionScopes } from "./execution-scope.js";

const scopes = new FabricExecutionScopes();
scopes.start({ toolCallId: "fabric_a", workspaceRoot: "/tmp/a", startedAt: 1 });
scopes.start({ toolCallId: "fabric_b", workspaceRoot: "/tmp/b", startedAt: 2 });
const sizeAfterStarts = scopes.size;
const nestedA = scopes.isNestedToolResult("fabric_child_a");
const ordinaryIsBoundary = !scopes.isNestedToolResult("model-read");
const finishedA = scopes.finish("fabric_a");
const nestedB = scopes.isNestedToolResult("fabric_child_b");
const finishedB = scopes.finish("fabric_b");
const sizeAfterFinishes = scopes.size;
const nestedAfterFinishes = scopes.isNestedToolResult("fabric_child_after");
const scopeOk = sizeAfterStarts === 2 && nestedA && ordinaryIsBoundary && finishedA && nestedB && finishedB && sizeAfterFinishes === 0 && nestedAfterFinishes;
console.log(`${scopeOk ? "[ok]" : "[FAIL]"} execution scopes handle overlapping and late nested Fabric results`);
let scopeFailures = scopeOk ? 0 : 1;

const summarizeTool = ceToolMap.get("ctx_summarize");
let toolFailures = 0;
if (!summarizeTool) {
  console.log("[FAIL] ctx_summarize is not registered");
  toolFailures++;
} else {
  const toolContext = {
    store: { read: () => ({ content: "", truncated: false }) },
    workspaceRoot: process.cwd(),
  } as any;
  const codeText = Array.from({ length: 120 }, (_, index) => `export function item${index}() { return ${index}; }`).join("\\n");
  const codeSummary = await summarizeTool.handler({ text: codeText, mode: "code", maxTokens: 120 }, toolContext);
  const codeRecord = codeSummary && typeof codeSummary === "object" ? codeSummary as Record<string, unknown> : {};
  const codeBytes = Buffer.byteLength(JSON.stringify(codeSummary), "utf8");
  const codeOk = codeRecord.mode === "code" && codeRecord.kind === "code" && codeBytes <= 120 * 4;
  console.log(`${codeOk ? "[ok]" : "[FAIL]"} ctx_summarize code mode is deterministic and bounded (${codeBytes} bytes)`);
  if (!codeOk) toolFailures++;
  const objectText = JSON.stringify(Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`key${index}`, "x".repeat(180)])));
  const objectSummary = await summarizeTool.handler({ text: objectText, mode: "structural", maxTokens: 120 }, toolContext);
  const objectBytes = Buffer.byteLength(JSON.stringify(objectSummary), "utf8");
  const objectOk = objectBytes <= 120 * 4;
  console.log(`${objectOk ? "[ok]" : "[FAIL]"} ctx_summarize JSON mode is bounded (${objectBytes} bytes)`);
  if (!objectOk) toolFailures++;
  const invalid = await summarizeTool.handler({ text: "x", mode: "code-ish" }, toolContext);
  const invalidRecord = invalid && typeof invalid === "object" ? invalid as Record<string, unknown> : {};
  const invalidOk = invalidRecord.code === "invalid_summary_mode" && Array.isArray(invalidRecord.allowedModes);
  console.log(`${invalidOk ? "[ok]" : "[FAIL]"} ctx_summarize rejects unknown modes`);
  if (!invalidOk) toolFailures++;
}

console.log(`Tool checks: ${toolFailures === 0 ? "passed" : `${toolFailures} failed`}.`);
process.exit(toolFailures + scopeFailures > 0 ? 1 : 0);
