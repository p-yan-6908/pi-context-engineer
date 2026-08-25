export interface BenchmarkEnvironment {
  sourceCommit: string;
  dirty: boolean;
  nodeVersion: string;
  piVersion: string | null;
  fabricVersion: string | null;
  model: string | null;
  provider: string | null;
  iterations: number;
  warmupIterations: number;
}

export interface BenchmarkMetrics {
  mode: "baseline" | "ce";
  /** Total Main-context exposure; input + output. */
  mainContextTokens: number;
  mainContextInputTokens: number;
  mainContextOutputTokens: number;
  mainContextInjectedTokens: number;
  toolResultTokens: number;
  childModelTokens: number;
  internalWorkTokens: number;
  wallTimeMs: number;
  wallTimeP95Ms: number;
  diskBytesWritten: number;
  bytesOffloaded: number;
  ctxReadBytesRetrieved: number;
  finalAnswerCorrect: boolean;
  taskCompleted: boolean;
  mainTokensPrevented: number;
  extraInternalTokens: number;
  mainTokensInjected: number;
  contextEfficiency: number;
  qualityAdjustedSavings: number;
}

export interface BenchmarkSample {
  iteration: number;
  baseline: BenchmarkMetrics;
  ce: BenchmarkMetrics;
}

export interface BenchmarkReportRow {
  id: string;
  title: string;
  task: string;
  baseline: BenchmarkMetrics;
  ce: BenchmarkMetrics;
  samples: BenchmarkSample[];
}

export interface BenchmarkReport {
  generatedAt: string;
  environment: BenchmarkEnvironment;
  cases: number;
  correct: number;
  mainContextBaseline: number;
  mainContextWithCE: number;
  reductionPercent: number;
  rows: BenchmarkReportRow[];
}

function number(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function ratio(value: number): string {
  return `${value.toFixed(2)}x`;
}

export function renderMarkdown(report: BenchmarkReport): string {
  const rows = report.rows;
  const totalBaseline = rows.reduce((sum, row) => sum + row.baseline.mainContextTokens, 0);
  const totalCe = rows.reduce((sum, row) => sum + row.ce.mainContextTokens, 0);
  const totalSaved = rows.reduce((sum, row) => sum + row.ce.mainTokensPrevented, 0);
  const totalInternal = rows.reduce((sum, row) => sum + row.ce.extraInternalTokens, 0);
  const totalInjected = rows.reduce((sum, row) => sum + row.ce.mainTokensInjected, 0);
  const totalCorrect = rows.filter((row) => row.ce.finalAnswerCorrect && row.ce.taskCompleted).length;
  const totalEfficiency = totalSaved / Math.max(1, totalInternal + totalInjected);

  const lines = [
    `# Context Engineer benchmark`,
    `Generated: ${report.generatedAt}`,
    `Environment: sourceCommit ${report.environment.sourceCommit}${report.environment.dirty ? " (dirty)" : ""}; Node ${report.environment.nodeVersion}; Pi ${report.environment.piVersion ?? "unknown"}; Fabric ${report.environment.fabricVersion ?? "unknown"}; model ${report.environment.model ?? "none"}.`,
    `Iterations: ${report.environment.iterations} (warmup ${report.environment.warmupIterations}).`,
    ``,
    `Each case runs a raw-result baseline and the same deterministic workload with CE storage/selection/compression.`,
    ``,
    `| Case | Baseline Main | CE Main | Prevented | CE internal | Efficiency | CE median ms | CE p95 ms | Correct | Disk bytes |`,
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: | ---: |`,
  ];
  for (const row of rows) {
    lines.push(`| ${row.id} | ${number(row.baseline.mainContextTokens)} | ${number(row.ce.mainContextTokens)} | ${number(row.ce.mainTokensPrevented)} | ${number(row.ce.extraInternalTokens)} | ${ratio(row.ce.contextEfficiency)} | ${row.ce.wallTimeMs.toFixed(2)} | ${row.ce.wallTimeP95Ms.toFixed(2)} | ${row.ce.finalAnswerCorrect && row.ce.taskCompleted ? "yes" : "NO"} | ${number(row.ce.diskBytesWritten)} |`);
  }
  lines.push(
    ``,
    `## Totals`,
    ``,
    `- Main context: ${number(totalBaseline)} → ${number(totalCe)} tokens (${number(totalSaved)} prevented; ${percent(totalSaved / Math.max(1, totalBaseline))} reduction).`,
    `- Quality-adjusted savings: ${number(rows.reduce((sum, row) => sum + row.ce.qualityAdjustedSavings, 0))} tokens.`,
    `- CE success: ${totalCorrect}/${rows.length} cases.`,
    `- Context efficiency: ${ratio(totalEfficiency)} (prevented / (extra internal + Main tokens injected)).`,
    `- CE disk bytes written: ${number(rows.reduce((sum, row) => sum + row.ce.diskBytesWritten, 0))}; logical bytes offloaded: ${number(rows.reduce((sum, row) => sum + row.ce.bytesOffloaded, 0))}; selected bytes retrieved: ${number(rows.reduce((sum, row) => sum + row.ce.ctxReadBytesRetrieved, 0))}.`,
  );
  return lines.join("\n");
}
