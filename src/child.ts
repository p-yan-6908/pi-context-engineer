import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Usage as PiUsage } from "@earendil-works/pi-ai";
import { mergeUsage, readUsage } from "./usage.js";
import {
  CHILD_BUDGET_METADATA_KEY,
  flagsForBudgetEnforcement,
  type BudgetEnforcementFlags,
  type BudgetEnforcementMode,
} from "./child-budget.js";

export type { BudgetEnforcementFlags, BudgetEnforcementMode } from "./child-budget.js";

/** The pi-ai usage shape reported by each completed assistant generation. */
export type Usage = PiUsage;

export interface ChildPiOptions {
  cwd: string;
  model?: string;
  /** Disable all model tool calls; used for pure summarization. */
  noTools?: boolean;
  /** Load Context Engineer, restricted to ctx_read, in this otherwise isolated child. */
  loadContextEngineer?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Requested generation budget; provider caps are exact only where the adapter supports them (Codex uses an approximate stream guard). */
  maxTokens?: number;
  /** Maximum number of provider turns/attempts in this isolated operation. */
  maxTurns?: number;
}

export interface ChildPiResult {
  text: string;
  /** Sum of provider-reported Usage values, when at least one was observed. */
  usage?: Usage;
  /** False when any generated assistant message had no complete provider usage. */
  usageComplete: boolean;
  /** Explicit inverse signal for callers that need to distinguish unknown usage. */
  missingUsage: boolean;
  /** Number of turn_start events observed in the child JSON stream. */
  turns: number;
  /** True when a successful assistant generation ended with stopReason=length. */
  outputTruncated: boolean;
  /** "provider" is an adapter cap; "stream" is the approximate Codex fallback. */
  budgetEnforcement: BudgetEnforcementMode;
  /** Limitations of the selected budget enforcement mode. */
  budgetEnforcementFlags: BudgetEnforcementFlags;
}

export class ChildPiError extends Error {
  readonly usage?: Usage;
  readonly usageComplete: boolean;
  readonly missingUsage: boolean;
  readonly text: string;
  readonly turns: number;
  readonly outputTruncated: boolean;
  readonly budgetEnforcement: BudgetEnforcementMode;
  readonly budgetEnforcementFlags: BudgetEnforcementFlags;

  constructor(message: string, details: Partial<ChildPiResult> = {}) {
    super(message);
    this.name = "ChildPiError";
    this.usage = details.usage;
    this.usageComplete = details.usageComplete ?? false;
    this.missingUsage = details.missingUsage ?? !this.usageComplete;
    this.text = details.text ?? "";
    this.turns = details.turns ?? 0;
    this.outputTruncated = details.outputTruncated ?? false;
    this.budgetEnforcement = details.budgetEnforcement ?? "none";
    this.budgetEnforcementFlags = details.budgetEnforcementFlags ?? flagsForBudgetEnforcement(this.budgetEnforcement);
  }
}

/** Set on a child that loads CE; that CE registers only ctx_read, so it cannot delegate again. */
export const CONTEXT_ENGINEER_CHILD_ENV = "PI_CONTEXT_ENGINEER_CHILD";

export const DEFAULT_CHILD_TIMEOUT_MS = 120_000;
export const DEFAULT_CHILD_MAX_TURNS = 8;
export const MAX_CHILD_TURNS = 32;
/** Hard process-output bounds; Main owns any smaller returned-text policy. */
export const MAX_CHILD_STDOUT_BYTES = 4 * 1024 * 1024;
export const MAX_CHILD_STDERR_BYTES = 256 * 1024;

const MINIMAL_SUMMARIZER_SYSTEM_PROMPT =
  "You are a concise text summarizer. Return only the requested summary; do not use tools or discuss this instruction.";

/** Keep prompts out of argv well below Linux per-argument and macOS argv limits. */
export const MAX_CHILD_INLINE_PROMPT_BYTES = 64 * 1024;

interface PromptTransport {
  argument: string;
  cleanup: () => void;
}

