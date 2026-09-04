/**
 * pi-context-engineer — CE tool implementations.
 *
 * Each tool maps to a context engineering strategy:
 *   ctx_read      → Write (recall offloaded data) + Select (query/slice)
 *   ctx_summarize → Compress (structural or LLM-based)
 *   ctx_remember   → Write (persist facts across sessions)
 *   ctx_recall     → Write (retrieve persisted facts)
 *   ctx_delegate   → Isolate (sub-agent with fresh context)
 *
 * These are registered as Pi tools and are callable inside current Fabric
 * programs through the `extensions.*` provider.
 */

import { ContextStore, DEFAULT_MEMORY_STORE_MAX_BYTES } from "./store.js";

// ---- Types ----

/** Headroom reserved for the JSON envelope around a CE tool result. */
const RESULT_ENVELOPE_SLACK_BYTES = 1024;
/** Default ceiling for one CE tool result; mirrors index.ts's offload threshold. */
const DEFAULT_MAX_RETURN_BYTES = 16_384;
type SummaryMode = "structural" | "code" | "model";
type SummaryStrategy = "hierarchical" | "direct";
const DEFAULT_SUMMARY_TOKENS = 500;
const MIN_SUMMARY_TOKENS = 64;
const MAX_SUMMARY_TOKENS = 4000;
const DEFAULT_MAX_INPUT_TOKENS = 32_000;
const MIN_MAX_INPUT_TOKENS = 1_024;
const MAX_MAX_INPUT_TOKENS = 128_000;
function normalizeSummaryMode(value: unknown): SummaryMode | null {
  const mode = value == null ? "structural" : String(value);
  return mode === "structural" || mode === "code" || mode === "model" ? mode : null;
}
function normalizeSummaryStrategy(value: unknown): SummaryStrategy | null {
  const strategy = value == null ? "hierarchical" : String(value);
  return strategy === "hierarchical" || strategy === "direct" ? strategy : null;
}
function normalizeSummaryTokens(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SUMMARY_TOKENS;
  return Math.max(MIN_SUMMARY_TOKENS, Math.min(MAX_SUMMARY_TOKENS, Math.floor(parsed)));
}
function normalizeMaxInputTokens(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_INPUT_TOKENS;
  return Math.max(MIN_MAX_INPUT_TOKENS, Math.min(MAX_MAX_INPUT_TOKENS, Math.floor(parsed)));
}

const MEMORY_STORE_OPTIONS = { ttlMs: 0, maxBytes: DEFAULT_MEMORY_STORE_MAX_BYTES } as const;
function memoryStore(ctx: ToolContext): ContextStore {
  return new ContextStore(ctx.workspaceRoot, ".pi/agent/context-store", MEMORY_STORE_OPTIONS);
}
function normalizeMemoryKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  if (key.length === 0) return undefined;
  return key.startsWith("memory:") ? key : `memory:${key}`;
}


