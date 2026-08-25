import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "../src/store.js";
import { ceToolMap } from "../src/tools.js";
import { renderMarkdown, type BenchmarkEnvironment, type BenchmarkMetrics, type BenchmarkReport, type BenchmarkReportRow, type BenchmarkSample } from "./report.js";

interface CaseDefinition {
  id: string;
  title: string;
  kind: "query" | "json-query" | "repeated" | "parallel" | "select" | "summary" | "nested";
  targetBytes: number;
  marker: string;
  query?: string;
  segments?: string[];
  count?: number;
  task: string;
  summaryMode?: "structural" | "code" | "model";
  maxTokens?: number;
  maxInputTokens?: number;
}

type Payload = string | string[];

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function tokenEstimate(value: unknown): number {
  return Math.ceil(bytes(typeof value === "string" ? value : JSON.stringify(value)) / 4);
}

function padAscii(prefix: string, targetBytes: number): string {
  let output = prefix;
  let line = 0;
  while (bytes(output) < targetBytes) {
    output += `routine-${line++}: ${"x".repeat(72)}\n`;
  }
  return output.slice(0, targetBytes);
}

function makePayload(definition: CaseDefinition, marker = definition.marker): string {
  if (definition.kind === "json-query") {
    const records: Array<Record<string, unknown>> = [];
    let index = 0;
    while (bytes(records.map((record) => JSON.stringify(record)).join("\n")) < definition.targetBytes) {
      records.push({
        id: `record-${index}`,
        status: index % 3 === 0 ? "open" : "closed",
        note: index === 42 ? marker : `routine record ${index}`,
        values: [index, index + 1, index + 2],
      });
      index++;
    }
    return records.map((record) => JSON.stringify(record)).join("\n");
  }

  if (definition.kind === "select") {
    const head = `export function ${marker}() { return "target"; }\n`;
    return padAscii(head, definition.targetBytes);
  }

  if (definition.kind === "summary") {
    const head = `export const ${marker} = "important export";\nexport function summarizeTarget() { return ${JSON.stringify(marker)}; }\n`;
    return padAscii(head, definition.targetBytes);
  }

  if (definition.kind === "repeated") {
    const sections = (definition.segments ?? []).map((segment) => `${segment}: ${"section-data ".repeat(16)}\n`).join("");
    return padAscii(sections, definition.targetBytes);
  }

  const head = `${marker}: ${definition.task}\n`;
  return padAscii(head, definition.targetBytes);
}

function payloadsFor(definition: CaseDefinition): string[] {
  if (definition.kind !== "parallel") return [makePayload(definition)];
  return Array.from({ length: definition.count ?? 1 }, (_, index) => makePayload(definition, `${definition.marker}-${index + 1}`));
}

function fileBytes(path: string): number {
  let total = 0;
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    const info = statSync(child);
    total += info.isDirectory() ? fileBytes(child) : info.size;
  }
  return total;
}

function contains(value: unknown, needle: string): boolean {
  return JSON.stringify(value).includes(needle);
}

function commandText(command: string, args: string[] = []): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function aggregateMetrics(samples: BenchmarkMetrics[], mode: BenchmarkMetrics["mode"]): BenchmarkMetrics {
  const numeric = <K extends keyof BenchmarkMetrics>(key: K): number => median(samples.map((sample) => Number(sample[key])));
  return {
    mode,
    mainContextTokens: numeric("mainContextTokens"),
    mainContextInputTokens: numeric("mainContextInputTokens"),
    mainContextOutputTokens: numeric("mainContextOutputTokens"),
    mainContextInjectedTokens: numeric("mainContextInjectedTokens"),
    toolResultTokens: numeric("toolResultTokens"),
    childModelTokens: numeric("childModelTokens"),
    internalWorkTokens: numeric("internalWorkTokens"),
    wallTimeMs: numeric("wallTimeMs"),
    wallTimeP95Ms: percentile(samples.map((sample) => sample.wallTimeMs), 0.95),
    diskBytesWritten: numeric("diskBytesWritten"),
    bytesOffloaded: numeric("bytesOffloaded"),
    ctxReadBytesRetrieved: numeric("ctxReadBytesRetrieved"),
    finalAnswerCorrect: samples.every((sample) => sample.finalAnswerCorrect),
    taskCompleted: samples.every((sample) => sample.taskCompleted),
    mainTokensPrevented: numeric("mainTokensPrevented"),
    extraInternalTokens: numeric("extraInternalTokens"),
    mainTokensInjected: numeric("mainTokensInjected"),
    contextEfficiency: numeric("contextEfficiency"),
    qualityAdjustedSavings: numeric("qualityAdjustedSavings"),
  };
}