function promptTransport(prompt: string): PromptTransport {
  if (Buffer.byteLength(prompt, "utf8") <= MAX_CHILD_INLINE_PROMPT_BYTES) {
    return { argument: prompt, cleanup: () => {} };
  }

  const directory = mkdtempSync(join(tmpdir(), "ce-child-prompt-"));
  const path = join(directory, "prompt.txt");
  try {
    // Pi documents `-- [@files...] [messages...]`; the @file is read by Pi,
    // not interpolated by a shell. Keep the private temporary file mode tight.
    writeFileSync(path, prompt, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* preserve the write error */ }
    throw error;
  }

  let cleaned = false;
  return {
    argument: `@${path}`,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* best-effort cleanup after child termination */ }
    },
  };
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("Child Pi cancelled."), { name: "AbortError" });
}

function positiveInteger(value: number | undefined, name: string, fallback?: number): number {
  const candidate = value ?? fallback;
  if (candidate === undefined) throw new TypeError(`${name} is required.`);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return candidate;
}

function childBudgetExtensionPath(): string {
  const current = fileURLToPath(import.meta.url);
  const extension = current.endsWith(".ts") ? "ts" : "js";
  return fileURLToPath(new URL(`./child-budget.${extension}`, import.meta.url));
}

function contextEngineerExtensionPath(): string {
  const current = fileURLToPath(import.meta.url);
  const extension = current.endsWith(".ts") ? "ts" : "js";
  return fileURLToPath(new URL(`./index.${extension}`, import.meta.url));
}

function childArgs(promptArgument: string, options: ChildPiOptions, maxTokens: number | undefined, maxTurns: number): string[] {
  const args = [
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "--no-session", "--no-approve", "--print", "--mode", "json",
  ];
  if (options.noTools) {
    // A model-only summary does not need the coding-agent prompt or project rules.
    args.push("--no-tools", "--no-context-files", "--thinking", "off", "--system-prompt", MINIMAL_SUMMARIZER_SYSTEM_PROMPT);
  }
  if (options.model) args.push("--model", options.model);
  // Explicit -e paths still load when discovery is disabled. The extension uses
  // Pi's documented before_provider_request hook rather than an invented CLI API.
  if (options.loadContextEngineer) args.push("--extension", contextEngineerExtensionPath());
  args.push("--extension", childBudgetExtensionPath(), "--ce-child-max-turns", String(maxTurns));
  if (maxTokens !== undefined) args.push("--ce-child-max-tokens", String(maxTokens));
  // Pi documents -- as the option terminator. It also makes prompts beginning
  // with - unambiguously positional and accepts @file inputs after it.
  args.push("--", promptArgument);
  return args;
}

interface JsonRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAssistantMessage(value: unknown): value is JsonRecord {
  return isRecord(value) && value.role === "assistant" && Array.isArray(value.content);
}

function budgetMode(value: unknown): BudgetEnforcementMode | undefined {
  return value === "provider" || value === "stream" || value === "none" ? value : undefined;
}

interface BudgetObservation {
  mode: BudgetEnforcementMode;
  limitExceeded: boolean;
  estimatedTokens?: number;
}

function observeBudget(value: unknown): BudgetObservation | undefined {
  const container = isRecord(value) ? value : undefined;
  const metadata = isRecord(container?.[CHILD_BUDGET_METADATA_KEY]) ? container[CHILD_BUDGET_METADATA_KEY] : undefined;
  if (!metadata) return undefined;
  const mode = budgetMode(metadata.mode);
  if (!mode) return undefined;
  const flags = isRecord(metadata.flags) ? metadata.flags : undefined;
  const estimate = metadata.estimatedTokens;
  return {
    mode,
    limitExceeded: metadata.limitExceeded === true || flags?.limitExceeded === true,
    ...(typeof estimate === "number" && Number.isSafeInteger(estimate) ? { estimatedTokens: estimate } : {}),
  };
}