export interface ToolContext {
  store: ContextStore;
  workspaceRoot: string;
  /** Approximate byte budget for one tool result; ctx_read self-caps under it. */
  maxReturnBytes?: number;
  /** Call a Pi core tool by name (read, bash, grep, etc.) */
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Spawn a child Pi agent with a fresh context window */
  spawnAgent: (prompt: string, opts?: { model?: string; timeoutMs?: number }) => Promise<string>;
  /** Call a model for summarization (cheaper model preferred) */
  modelCall: (prompt: string, maxTokens?: number) => Promise<string>;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

// ---- ctx_read: recall offloaded data by slice or query ----

const ctxRead: ToolDef = {
  name: "ctx_read",
  description:
    "Read a slice of or search within a previously offloaded tool result by its handle. " +
    "Keeps large data out of context — only the requested slice or matched lines return. " +
    "Use offset/length for ranged reads, query for literal line matches, or jsonPath for structured JSON selection.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The handle returned when the data was offloaded." },
      offset: { type: "integer", description: "0-based byte offset for ranged read. Defaults to 0." },
      length: { type: "integer", description: "Bytes to read. Defaults to the bounded read budget. Ranged results include a copyable nextOffset when more remains." },
      query: { type: "string", description: "Literal substring to search for. Overrides offset/length." },
      jsonPath: { type: "string", description: "Dot/bracket JSON path for a stored JSON payload, e.g. $.results[0].name. Overrides query/offset/length." },
      contextLines: { type: "integer", description: "Lines of context around each query match. Default 2; clamped to 0-50." },
      maxMatches: { type: "integer", description: "Maximum matching windows to format while still reporting exact totalMatches. Default 100; maximum 500." },
    },
    required: ["id"],
  },
  async handler(args, ctx) {
    // Self-cap output so a ctx_read result never reaches the auto-offload
    // threshold — otherwise reading a handle would produce another handle
    // (recursive offload), making the stored payload unreachable.
    const budget = Math.max(
      512,
      (ctx.maxReturnBytes ?? DEFAULT_MAX_RETURN_BYTES) - RESULT_ENVELOPE_SLACK_BYTES
    );

    if (args.jsonPath !== undefined) {
      const result = await ctx.store.read(args.id as string, {
        jsonPath: String(args.jsonPath),
      });
      return capContent(result, budget, "narrow the JSON path or select a smaller value");
    }

    if (args.query) {
      const requestedContextLines = Number(args.contextLines);
      const contextLines = Number.isFinite(requestedContextLines)
        ? Math.max(0, Math.min(50, Math.floor(requestedContextLines)))
        : undefined;
      const result = await ctx.store.read(args.id as string, {
        query: args.query as string,
        contextLines,
        maxMatches: Math.max(1, Math.min(500, Math.floor(Number(args.maxMatches) || 100))),
      });
      return capContent(result, budget, "narrow the query or reduce contextLines");
    }

    const requested = args.length as number | undefined;
    const result = await ctx.store.read(args.id as string, {
      offset: args.offset as number | undefined,
      length: Math.min(requested ?? budget, budget),
    });
    return capContent(result, budget, "use offset to page through the rest");
  },
};

/**
 * Guarantee a ReadResult fits within the byte budget. Oversized content is
 * sliced with an explicit note so the model knows to page or narrow instead of
 * receiving a silent truncation.
 */
