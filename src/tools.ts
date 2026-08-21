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

import { ContextStore } from "./store.js";

// ---- Types ----

/** Headroom reserved for the JSON envelope around a CE tool result. */
const RESULT_ENVELOPE_SLACK_BYTES = 1024;
/** Default ceiling for one CE tool result; mirrors index.ts's offload threshold. */
const DEFAULT_MAX_RETURN_BYTES = 8192;
type SummaryMode = "structural" | "code" | "model";
const DEFAULT_SUMMARY_TOKENS = 500;
const MIN_SUMMARY_TOKENS = 64;
const MAX_SUMMARY_TOKENS = 4000;
function normalizeSummaryMode(value: unknown): SummaryMode | null {
  const mode = value == null ? "structural" : String(value);
  return mode === "structural" || mode === "code" || mode === "model" ? mode : null;
}
function normalizeSummaryTokens(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SUMMARY_TOKENS;
  return Math.max(MIN_SUMMARY_TOKENS, Math.min(MAX_SUMMARY_TOKENS, Math.floor(parsed)));
}


export interface ToolContext {
  store: ContextStore;
  workspaceRoot: string;
  /** Approximate byte budget for one tool result; ctx_read self-caps under it. */
  maxReturnBytes?: number;
  /** Call a Pi core tool by name (read, bash, grep, etc.) */
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Spawn a child Pi agent with a fresh context window */
  spawnAgent: (prompt: string, opts?: { model?: string }) => Promise<string>;
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
    "Use offset/length for ranged reads, or query for literal substring search with context lines.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The handle returned when the data was offloaded." },
      offset: { type: "integer", description: "0-based byte offset for ranged read. Defaults to 0." },
      length: { type: "integer", description: "Bytes to read. Defaults to ~8KB." },
      query: { type: "string", description: "Literal substring to search for. Overrides offset/length." },
      contextLines: { type: "integer", description: "Lines of context around each query match. Default 2." },
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

    if (args.query) {
      const result = await ctx.store.read(args.id as string, {
        query: args.query as string,
        contextLines: args.contextLines as number | undefined,
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
function capContent<T extends { content: string; truncated: boolean }>(
  result: T,
  budget: number,
  hint: string
): T {
  if (Buffer.byteLength(result.content, "utf8") <= budget) return result;
  const prefix = Buffer.from(result.content, "utf8").subarray(0, budget).toString("utf8");
  return {
    ...result,
    content:
      prefix +
      `\n... [ctx_read output capped at ${budget} bytes to stay out of the offload path — ${hint}]`,
    truncated: true,
  };
}

// ---- ctx_summarize: compress data structurally or via model ----

const ctxSummarize: ToolDef = {
  name: "ctx_summarize",
  description:
    "Compress a stored payload or inline text into a small structured summary. " +
    "Structural mode (default) is free and deterministic: extracts keys, counts, signatures, first/last N lines. " +
    "Model mode uses an isolated no-tools Pi process (the current model by default) for semantic summarization. " +
    "Always prefer structural mode unless you need semantic understanding.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Handle of a stored payload to summarize." },
      text: { type: "string", description: "Inline text to summarize (used if no id)." },
      mode: {
        type: "string",
        enum: ["structural", "code", "model"],
        description: "structural = free general extraction. code = free code-aware extraction. model = isolated LLM summarization. Default: structural.",
      },
      maxTokens: { type: "integer", description: "Target max tokens for the summary. Default 500." },
    },
  },
  async handler(args, ctx) {
    const mode = normalizeSummaryMode(args.mode);
    if (!mode) return { error: "Unknown summary mode. Use structural, code, or model.", code: "invalid_summary_mode", allowedModes: ["structural", "code", "model"] };
    const maxTokens = normalizeSummaryTokens(args.maxTokens);

    let data: string;
    let source: string;

    if (args.id) {
      const entry = ctx.store.read(args.id as string, { length: Number.MAX_SAFE_INTEGER });
      data = entry.content;
      source = `stored:${args.id}`;
    } else if (args.text) {
      data = args.text as string;
      source = "inline";
    } else {
      return { error: "Provide either id (stored payload) or text (inline)." };
    }

    if (mode === "structural" || mode === "code") {
      return capSummary(structuralSummary(data, source, maxTokens, mode), maxTokens);
    }

    // Model mode
    const prompt = `Summarize the following content in under ${maxTokens} tokens. ` +
      `Preserve: key facts, identifiers, errors, decisions, and any data structures. ` +
      `Drop: redundant examples, verbose descriptions, formatting noise.\n\n---\n${data}`;
    const summary = await ctx.modelCall(prompt, maxTokens);
    const boundedSummary = capText(summary, maxTokens * 4);
    return { source, mode: "model", summary: boundedSummary, originalTokens: Math.ceil(Buffer.byteLength(data, "utf8") / 4), summaryTokens: Math.ceil(Buffer.byteLength(boundedSummary, "utf8") / 4), truncated: boundedSummary.length < summary.length };
  },
};

// ---- ctx_remember: persist a fact to long-term memory ----

const ctxRemember: ToolDef = {
  name: "ctx_remember",
  description:
    "Persist a fact or preference to long-term memory that survives across sessions. " +
    "Use for: user preferences, project conventions, key decisions. " +
    "Do NOT use for: secrets, temporary task state, or facts already in project docs.",
  inputSchema: {
    type: "object",
    properties: {
      fact: { type: "string", description: "The exact fact to remember." },
    },
    required: ["fact"],
  },
  async handler(args, ctx) {
    // Keep durable facts in a separate project-local namespace rather than
    // mixing them with transient context-store payloads.
    const memStore = new ContextStore(ctx.workspaceRoot, ".pi/agent/context-store");
    const result = memStore.write("memory", "remember", args.fact as string);
    return { saved: true, id: result.id, fact: args.fact };
  },
};

// ---- ctx_recall: retrieve persisted facts ----

const ctxRecall: ToolDef = {
  name: "ctx_recall",
  description:
    "Retrieve persisted facts from long-term memory. " +
    "Returns all saved facts, or only those matching a query.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Optional literal filter — only return facts containing this substring." },
      limit: { type: "integer", description: "Maximum number of facts to return. Default 20." },
      maxTokens: { type: "integer", description: "Maximum estimated tokens to return. Default 1000." },
    },
  },
  async handler(args, ctx) {
    const memStore = new ContextStore(ctx.workspaceRoot, ".pi/agent/context-store");
    const entries = memStore.list();
    const facts: string[] = [];
    const limit = Math.max(1, Math.min((args.limit as number | undefined) ?? 20, 100));
    const maxTokens = Math.max(64, (args.maxTokens as number | undefined) ?? 1000);
    let usedTokens = 0;
    let truncated = false;

    for (const entry of entries) {
      if (entry.key !== "memory") continue;
      const full = memStore.read(entry.id, { length: Number.MAX_SAFE_INTEGER });
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
    },
    required: ["prompt"],
  },
  async handler(args, ctx) {
    const result = await ctx.spawnAgent(args.prompt as string, { model: args.model as string | undefined });
    return { delegated: true, result, resultTokens: Math.ceil(result.length / 4) };
  },
};

// ---- Export all tools ----

export const ceTools: ToolDef[] = [
  ctxRead,
  ctxSummarize,
  ctxRemember,
  ctxRecall,
  ctxDelegate,
];

export const ceToolMap = new Map(ceTools.map((t) => [t.name, t]));

// ---- Structural summary implementation ----

function capText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return Buffer.from(text, "utf8").subarray(0, Math.max(64, maxBytes - 80)).toString("utf8") + "\n... [summary capped]";
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