function observedUsage(value: unknown): Usage | undefined {
  const usage = readUsage(value);
  if (!usage) return undefined;
  // Pi uses an all-zero EMPTY_USAGE placeholder for local error/abort messages.
  // Treat it as unknown rather than charging a fabricated provider report.
  const tokenValues = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens, usage.reasoning ?? 0, usage.cacheWrite1h ?? 0];
  const costValues = Object.values(usage.cost);
  return [...tokenValues, ...costValues].some(value => value > 0) ? usage : undefined;
}

function textFromAssistant(message: JsonRecord | undefined): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is JsonRecord => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map(block => block.text as string)
    .join("\n")
    .trim();
}

function recordAssistant(message: JsonRecord, fallbackUsage?: Usage): AssistantRecord {
  const directUsage = observedUsage(message.usage);
  return {
    message,
    usage: directUsage ?? fallbackUsage,
    usageComplete: directUsage !== undefined,
  };
}

function assistantKey(message: JsonRecord | undefined): string {
  if (!message) return "partial";
  if (typeof message.responseId === "string") return `response:${message.responseId}`;
  return JSON.stringify({
    role: message.role, api: message.api, provider: message.provider, model: message.model,
    stopReason: message.stopReason, errorMessage: message.errorMessage, content: message.content,
  });
}

function mergeAssistantRecords(primary: AssistantRecord[], secondary: AssistantRecord[]): AssistantRecord[] {
  const merged = primary.map(record => ({ ...record }));
  const matched = new Set<number>();
  for (const candidate of secondary) {
    const index = merged.findIndex((record, index) => !matched.has(index) && assistantKey(record.message) === assistantKey(candidate.message));
    if (index < 0) {
      merged.push({ ...candidate });
      matched.add(merged.length - 1);
    } else {
      matched.add(index);
      const existing = merged[index]!;
      if (candidate.usage !== undefined && (existing.usage === undefined || (!existing.usageComplete && candidate.usageComplete))) {
        existing.usage = candidate.usage;
        existing.usageComplete = candidate.usageComplete;
      }
    }
  }
  return merged;
}

interface AssistantRecord {
  message?: JsonRecord;
  usage?: Usage;
  usageComplete: boolean;
}

interface ParsedChildOutput {
  result: ChildPiResult;
  validEventCount: number;
  generationCount: number;
  malformedLine?: number;
  terminalStopReason?: string;
  terminalError?: string;
  budgetLimitExceeded: boolean;
}