function capContent<T extends {
  content: string;
  truncated: boolean;
  bytesRead: number;
  offset?: number;
  nextOffset?: number;
  matchedLines?: number[];
  totalMatches?: number;
}>(
  result: T,
  budget: number,
  hint: string
): T {
  // Line-number metadata can dwarf an otherwise bounded query result. Preserve
  // a useful sample plus the exact total, then budget the serialized object the
  // tool actually returns rather than only its content field.
  const matchedLines = result.matchedLines;
  const normalized = {
    ...result,
    ...(matchedLines
      ? {
          matchedLines: matchedLines.slice(0, 64),
          totalMatches: result.totalMatches ?? matchedLines.length,
        }
      : {}),
  } as T;
  const serializedBytes = (value: unknown): number =>
    Buffer.byteLength(JSON.stringify(value), "utf8");
  if (serializedBytes(normalized) <= budget) return normalized;

  const source = Buffer.from(result.content, "utf8");
  const isRange = typeof result.offset === "number";
  // Ranged content starts with the payload and may end with the store's paging
  // note. Search results use the entire formatted content as their source.
  const sourceBytes = isRange ? Math.min(result.bytesRead, source.length) : source.length;
  const capNote = `\n... [ctx_read output capped to stay out of the offload path — ${hint}]`;

  const candidate = (bytes: number): T => {
    const prefix = utf8SafePrefix(source.toString("utf8"), bytes);
    const visibleBytes = Buffer.byteLength(prefix, "utf8");
    return {
      ...normalized,
      content: prefix + capNote,
      bytesRead: isRange ? visibleBytes : Buffer.byteLength(prefix + capNote, "utf8"),
      ...(isRange
        ? { nextOffset: (result.offset ?? 0) + visibleBytes }
        : {}),
      truncated: true,
    };
  };

  let low = 0;
  let high = sourceBytes;
  let best = candidate(0);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const next = candidate(middle);
    if (serializedBytes(next) <= budget) {
      best = next;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

// ---- ctx_summarize: compress data structurally or via model ----

const ctxSummarize: ToolDef = {
  name: "ctx_summarize",
  description:
    "Compress a stored payload or inline text into a small structured summary. " +
    "Structural mode (default) is free and deterministic: extracts keys, counts, signatures, first/last N lines. " +
    "Model mode uses bounded hierarchical chunk summaries so a large payload never enters one child-model prompt. " +
    "Always prefer structural mode unless you need semantic understanding.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Handle of a stored payload to summarize." },
      text: { type: "string", description: "Inline text to summarize (used if no id)." },
      mode: {
        type: "string",
        enum: ["structural", "code", "model"],
        description: "structural = free general extraction. code = free code-aware extraction. model = bounded isolated LLM summarization. Default: structural.",
      },
      maxTokens: { type: "integer", description: "Target max tokens for the summary. Default 500." },
      maxInputTokens: { type: "integer", description: "Maximum approximate input tokens per child-model call. Default 32000." },
      strategy: { type: "string", description: "Model strategy: hierarchical (default) or direct (first bounded chunk only)." },
    },
  },
  async handler(args, ctx) {
    const mode = normalizeSummaryMode(args.mode);
    if (!mode) return { error: "Unknown summary mode. Use structural, code, or model.", code: "invalid_summary_mode", allowedModes: ["structural", "code", "model"] };
    const maxTokens = normalizeSummaryTokens(args.maxTokens);

    let data: string | undefined;
    let source: string;
    let storedId: string | undefined;

    if (args.id) {
      storedId = args.id as string;
      source = `stored:${storedId}`;
    } else if (args.text !== undefined) {
      data = String(args.text);
      source = "inline";
    } else {
      return { error: "Provide either id (stored payload) or text (inline)." };
    }

    if (mode === "structural" || mode === "code") {
      if (storedId) {
        const entry = ctx.store.read(storedId, { length: Number.MAX_SAFE_INTEGER });
        if (entry.content.startsWith("Error:")) return { error: entry.content, source };
        data = entry.content;
      }
      return capSummary(structuralSummary(data ?? "", source, maxTokens, mode), maxTokens);
    }

    const maxInputTokens = normalizeMaxInputTokens(args.maxInputTokens);
    const strategy = normalizeSummaryStrategy(args.strategy);
    if (!strategy) return { error: "Unknown summary strategy. Use hierarchical or direct.", code: "invalid_summary_strategy", allowedStrategies: ["hierarchical", "direct"] };
    const maxInputBytes = Math.max(1024, maxInputTokens * 4 - 2048);
    const chunks = storedId
      ? readStoredChunks(ctx.store, storedId, maxInputBytes)
      : { chunks: splitUtf8Chunks(data ?? "", maxInputBytes), totalBytes: Buffer.byteLength(data ?? "", "utf8") };
    if (chunks.error) return { error: chunks.error, source };

    const modelResult = await summarizeModelChunks(chunks.chunks, ctx, maxTokens, maxInputTokens, strategy);
    const boundedSummary = capText(modelResult.summary, maxTokens * 4);
    return {
      source,
      mode: "model",
      strategy,
      maxInputTokens,
      chunks: chunks.chunks.length,
      inputTruncated: strategy === "direct" && chunks.chunks.length > 1,
      summary: boundedSummary,
      originalTokens: Math.ceil(chunks.totalBytes / 4),
      summaryTokens: Math.ceil(Buffer.byteLength(boundedSummary, "utf8") / 4),
      truncated: boundedSummary.length < modelResult.summary.length,
    };
  },
};

interface ChunkReadResult {
  chunks: string[];
  totalBytes: number;
  error?: string;
}

function isContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
}

