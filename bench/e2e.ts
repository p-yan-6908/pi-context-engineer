import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface Scenario {
  name: string;
  marker: string;
  prompt: string;
  assert: (output: string) => boolean;
}

const scenarios: Scenario[] = [
  {
    name: "fabric boundary offload and ctx_read recovery",
    marker: "E2E-READ-MARKER",
    prompt: `Use fabric_exec exactly once. Inside Fabric run this code: const raw = await pi.bash({ cmd: "node -e 'process.stdout.write(\\\"E2E-READ-MARKER\\\" + \\\"x\\\".repeat(100000))'" }); return raw; The final answer must include the exact marker E2E-READ-MARKER and state whether you used ctx_read to recover it.`,
    assert: (output) => output.includes("E2E-READ-MARKER") && /ctx_read|re-read|recovered/i.test(output),
  },
  {
    name: "hierarchical bounded summary",
    marker: "E2E-SUMMARY-MARKER",
    prompt: `Use fabric_exec exactly once. Inside Fabric create text beginning with E2E-SUMMARY-MARKER and then at least 120000 ASCII characters, and call extensions.ctx_summarize({ text, mode: "model", maxTokens: 120, maxInputTokens: 1024 }). Return only the summary object. The final answer must include E2E-SUMMARY-MARKER and report the bounded summary token count.`,
    assert: (output) => output.includes("E2E-SUMMARY-MARKER") && /120|summary/i.test(output),
  },
];

if (process.env.CE_RUN_E2E !== "1") {
  console.log("E2E smoke tests skipped; set CE_RUN_E2E=1 and provide a configured Pi model to run them.");
  process.exit(0);
}

const piCommand = process.env.PI_BIN ?? "pi";
const modelArgs = process.env.PI_MODEL ? ["--model", process.env.PI_MODEL] : [];
const extension = resolve(".tmp/pi-ce-build/index.js");
const fabricExtension = resolve("node_modules/pi-fabric/dist/index.js");
if (!existsSync(extension)) throw new Error("Build CE first: .tmp/pi-ce-build/index.js is missing.");
if (!existsSync(fabricExtension)) throw new Error("Install the optional pi-fabric peer before running E2E smoke tests.");

let failures = 0;
for (const scenario of scenarios) {
  const result = spawnSync(piCommand, [
    ...modelArgs,
    "--no-extensions",
    "--print",
    "--mode", "json",
    "--no-session",
    "--offline",
    "--extension", extension,
    "--extension", fabricExtension,
    scenario.prompt,
  ], { encoding: "utf8", timeout: 180_000, maxBuffer: 2_000_000 });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const ok = result.status === 0 && scenario.assert(output);
  console.log(`[${ok ? "ok" : "FAIL"}] ${scenario.name}`);
  if (!ok) {
    failures++;
    console.log(output.slice(-2000));
  }
}
console.log(`Pi/Fabric E2E: ${scenarios.length - failures} passed, ${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