function parseChildOutput(stdout: string, allowTrailingPartial: boolean, maxTokens?: number): ParsedChildOutput {
  const messageEndAssistants: AssistantRecord[] = [];
  const agentEndAssistants: AssistantRecord[] = [];
  const observedApis = new Set<string>();
  const observedBudgetModes = new Set<BudgetEnforcementMode>();
  let budgetLimitExceeded = false;
  let pendingUpdateUsage: Usage | undefined;
  let openAssistantGenerations = 0;
  let openTurns = 0;
  let turns = 0;
  let validEventCount = 0;
  let malformedLine: number | undefined;

  const lines = stdout.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index] ?? "";
    if (index === 0) line = line.replace(/^\uFEFF/u, "");
    if (line.trim() === "") continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      const isTrailingPartial = allowTrailingPartial && index === lines.length - 1 && !/\r?\n$/u.test(stdout);
      if (!isTrailingPartial && malformedLine === undefined) malformedLine = index + 1;
      continue;
    }
    if (!isRecord(event) || typeof event.type !== "string") {
      if (malformedLine === undefined) malformedLine = index + 1;
      continue;
    }
    validEventCount++;
    const eventBudget = observeBudget(event);
    if (eventBudget) {
      observedBudgetModes.add(eventBudget.mode);
      budgetLimitExceeded ||= eventBudget.limitExceeded;
    }

    switch (event.type) {
      case "turn_start":
        turns++;
        openTurns++;
        break;
      case "message_start":
        if (isAssistantMessage(event.message)) {
          openAssistantGenerations++;
          if (typeof event.message.api === "string") observedApis.add(event.message.api);
          const messageBudget = observeBudget(event.message);
          if (messageBudget) {
            observedBudgetModes.add(messageBudget.mode);
            budgetLimitExceeded ||= messageBudget.limitExceeded;
          }
          pendingUpdateUsage = undefined;
        }
        break;
      case "message_update": {
        const updateUsage = observedUsage(event.usage);
        if (updateUsage) pendingUpdateUsage = updateUsage;
        break;
      }
      case "message_end":
        if (isAssistantMessage(event.message)) {
          if (typeof event.message.api === "string") observedApis.add(event.message.api);
          const messageBudget = observeBudget(event.message);
          if (messageBudget) {
            observedBudgetModes.add(messageBudget.mode);
            budgetLimitExceeded ||= messageBudget.limitExceeded;
          }
          messageEndAssistants.push(recordAssistant(event.message, pendingUpdateUsage));
          openAssistantGenerations = Math.max(0, openAssistantGenerations - 1);
          pendingUpdateUsage = undefined;
        }
        break;
      case "turn_end":
        openTurns = Math.max(0, openTurns - 1);
        break;
      case "agent_end":
        openTurns = 0;
        if (Array.isArray(event.messages)) {
          for (const message of event.messages) {
            if (isAssistantMessage(message)) {
              if (typeof message.api === "string") observedApis.add(message.api);
              const messageBudget = observeBudget(message);
              if (messageBudget) {
                observedBudgetModes.add(messageBudget.mode);
                budgetLimitExceeded ||= messageBudget.limitExceeded;
              }
              agentEndAssistants.push(recordAssistant(message));
              openAssistantGenerations = Math.max(0, openAssistantGenerations - 1);
            }
          }
        }
        break;
      default:
        break;
    }
  }

  // A cancellation can arrive between provider updates and message_end. Keep
  // that real partial provider report for the failure exception, but mark the
  // result incomplete because no authoritative assistant message finished.
  const assistants = mergeAssistantRecords(messageEndAssistants, agentEndAssistants);
  if (pendingUpdateUsage) {
    const lastMessageRecord = [...assistants].reverse().find(assistant => assistant.message !== undefined);
    if (lastMessageRecord && lastMessageRecord.usage === undefined) {
      lastMessageRecord.usage = pendingUpdateUsage;
      lastMessageRecord.usageComplete = false;
    } else if (!lastMessageRecord) {
      // Keep a stream-only usage report for cancellation telemetry, but never
      // add it to a finalized assistant usage a second time.
      assistants.push({ usage: pendingUpdateUsage, usageComplete: false });
    }
  }
  assistants.sort((left, right) => {
    const leftTime = typeof left.message?.timestamp === "number" ? left.message.timestamp : Number.POSITIVE_INFINITY;
    const rightTime = typeof right.message?.timestamp === "number" ? right.message.timestamp : Number.POSITIVE_INFINITY;
    return leftTime - rightTime;
  });

  const usage = mergeUsage(...assistants.map(assistant => assistant.usage));
  const aborted = assistants.some(assistant => assistant.message?.stopReason === "aborted");
  // An aborted generation is not an authoritative completed usage report, even
  // when the provider attached a partial usage object to its error message.
  const unfinishedGeneration = openAssistantGenerations > 0 || openTurns > 0;
  const usageComplete = !aborted && !unfinishedGeneration && assistants.length > 0 && assistants.every(assistant => assistant.usageComplete && assistant.usage !== undefined);
  const outputTruncated = assistants.some(assistant => assistant.message?.stopReason === "length");
  const budgetEnforcement: BudgetEnforcementMode = maxTokens === undefined
    ? "none"
    : observedBudgetModes.has("stream") || observedApis.has("openai-codex-responses")
      ? "stream"
      : observedBudgetModes.has("provider") || observedApis.size > 0
        ? "provider"
        : "none";
  const lastAssistant = [...assistants].reverse().find(assistant => assistant.message !== undefined)?.message;
  const text = textFromAssistant(lastAssistant) || [...assistants].reverse()
    .map(assistant => textFromAssistant(assistant.message))
    .find(candidate => candidate.length > 0) || "";

  const result: ChildPiResult = {
    text,
    ...(usage ? { usage } : {}),
    usageComplete,
    missingUsage: !usageComplete,
    turns,
    outputTruncated,
    budgetEnforcement,
    budgetEnforcementFlags: flagsForBudgetEnforcement(budgetEnforcement, budgetLimitExceeded),
  };
  return {
    result,
    validEventCount,
    generationCount: assistants.filter(assistant => assistant.message !== undefined).length,
    budgetLimitExceeded,
    ...(malformedLine !== undefined ? { malformedLine } : {}),
    ...(lastAssistant && typeof lastAssistant.stopReason === "string" ? { terminalStopReason: lastAssistant.stopReason } : {}),
    ...(lastAssistant && typeof lastAssistant.errorMessage === "string" ? { terminalError: lastAssistant.errorMessage } : {}),
  };
}