function splitUtf8Chunks(data: string, maxBytes: number): string[] {
  const buffer = Buffer.from(data, "utf8");
  if (buffer.length === 0) return [""];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    let end = Math.min(buffer.length, offset + maxBytes);
    while (end < buffer.length && isContinuationByte(buffer[end])) end++;
    if (end <= offset) end = Math.min(buffer.length, offset + maxBytes);
    chunks.push(buffer.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  return chunks;
}

function readStoredChunks(store: ContextStore, id: string, maxBytes: number): ChunkReadResult {
  const probe = store.read(id, { offset: 0, length: 0 });
  if (probe.content.startsWith("Error:")) return { chunks: [], totalBytes: 0, error: probe.content };
  if (probe.totalBytes === 0) return { chunks: [""], totalBytes: 0 };

  const chunks: string[] = [];
  let offset = 0;
  while (offset < probe.totalBytes) {
    const result = store.read(id, { offset, length: maxBytes });
    if (result.content.startsWith("Error:")) return { chunks: [], totalBytes: 0, error: result.content };
    const payloadBytes = result.truncated ? result.bytesRead : Buffer.byteLength(result.content, "utf8");
    const payload = Buffer.from(result.content, "utf8").subarray(0, payloadBytes).toString("utf8");
    if (payload.length > 0) chunks.push(payload);
    if (!result.truncated || result.nextOffset === undefined) break;
    if (result.nextOffset <= offset) return { chunks: [], totalBytes: 0, error: `Error: unable to advance while reading stored result "${id}".` };
    offset = result.nextOffset;
  }
  return { chunks, totalBytes: probe.totalBytes };
}

function modelPrompt(stage: string, maxTokens: number, content: string): string {
  return `${stage} the following context in under ${maxTokens} tokens. ` +
    `Preserve key facts, identifiers, errors, decisions, and data structures; ` +
    `remove repetition and formatting noise.\n\n---\n${content}`;
}

async function callBoundedModel(
  content: string,
  stage: string,
  ctx: ToolContext,
  maxTokens: number,
  maxInputTokens: number,
): Promise<string> {
  const inputBudget = Math.max(1024, maxInputTokens * 4 - 2048);
  const boundedContent = splitUtf8Chunks(content, inputBudget)[0] ?? "";
  const prompt = modelPrompt(stage, maxTokens, boundedContent);
  const summary = await ctx.modelCall(prompt, maxTokens);
  return capText(summary, maxTokens * 4);
}

function groupSummaryChunks(chunks: string[], maxBytes: number): string[][] {
  const groups: string[][] = [];
  let group: string[] = [];
  let bytes = 0;
  for (const chunk of chunks) {
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (group.length > 0 && bytes + chunkBytes + 2 > maxBytes) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    if (chunkBytes > maxBytes) {
      const split = splitUtf8Chunks(chunk, maxBytes);
      if (group.length > 0) {
        groups.push(group);
        group = [];
        bytes = 0;
      }
      groups.push(...split.map((part) => [part]));
      continue;
    }
    group.push(chunk);
    bytes += chunkBytes + 2;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

async function summarizeModelChunks(
  chunks: string[],
  ctx: ToolContext,
  maxTokens: number,
  maxInputTokens: number,
  strategy: SummaryStrategy,
): Promise<{ summary: string }> {
  const inputBudget = Math.max(1024, maxInputTokens * 4 - 2048);
  if (strategy === "direct") {
    return { summary: await callBoundedModel(chunks[0] ?? "", "Summarize", ctx, maxTokens, maxInputTokens) };
  }
  if (chunks.length <= 1) {
    return { summary: await callBoundedModel(chunks[0] ?? "", "Summarize", ctx, maxTokens, maxInputTokens) };
  }

  const leafTokens = Math.max(64, Math.min(maxTokens, Math.max(128, Math.floor(maxTokens * 0.75))));
  let partials: string[] = [];
  for (const chunk of chunks) {
    partials.push(await callBoundedModel(chunk, "Summarize this chunk", ctx, leafTokens, maxInputTokens));
  }

  let level = 1;
  while (partials.length > 1) {
    const groups = groupSummaryChunks(partials, inputBudget);
    const next: string[] = [];
    for (const group of groups) {
      next.push(await callBoundedModel(group.join("\n\n"), `Combine partial summaries (level ${level})`, ctx, maxTokens, maxInputTokens));
    }
    partials = next;
    level++;
  }
  return { summary: await callBoundedModel(partials[0] ?? "", "Produce the final summary", ctx, maxTokens, maxInputTokens) };
}

// ---- ctx_remember: persist a fact to long-term memory ----

const ctxRemember: ToolDef = {
  name: "ctx_remember",
  description:
    "Persist a fact or preference to long-term memory that survives across sessions. " +
    "Use for: user preferences, project conventions, key decisions. " +
    "An optional key makes the fact addressable and repeated writes update it. " +
    "Do NOT use for: secrets, temporary task state, or facts already in project docs.",
  inputSchema: {
    type: "object",
    properties: {
      fact: { type: "string", description: "The exact fact to remember." },
      key: { type: "string", description: "Optional stable name; writing the same name upserts the remembered fact." },
    },
    required: ["fact"],
  },
  async handler(args, ctx) {
    const namedKey = normalizeMemoryKey(args.key);
    if (args.key !== undefined && !namedKey) return { error: "Memory key must be a non-empty string." };
    const key = namedKey ?? "memory";
    const fact = String(args.fact ?? "");
    if (fact.length === 0) return { error: "Fact must be a non-empty string." };
    const result = memoryStore(ctx).write(key, "remember", fact, {
      upsert: Boolean(namedKey),
      deduplicate: !namedKey,
      contentType: "text",
    });
    return { saved: true, id: result.id, key, fact: args.fact, persistent: true };
  },
};

// ---- ctx_recall: retrieve persisted facts ----

const ctxRecall: ToolDef = {
  name: "ctx_recall",
  description:
    "Retrieve persisted facts from long-term memory. " +
    "Returns all saved facts, or only those matching a query. Expired entries are pruned before recall.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Optional literal filter — only return facts containing this substring." },
      limit: { type: "integer", description: "Maximum number of facts to return. Default 20." },
      maxTokens: { type: "integer", description: "Maximum estimated tokens to return. Default 1000." },
    },
  },
  async handler(args, ctx) {
    const memStore = memoryStore(ctx);
    const entries = memStore.list();
    const facts: string[] = [];
    const limit = Math.max(1, Math.min((args.limit as number | undefined) ?? 20, 100));
    const maxTokens = Math.max(64, (args.maxTokens as number | undefined) ?? 1000);
    let usedTokens = 0;
    let truncated = false;

    for (const entry of entries) {
      if (entry.key !== "memory" && !entry.key.startsWith("memory:")) continue;
      const full = memStore.read(entry.id, { length: Number.MAX_SAFE_INTEGER });
      // list() prunes expiry, but retain this guard for races/corrupt records so
      // an error string can never be returned as if it were a remembered fact.
      if (full.content.startsWith("Error:")) continue;
      if (args.query && !full.content.includes(args.query as string)) continue;
      const factTokens = Math.ceil(Buffer.byteLength(full.content, "utf8") / 4);
      if (facts.length >= limit || usedTokens + factTokens > maxTokens) {
        truncated = true;
        break;
      }
      facts.push(full.content);
      usedTokens += factTokens;
    }

    return { count: facts.length, facts, truncated, estimatedTokens: usedTokens };
  },
};

