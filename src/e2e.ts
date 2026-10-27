/** Provider-backed plumbing smoke tests only; these are not agent-effectiveness evidence. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveFabricExtension } from "./benchmark.js";

export interface SmokeScenario {
  name: string;
  program: string;
  prompt: string;
  assert: (answer: string, results: any[], workspace: string) => boolean;
}

const readCommand = `node -e 'process.stdout.write("x".repeat(5000) + "E2E-READ-MARKER" + "x".repeat(15000))'`;
const readProgram = `const raw = await pi.bash({ cmd: ${JSON.stringify(readCommand)} }); return raw;`;

export const smokeScenarios: SmokeScenario[] = [
  {
    name: "Fabric boundary offload and recovery",
    program: readProgram,
    prompt: `Run this code in fabric_exec: ${readProgram} Then use another fabric_exec call with extensions.ctx_read and the returned handle to locate the marker in the stored payload. Return the recovered marker and state that recovery succeeded. Additional bounded reads are allowed.`,
    assert: (answer, results) => answer.includes("E2E-READ-MARKER") && /recover/i.test(answer) &&
      results.some(result => result.details?.ce_offloaded === true) && results.filter(result => result.isError !== true).length >= 2,
  },
];

/** The last non-empty assistant text in a Pi JSON event stream. */
function finalAnswerFromEvents(events: readonly any[]): string {
  const texts = events
    .filter(event => event?.type === "message_end" && event.message?.role === "assistant")
    .map(event => (event.message.content ?? []).map((block: any) => block?.type === "text" ? block.text : "").join(""));
  return texts.reverse().find(text => text.trim()) ?? "";
}

export function runSmokeTests(): void {
  if (process.env.CE_RUN_E2E !== "1") {
    console.log("E2E smoke tests skipped; set CE_RUN_E2E=1 and PI_MODEL explicitly to opt in.");
    return;
  }
  if (!process.env.PI_MODEL) throw new Error("Set PI_MODEL explicitly before opting into provider-backed smoke tests.");
  const extension = resolve(".tmp/pi-ce-build/index.js");
  const fabricExtension = resolveFabricExtension();
  if (!existsSync(extension)) throw new Error("Build CE first: .tmp/pi-ce-build/index.js is missing.");
  let failures = 0;
  for (const scenario of smokeScenarios) {
    const workspace = mkdtempSync(join(tmpdir(), "ce-smoke-"));
    try {
      mkdirSync(join(workspace, ".pi"));
      writeFileSync(join(workspace, ".pi/context-engineer.json"), JSON.stringify({ notifyOnStart: false }));
      const result = spawnSync(process.env.PI_BIN ?? "pi", [
        "--model", process.env.PI_MODEL, "--no-extensions", "--no-skills", "--no-context-files",
        "--no-prompt-templates", "--no-themes", "--no-approve", "--print", "--mode", "json", "--no-session",
        "--extension", extension, "--extension", fabricExtension, "--", scenario.prompt,
      ], { cwd: workspace, encoding: "utf8", timeout: 180_000, maxBuffer: 8_000_000 });
      const events: any[] = [];
      let malformed = false;
      for (const line of (result.stdout ?? "").split("\n").filter(line => line.trim())) {
        try { events.push(JSON.parse(line)); } catch { malformed = true; }
      }
      const answer = finalAnswerFromEvents(events);
      const toolResults = events.filter(event => event.type === "message_end" && event.message?.role === "toolResult").map(event => event.message);
      const ok = !result.error && result.status === 0 && !malformed && scenario.assert(answer, toolResults, workspace);
      console.log(`[${ok ? "ok" : "FAIL"}] ${scenario.name}`);
      if (!ok) {
        failures++;
        console.log(`${result.error?.message ?? ""}\n${result.stderr ?? ""}\n${answer}`.slice(-2000));
      }
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  }
  console.log(`Pi/Fabric E2E plumbing: ${smokeScenarios.length - failures} passed, ${failures} failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runSmokeTests();