function errorWithDetails(error: Error, parsed: ParsedChildOutput): Error {
  const details = parsed.result;
  if (error instanceof ChildPiError) {
    // Preserve the existing error identity/message while adding any usage
    // captured before a process error, timeout, cancellation, or parse failure.
    if (details.usage !== undefined) (error as { usage?: Usage }).usage = details.usage;
    (error as { usageComplete: boolean }).usageComplete = details.usageComplete;
    (error as { missingUsage: boolean }).missingUsage = details.missingUsage;
    (error as { text: string }).text = details.text;
    (error as { turns: number }).turns = details.turns;
    (error as { outputTruncated: boolean }).outputTruncated = details.outputTruncated;
    (error as { budgetEnforcement: BudgetEnforcementMode }).budgetEnforcement = details.budgetEnforcement;
    (error as { budgetEnforcementFlags: BudgetEnforcementFlags }).budgetEnforcementFlags = details.budgetEnforcementFlags;
    return error;
  }
  Object.assign(error, {
    ...(details.usage ? { usage: details.usage } : {}),
    usageComplete: details.usageComplete,
    missingUsage: details.missingUsage,
    text: details.text,
    turns: details.turns,
    outputTruncated: details.outputTruncated,
    budgetEnforcement: details.budgetEnforcement,
    budgetEnforcementFlags: details.budgetEnforcementFlags,
  });
  return error;
}