// ---- ctx_forget: remove persisted facts ----

const ctxForget: ToolDef = {
  name: "ctx_forget",
  description: "Remove a remembered fact by id or by its optional named key.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Exact id returned by ctx_remember." },
      key: { type: "string", description: "Named key previously passed to ctx_remember." },
    },
  },
  async handler(args, ctx) {
    const memStore = memoryStore(ctx);
    const id = typeof args.id === "string" && args.id.length > 0 ? args.id : undefined;
    const key = normalizeMemoryKey(args.key);
    if (args.key !== undefined && !key) return { error: "Memory key must be a non-empty string." };
    if (!id && !key) return { error: "Provide either id or key." };

    const ids = id
      ? [id]
      : memStore.list()
        .filter((entry) => entry.key === key)
        .map((entry) => entry.id);
    const forgotten = ids.filter((entryId) => memStore.delete(entryId));
    return { forgotten: forgotten.length > 0, count: forgotten.length, ids: forgotten };
  },
};

// ---- ctx_delegate: isolate work in a sub-agent ----

const ctxDelegate: ToolDef = {
  name: "ctx_delegate",
  description:
    "Delegate a separable subtask to a child Pi agent with a fresh context window. " +
    "The child does all the heavy reading/searching in its own context; " +
    "only its final summary returns to yours. " +
    "For Fabric-native recursive orchestration, prefer agents.run directly; use this tool as the standalone Pi fallback. " +
    "Use for: distinct file reviews, independent research questions, parallelizable analysis.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The subtask prompt for the child agent." },
      model: { type: "string", description: "Optional model override for the child." },
      maxTokens: { type: "integer", description: "Maximum estimated tokens returned to Main. Default 1200; maximum 4000." },
      timeoutSeconds: { type: "integer", description: "Child deadline in seconds. Default 90; clamped to 10-110 so nested Fabric calls fail cleanly before its outer deadline." },
    },
    required: ["prompt"],
  },
  async handler(args, ctx) {
    const maxTokens = normalizeSummaryTokens(args.maxTokens ?? 1200);
    const timeoutSeconds = Math.max(10, Math.min(110, Math.floor(Number(args.timeoutSeconds) || 90)));
    const prompt = `${args.prompt as string}\n\nReturn only the concise final findings needed by the parent, under ${maxTokens} tokens.`;
    const result = await ctx.spawnAgent(prompt, {
      model: args.model as string | undefined,
      timeoutMs: timeoutSeconds * 1000,
    });
    const boundedResult = capText(result, maxTokens * 4);
    return {
      delegated: true,
      result: boundedResult,
      resultTokens: Math.ceil(Buffer.byteLength(boundedResult, "utf8") / 4),
      truncated: boundedResult.length < result.length,
      timeoutSeconds,
    };
  }
};

