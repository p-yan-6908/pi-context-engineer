/** Opt-in task-level CE on/off benchmark. No provider calls unless explicitly enabled. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

export interface BenchmarkMetrics {
  answer: string;
  modelRequests: number;
  /** Model-issued calls; recorded native nested calls are reported separately. */
  toolCalls: number;
  nestedToolCalls: number;
  nestedCallsComplete: boolean | null;
  firstToolName?: string;
  firstToolCode?: string;
  recoveryCalls: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Uncached + cache reads + cache writes; not just the current context size. */
  inputTokens: number;
  outputTokens: number;
  reportedCost: number;
  usageRecords: number;
  /** Assistant messages without usage, and present usage records missing required counters. */
  missingUsageRequests: number;
  incompleteUsageRecords: number;
  usageComplete: boolean;
  costReported: boolean;
  costComplete: boolean;
  malformed: boolean;
}

/** Count each finalized message once; never sum stream deltas or agent_end copies. */
export function parseBenchmarkEvents(stdout: string): BenchmarkMetrics {
  const metrics: BenchmarkMetrics = {
    answer: "", modelRequests: 0, toolCalls: 0, nestedToolCalls: 0, nestedCallsComplete: null, recoveryCalls: 0,
    uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    inputTokens: 0, outputTokens: 0, reportedCost: 0, usageRecords: 0,
    missingUsageRequests: 0, incompleteUsageRecords: 0, usageComplete: false,
    costReported: false, costComplete: false, malformed: false,
  };
  const validNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const number = (value: unknown): number => validNumber(value) ? value : 0;
  let missingCostRecords = 0;
  for (const line of stdout.split("\n").filter(line => line.trim())) {
    let event: any;
    try { event = JSON.parse(line); } catch { metrics.malformed = true; continue; }
    if (event?.type !== "message_end") continue;
    const message = event.message;
    if (message?.role === "assistant") {
      metrics.modelRequests++;
      if (!message.usage) metrics.missingUsageRequests++;
      const text = (message.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => part.text).join("");
      if (text.trim()) metrics.answer = text.trim();
      for (const call of (message.content ?? []).filter((part: any) => part?.type === "toolCall")) {
        if (metrics.toolCalls === 0) {
          metrics.firstToolName = call.name;
          metrics.firstToolCode = call.arguments?.code ?? call.arguments?.program;
        }
        metrics.toolCalls++;
        if (call.name === "ctx_read" || call.name === "ctx_summarize" ||
          (call.name === "fabric_exec" && /\bctx_(read|summarize)\b/.test(String(call.arguments?.code ?? call.arguments?.program ?? "")))) metrics.recoveryCalls++;
      }
    }
    if (message?.role === "toolResult" && Array.isArray(message.nestedCalls?.calls)) {
      metrics.nestedToolCalls += message.nestedCalls.calls.length;
      metrics.nestedCallsComplete = (metrics.nestedCallsComplete ?? true) && message.nestedCalls.complete === true;
    }
    // Native Pi rolls nested tool usage into the outer tool result; don't count
    // nested execution events separately or their usage would be duplicated.
    if ((message?.role === "assistant" || message?.role === "toolResult") && message.usage) {
      const usage = message.usage;
      metrics.usageRecords++;
      if (![usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(validNumber)) metrics.incompleteUsageRecords++;
      metrics.uncachedInputTokens += number(usage.input);
      metrics.cacheReadTokens += number(usage.cacheRead);
      metrics.cacheWriteTokens += number(usage.cacheWrite);
      metrics.outputTokens += number(usage.output);
      if (validNumber(usage.cost?.total)) {
        metrics.costReported = true; metrics.reportedCost += usage.cost.total;
      } else missingCostRecords++;
    }
  }
  metrics.inputTokens = metrics.uncachedInputTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens;
  metrics.usageComplete = metrics.modelRequests > 0 && !metrics.malformed &&
    metrics.missingUsageRequests === 0 && metrics.incompleteUsageRecords === 0;
  metrics.costComplete = metrics.usageComplete && missingCostRecords === 0;
  return metrics;
}

export function resolveFabricExtension(): string {
  if (process.env.PI_FABRIC_EXTENSION) {
    const path = resolve(process.env.PI_FABRIC_EXTENSION);
    if (!existsSync(path)) throw new Error(`PI_FABRIC_EXTENSION does not exist: ${path}`);
    return path;
  }
  try {
    const entry = createRequire(import.meta.url).resolve("pi-fabric");
    const bootstrap = join(dirname(entry), "extension-bootstrap.js");
    if (existsSync(bootstrap)) return bootstrap;
    return entry; // Older Fabric packages export the extension directly.
  } catch { throw new Error("Install the optional pi-fabric peer, or set PI_FABRIC_EXTENSION to its extension-bootstrap.js."); }
}

/** Never present incomplete arm totals as fully measured usage or cost. */
export function summarizeBenchmarkRuns(runs: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [false, true].map(enabled => {
    const arm = runs.filter(run => run.enabled === enabled);
    const sum = (key: string): number => arm.reduce((total, run) => total + Number(run[key] ?? 0), 0);
    const completeUsage = arm.length > 0 && arm.every(run => run.measured === true);
    const completeCost = arm.length > 0 && arm.every(run => run.costComplete === true);
    return { enabled, runs: arm.length, successes: arm.filter(run => run.succeeded).length,
      measuredRuns: arm.filter(run => run.measured).length, costMeasuredRuns: arm.filter(run => run.costComplete).length,
      inputTokens: completeUsage ? sum("inputTokens") : null,
      cacheReadTokens: completeUsage ? sum("cacheReadTokens") : null,
      cacheWriteTokens: completeUsage ? sum("cacheWriteTokens") : null,
      toolCalls: sum("toolCalls"), nestedToolCalls: sum("nestedToolCalls"), recoveryCalls: sum("recoveryCalls"),
      latencyMs: sum("latencyMs"), reportedCost: completeCost ? sum("reportedCost") : null };
  });
}

export function runBenchmark(): void {
  if (process.env.CE_RUN_BENCHMARK !== "1") {
    console.log("Benchmark skipped. Opt in with CE_RUN_BENCHMARK=1 and PI_MODEL; this incurs provider usage.");
    return;
  }
  const model = process.env.PI_MODEL;
  if (!model) throw new Error("Set PI_MODEL explicitly before opting into the provider-backed benchmark.");
  const extension = resolve(".tmp/pi-ce-build/index.js");
  if (!existsSync(extension)) throw new Error("Build CE first.");
  const fabric = resolveFabricExtension();
  const skill = resolve("skills/context-engineer/SKILL.md");
  const includeSkill = process.env.CE_BENCH_SKILL !== "0";
  const skillBytes = includeSkill ? Buffer.byteLength(readFileSync(skill, "utf8")) : 0;
  const rounds = Math.max(1, Math.min(10, Math.floor(Number(process.env.CE_BENCH_ROUNDS) || 1)));
  const runs: Array<Record<string, unknown>> = [];
  for (let round = 0; round < rounds; round++) {
    for (const [taskIndex, task] of ["lookup", "count"].entries()) {
      const value = `VALUE_${randomUUID().replaceAll("-", "")}`;
      const lines = Array.from({ length: 1000 }, (_, i) => `row ${String(i).padStart(4, "0")} status=${i % 7 === 0 ? "FAIL" : "OK"} value=abcdefgh`);
      if (task === "lookup") lines[500] = `TARGET_VALUE: ${value}`;
      const fixture = lines.join("\n");
      const expected = task === "lookup" ? value : String(lines.filter(line => line.includes("status=FAIL")).length);
      // Alternate order, retain every run (including failures), and expose cache
      // usage rather than silently treating cached input as free.
      const arms = (round + taskIndex) % 2 ? [true, false] : [false, true];
      for (const enabled of arms) {
        const workspace = mkdtempSync(join(tmpdir(), "ce-benchmark-"));
        try {
          mkdirSync(join(workspace, ".pi"));
          writeFileSync(join(workspace, ".pi/context-engineer.json"), JSON.stringify({ enabled, notifyOnStart: false }));
          writeFileSync(join(workspace, "fixture.txt"), fixture);
          const program = 'return await pi.read({ path: "fixture.txt" });';
          const question = task === "lookup" ? "Return only the value on the TARGET_VALUE line." : "Return only the number of lines containing status=FAIL.";
          const prompt = `First call fabric_exec with exactly this code: ${program} Set maxOutputTokens to 20000 so this first result is not caller-truncated. Then answer the question using the returned data. If it is offloaded, recover from its handle; do not re-run the first read. You may use further bounded tools or code. ${question}`;
          const args = ["--model", model, "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-approve", "--print", "--mode", "json", "--no-session", "--extension", fabric];
          if (enabled) {
            args.push("--extension", extension);
            // Explicit cold-start skill loading is included in provider input,
            // not added again as a hand-estimated token cost.
            if (includeSkill) args.push("--append-system-prompt", skill);
          }
          args.push("--", prompt);
          const start = performance.now();
          const child = spawnSync(process.env.PI_BIN ?? "pi", args, { cwd: workspace, encoding: "utf8", timeout: 180_000, maxBuffer: 16_000_000 });
          const latencyMs = Math.round(performance.now() - start);
          const metrics = parseBenchmarkEvents(child.stdout ?? "");
          const protocolFollowed = metrics.firstToolName === "fabric_exec" && metrics.firstToolCode?.trim() === program;
          const answerCorrect = metrics.answer === expected;
          const succeeded = !child.error && child.status === 0 && !metrics.malformed && answerCorrect && protocolFollowed;
          runs.push({ task, round, enabled, latencyMs, succeeded, answerCorrect, protocolFollowed, measured: metrics.usageComplete && metrics.inputTokens > 0,
            skillBytes: enabled ? skillBytes : 0, ...metrics,
            ...(!succeeded ? { error: (child.error?.message ?? child.stderr ?? "incorrect final answer").slice(-1000) } : {}) });
        } finally { rmSync(workspace, { recursive: true, force: true }); }
      }
    }
  }
  const report = {
    version: 2, model, rounds, skillMode: includeSkill ? "cold-start full CE skill" : "no skill",
    notes: "Provider-reported usage includes schemas, system instructions, notices, recovery turns, and repeated history. Incomplete usage or cost makes the corresponding arm total null; per-run totals may be partial. Cost uses provider/model price estimates, not invoices. Compare quality before savings; order and caches can affect results.",
    runs,
    summary: summarizeBenchmarkRuns(runs),
  };
  const output = resolve(process.env.CE_BENCH_OUTPUT ?? ".tmp/ce-benchmark.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, summary: report.summary }, null, 2));
  if (runs.some(run => !run.succeeded || !run.measured)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runBenchmark();