export async function runChildPiResult(prompt: string, options: ChildPiOptions): Promise<ChildPiResult> {
  const maxTokens = options.maxTokens === undefined ? undefined : positiveInteger(options.maxTokens, "maxTokens");
  const maxTurns = positiveInteger(options.maxTurns, "maxTurns", DEFAULT_CHILD_MAX_TURNS);
  if (maxTurns > MAX_CHILD_TURNS) throw new RangeError(`maxTurns must be <= ${MAX_CHILD_TURNS}.`);

  const signal = options.signal;
  if (signal?.aborted) throw abortReason(signal);
  const transport = promptTransport(prompt);
  let args: string[];
  try {
    args = childArgs(transport.argument, options, maxTokens, maxTurns);
  } catch (error) {
    transport.cleanup();
    throw error;
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { transport.cleanup(); reject(abortReason(signal)); return; }

    let child;
    try {
      child = spawn(process.env.PI_BIN ?? "pi", args, {
        cwd: options.cwd,
        env: options.loadContextEngineer ? { ...process.env, [CONTEXT_ENGINEER_CHILD_ENV]: "delegate" } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
        // A dedicated POSIX group includes tool subprocesses started by child Pi.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      transport.cleanup();
      reject(error);
      return;
    }

    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const output = (chunks: Buffer[], bytes: number) => Buffer.concat(chunks, bytes).toString("utf8");
    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      transport.cleanup();
    };
    const killGroup = (kind: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch { /* already exited */ }
    };
    const finishFailure = (error: Error, allowTrailingPartial: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(errorWithDetails(error, parseChildOutput(output(stdoutChunks, stdoutBytes), allowTrailingPartial, maxTokens)));
    };
    const stop = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => killGroup("SIGKILL"));
      } else {
        killGroup("SIGTERM");
        // Do not cancel escalation when the root exits: a grandchild may
        // still be alive after closing its inherited stdout/stderr handles.
        setTimeout(() => killGroup("SIGKILL"), 250).unref();
      }
      reject(errorWithDetails(error, parseChildOutput(output(stdoutChunks, stdoutBytes), true, maxTokens)));
    };
    const onAbort = () => stop(abortReason(signal!));
    const timeoutMs = options.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS;
    timeout = setTimeout(() => stop(new ChildPiError(`Child Pi timed out after ${timeoutMs} ms.`)), timeoutMs);

    const append = (chunks: Buffer[], current: number, chunk: Buffer | string, limit: number, label: string): number => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = limit - current;
      if (data.byteLength > remaining) {
        if (remaining > 0) chunks.push(data.subarray(0, remaining));
        // Publish the bounded prefix before stop() parses captured usage.
        if (label === "stdout") stdoutBytes = limit;
        else stderrBytes = limit;
        stop(new ChildPiError(`Child Pi ${label} exceeded ${limit} bytes.`));
        return limit;
      }
      chunks.push(data);
      return current + data.byteLength;
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.stdout.on("data", (chunk: Buffer | string) => {
      if (!settled) stdoutBytes = append(stdoutChunks, stdoutBytes, chunk, MAX_CHILD_STDOUT_BYTES, "stdout");
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (!settled) stderrBytes = append(stderrChunks, stderrBytes, chunk, MAX_CHILD_STDERR_BYTES, "stderr");
    });
    child.once("error", (error) => {
      if (settled) return;
      finishFailure(error, true);
    });
    child.once("close", (code, exitSignal) => {
      if (settled) return;
      const stdout = output(stdoutChunks, stdoutBytes);
      const stderr = output(stderrChunks, stderrBytes);
      const parsed = parseChildOutput(stdout, false, maxTokens);
      if (parsed.budgetLimitExceeded) {
        finishFailure(new ChildPiError(
          "Child Pi approximate stream budget exceeded; Codex has no supported server-side output cap, so billed tokens may overshoot or be unknown.",
        ), false);
        return;
      }
      if (code !== 0) {
        const detail = (stderr || stdout).trim().slice(-2000);
        finishFailure(new ChildPiError(
          `Child Pi exited with ${exitSignal ? `signal ${exitSignal}` : `code ${code}`}${detail ? `: ${detail}` : ""}`
        ), false);
        return;
      }
      if (parsed.malformedLine !== undefined) {
        finishFailure(new ChildPiError(`Child Pi emitted malformed JSON on line ${parsed.malformedLine}.`), false);
        return;
      }
      if (parsed.validEventCount === 0) {
        finishFailure(new ChildPiError("Child Pi produced empty or non-JSON output."), false);
        return;
      }
      if (parsed.result.turns > maxTurns || parsed.generationCount > maxTurns) {
        finishFailure(new ChildPiError(`Child Pi exceeded maxTurns (${maxTurns}).`), false);
        return;
      }
      if (parsed.terminalStopReason === "error" || parsed.terminalStopReason === "aborted" || parsed.terminalStopReason === "toolUse") {
        finishFailure(new ChildPiError(`Child Pi ${parsed.terminalStopReason}: ${parsed.terminalError ?? "request did not complete"}.`), false);
        return;
      }
      if (parsed.result.text.length === 0) {
        finishFailure(new ChildPiError("Child Pi produced an empty assistant response."), false);
        return;
      }
      settled = true;
      cleanup();
      resolve(parsed.result);
    });
  });
}

/** Backward-compatible text-only facade over the machine-readable runner. */
export async function runChildPi(prompt: string, options: ChildPiOptions): Promise<string> {
  const result = await runChildPiResult(prompt, options);
  return result.text;
}