// ---- Export all tools ----

export const ceTools: ToolDef[] = [
  ctxRead,
  ctxSummarize,
  ctxRemember,
  ctxRecall,
  ctxForget,
  ctxDelegate,
];

export const ceToolMap = new Map(ceTools.map((t) => [t.name, t]));

// ---- Structural summary implementation ----

function utf8SafePrefix(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  let end = Math.max(0, Math.min(buffer.length, Math.floor(maxBytes)));
  while (end > 0 && isContinuationByte(buffer[end])) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function capText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return utf8SafePrefix(text, Math.max(64, maxBytes - 80)) + "\n... [summary capped]";
}

function capSummary(summary: unknown, maxTokens: number): unknown {
  const maxBytes = Math.max(256, maxTokens * 4);
  const serialized = JSON.stringify(summary);
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return summary;
  const record = summary && typeof summary === "object" ? summary as Record<string, unknown> : {};
  const compact: Record<string, unknown> = {};
  for (const key of ["source", "mode", "kind", "originalTokens", "lines", "keys", "length"]) {
    if (key in record) compact[key] = record[key];
  }
  compact.truncated = true;
  for (const key of ["imports", "signatures", "head", "tail", "sample", "summary"]) {
    if (!(key in record)) continue;
    const used = Buffer.byteLength(JSON.stringify(compact), "utf8");
    const remaining = maxBytes - used - 32;
    if (remaining < 80) break;
    const value = record[key];
    if (typeof value === "string") compact[key] = capText(value, Math.floor(remaining * 0.72));
    else if (Array.isArray(value)) compact[key] = value.slice(0, 5).map((item) => typeof item === "string" ? capText(item, 160) : item);
    else if (value && typeof value === "object") compact[key] = Object.fromEntries(Object.entries(value).slice(0, 12));
    if (Buffer.byteLength(JSON.stringify(compact), "utf8") > maxBytes) delete compact[key];
  }
  return compact;
}