function benchmarkEnvironment(iterations: number, warmupIterations: number): BenchmarkEnvironment {
  const model = process.env.PI_MODEL ?? null;
  let fabricVersion: string | null = null;
  try {
    fabricVersion = (JSON.parse(readFileSync(join(process.cwd(), "node_modules/pi-fabric/package.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    fabricVersion = null;
  }
  const dirtyState = commandText("git", ["status", "--porcelain"]);
  return {
    sourceCommit: commandText("git", ["rev-parse", "HEAD"]) ?? "unknown",
    dirty: Boolean(dirtyState),
    nodeVersion: process.version,
    piVersion: commandText("pi", ["--version"]),
    fabricVersion,
    model,
    provider: process.env.PI_PROVIDER ?? (model?.includes("/") ? model.split("/", 1)[0] : null),
    iterations,
    warmupIterations,
  };
}

function baselineMetrics(definition: CaseDefinition, payloads: string[]): BenchmarkMetrics {
  const started = Date.now();
  const boundary = definition.kind === "repeated"
    ? Array.from({ length: definition.segments?.length ?? 3 }, () => payloads[0])
    : definition.kind === "parallel" ? payloads : payloads[0];
  const mainContextTokens = tokenEstimate(boundary);
  const finalAnswerCorrect = definition.kind === "parallel"
    ? payloads.every((payload, index) => contains(payload, `${definition.marker}-${index + 1}`))
    : contains(boundary, definition.marker);
  return {
    mode: "baseline",
    mainContextTokens,
    mainContextInputTokens: mainContextTokens,
    mainContextOutputTokens: 0,
    mainContextInjectedTokens: mainContextTokens,
    toolResultTokens: mainContextTokens,
    childModelTokens: 0,
    internalWorkTokens: 0,
    wallTimeMs: Math.max(0.1, Date.now() - started),
    wallTimeP95Ms: Math.max(0.1, Date.now() - started),
    diskBytesWritten: 0,
    bytesOffloaded: 0,
    ctxReadBytesRetrieved: 0,
    finalAnswerCorrect,
    taskCompleted: finalAnswerCorrect,
    mainTokensPrevented: 0,
    extraInternalTokens: 0,
    mainTokensInjected: mainContextTokens,
    contextEfficiency: 0,
    qualityAdjustedSavings: 0,
  };
}

async function ceMetrics(definition: CaseDefinition, payloads: string[], baseline: BenchmarkMetrics): Promise<BenchmarkMetrics> {
  const started = Date.now();
  const workspace = mkdtempSync(join(tmpdir(), "pi-ce-benchmark-"));
  let finalAnswerCorrect = false;
  let taskCompleted = false;
  let childModelTokens = 0;
  let ctxReadBytesRetrieved = 0;
  let mainBoundary: unknown;

  try {
    const store = new ContextStore(workspace, ".pi/context-store", { ttlMs: 0, maxBytes: 30_000_000 });
    const handles = payloads.map((payload, index) => store.write(`${definition.id}-${index}`, "benchmark", payload, { deduplicate: true }));
    const previews = handles.map((handle) => ({ id: handle.id, bytes: handle.bytes, preview: handle.preview }));
    const readQuery = (id: string, query: string): unknown => {
      const result = store.read(id, { query, contextLines: 0, maxMatches: 5 });
      if (typeof result.bytesRead === "number") ctxReadBytesRetrieved += result.bytesRead;
      return result;
    };
    const readRange = (id: string, length: number): unknown => {
      const result = store.read(id, { offset: 0, length });
      if (typeof result.bytesRead === "number") ctxReadBytesRetrieved += result.bytesRead;
      return result;
    };

    if (definition.kind === "repeated") {
      const proof = (definition.segments ?? []).map((segment) => readQuery(handles[0].id, segment));
      mainBoundary = { handle: previews[0], proof };
      finalAnswerCorrect = (definition.segments ?? []).every((segment) => contains(proof, segment));
    } else if (definition.kind === "parallel") {
      const proof = handles.map((handle) => readRange(handle.id, 280));
      mainBoundary = { handles: previews, proof };
      finalAnswerCorrect = proof.every((value, index) => contains(value, `${definition.marker}-${index + 1}`));
    } else if (definition.kind === "summary") {
      const summaryTool = ceToolMap.get("ctx_summarize");
      if (!summaryTool) throw new Error("ctx_summarize is not registered");
      const context = {
        store,
        workspaceRoot: workspace,
        maxReturnBytes: 8192,
        callTool: async () => ({}),
        spawnAgent: async () => "",
        modelCall: async (prompt: string, maxTokens?: number) => {
          childModelTokens += tokenEstimate(prompt) + Math.min(maxTokens ?? 160, 160);
          return prompt.includes(definition.marker) ? `Finding: ${definition.marker}` : "No target marker in this chunk.";
        },
      } as any;
      const summary = await summaryTool.handler({
        id: handles[0].id,
        mode: definition.summaryMode ?? "code",
        maxTokens: definition.maxTokens ?? 180,
        maxInputTokens: definition.maxInputTokens ?? 1024,
      }, context);
      mainBoundary = { handle: previews[0], summary };
      finalAnswerCorrect = contains(summary, definition.marker);
    } else {
      const proof = readQuery(handles[0].id, definition.query ?? definition.marker);
      mainBoundary = { handle: previews[0], proof };
      finalAnswerCorrect = contains(proof, definition.marker);
    }

    taskCompleted = finalAnswerCorrect;
    const mainContextTokens = tokenEstimate(mainBoundary);
    const mainTokensPrevented = Math.max(0, baseline.mainContextTokens - mainContextTokens);
    const extraInternalTokens = childModelTokens;
    return {
      mode: "ce",
      mainContextTokens,
      mainContextInputTokens: mainContextTokens,
      mainContextOutputTokens: 0,
      mainContextInjectedTokens: mainContextTokens,
      toolResultTokens: mainContextTokens,
      childModelTokens,
      internalWorkTokens: 0,
      wallTimeMs: Math.max(0.1, Date.now() - started),
      wallTimeP95Ms: Math.max(0.1, Date.now() - started),
      diskBytesWritten: fileBytes(workspace),
      bytesOffloaded: payloads.reduce((sum, payload) => sum + bytes(payload), 0),
      ctxReadBytesRetrieved,
      finalAnswerCorrect,
      taskCompleted,
      mainTokensPrevented,
      extraInternalTokens,
      mainTokensInjected: mainContextTokens,
      contextEfficiency: mainTokensPrevented / Math.max(1, extraInternalTokens + mainContextTokens),
      qualityAdjustedSavings: finalAnswerCorrect && taskCompleted ? mainTokensPrevented : 0,
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function loadCases(): CaseDefinition[] {
  const directory = join(process.cwd(), "bench", "cases");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as CaseDefinition);
}

const iterations = Math.max(1, Math.min(30, Math.floor(Number(process.env.CE_BENCHMARK_ITERATIONS) || 3)));
const warmupIterations = Math.max(0, Math.min(10, Math.floor(Number(process.env.CE_BENCHMARK_WARMUP) || 1)));
const rows: BenchmarkReportRow[] = [];
for (const definition of loadCases()) {
  const payloads = payloadsFor(definition);
  for (let warmup = 0; warmup < warmupIterations; warmup++) {
    const baseline = baselineMetrics(definition, payloads);
    await ceMetrics(definition, payloads, baseline);
  }

  const samples: BenchmarkSample[] = [];
  for (let iteration = 1; iteration <= iterations; iteration++) {
    const baseline = baselineMetrics(definition, payloads);
    const ce = await ceMetrics(definition, payloads, baseline);
    samples.push({ iteration, baseline, ce });
  }

  const baseline = aggregateMetrics(samples.map((sample) => sample.baseline), "baseline");
  const ce = aggregateMetrics(samples.map((sample) => sample.ce), "ce");
  ce.mainTokensPrevented = Math.max(0, baseline.mainContextTokens - ce.mainContextTokens);
  ce.extraInternalTokens = Math.max(0, ce.childModelTokens + ce.internalWorkTokens - baseline.childModelTokens - baseline.internalWorkTokens);
  ce.mainTokensInjected = ce.mainContextInjectedTokens;
  ce.contextEfficiency = ce.mainTokensPrevented / Math.max(1, ce.extraInternalTokens + ce.mainTokensInjected);
  ce.qualityAdjustedSavings = ce.finalAnswerCorrect && ce.taskCompleted ? ce.mainTokensPrevented : 0;
  rows.push({ id: definition.id, title: definition.title, task: definition.task, baseline, ce, samples });
}

const environment = benchmarkEnvironment(iterations, warmupIterations);
const mainContextBaseline = rows.reduce((sum, row) => sum + row.baseline.mainContextTokens, 0);
const mainContextWithCE = rows.reduce((sum, row) => sum + row.ce.mainContextTokens, 0);
const report: BenchmarkReport = {
  generatedAt: new Date().toISOString(),
  environment,
  cases: rows.length,
  correct: rows.filter((row) => row.ce.finalAnswerCorrect && row.ce.taskCompleted).length,
  mainContextBaseline,
  mainContextWithCE,
  reductionPercent: ((mainContextBaseline - mainContextWithCE) / Math.max(1, mainContextBaseline)) * 100,
  rows,
};
const outputPath = process.env.CE_BENCHMARK_OUT ?? join(process.cwd(), ".tmp", "context-benchmark.json");
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2));
console.log(renderMarkdown(report));
console.log(`\nJSON report: ${outputPath}`);
const regressions = rows.filter((row) =>
  !row.ce.finalAnswerCorrect ||
  !row.ce.taskCompleted ||
  row.ce.mainContextTokens >= row.baseline.mainContextTokens
);
if (regressions.length > 0) {
  console.error(`Benchmark regressions: ${regressions.map((row) => row.id).join(", ")}`);
  process.exitCode = 1;
}