function structuralSummary(data: string, source: string, maxTokens: number, mode: "structural" | "code" = "structural"): unknown {
  const trimmed = data.trim();
  const totalTokens = Math.ceil(trimmed.length / 4);
  const lines = trimmed.split("\n");
  const result: Record<string, unknown> = {
    source,
    mode,
    originalTokens: totalTokens,
    lines: lines.length,
  };

  // Try JSON structural extraction
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = null;
  }

  if (parsed !== null) {
    return jsonSummary(parsed, result, maxTokens);
  }

  // Text/code structural extraction
  const budgetChars = maxTokens * 4;

  // Detect code: has import/require/function/def/class patterns
  const isCode = /^(import |from |require\(|function |def |class |const |export |interface )/m.test(trimmed);

  if (isCode) {
    // Extract: imports, function/class signatures, first/last N lines
    const imports = lines.filter((l) => /^(import |from |require\(|#include)/.test(l.trim())).slice(0, 20);
    const signatures = lines.filter((l) =>
      /^(export )?(async )?(function |def |class |interface |const |let |var )/.test(l.trim())
    ).slice(0, 30);

    const budget = budgetChars;
    let used = 0;
    const head: string[] = [];
    for (const l of lines.slice(0, 20)) {
      if (used + l.length > budget * 0.4) break;
      head.push(l);
      used += l.length;
    }
    const tail: string[] = [];
    for (const l of lines.slice(-10).reverse()) {
      if (used + l.length > budget * 0.7) break;
      tail.unshift(l);
      used += l.length;
    }

    return {
      ...result,
      kind: "code",
      imports: imports.length > 0 ? imports : undefined,
      signatures: signatures.length > 0 ? signatures.slice(0, 20) : undefined,
      head: head.join("\n"),
      tail: tail.join("\n"),
      truncated: totalTokens > maxTokens,
    };
  }

  // Plain text: first N + last N lines
  const headCount = Math.min(Math.floor(lines.length / 2), Math.floor(budgetChars / 80));
  const head = lines.slice(0, headCount).join("\n");
  const tail = lines.slice(-headCount).join("\n");

  return {
    ...result,
    kind: "text",
    head,
    tail,
    truncated: totalTokens > maxTokens,
  };
}

function jsonSummary(parsed: unknown, base: Record<string, unknown>, maxTokens: number): unknown {
  const budgetChars = maxTokens * 4;

  if (Array.isArray(parsed)) {
    const sample = parsed.slice(0, 3);
    return {
      ...base,
      kind: "json-array",
      length: parsed.length,
      sample,
      ...(parsed.length > 3 ? { note: `Showing 3 of ${parsed.length} items. Use ctx_read with query to inspect specific items.` } : {}),
    };
  }

  if (typeof parsed === "object" && parsed !== null) {
    const keys = Object.keys(parsed);
    const summary: Record<string, unknown> = {};
    let used = 0;

    for (const key of keys) {
      const val = (parsed as Record<string, unknown>)[key];
      if (used > budgetChars) {
        summary[key] = `[truncated — use ctx_read to inspect]`;
        continue;
      }

      if (Array.isArray(val)) {
        summary[key] = `Array(${val.length})`;
        used += 20;
      } else if (typeof val === "string") {
        const snippet = val.length > 100 ? val.slice(0, 100) + "..." : val;
        summary[key] = snippet;
        used += snippet.length;
      } else if (typeof val === "object" && val !== null) {
        summary[key] = `Object(${Object.keys(val).length} keys)`;
        used += 30;
      } else {
        summary[key] = val;
        used += 20;
      }
    }

    return {
      ...base,
      kind: "json-object",
      keys: keys.length,
      summary,
    };
  }

  return { ...base, kind: "scalar", value: String(parsed).slice(0, budgetChars) };
}
