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

export interface ToolContext {
  store: ContextStore;
  workspaceRoot: string;
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
    return ctx.store.read(args.id as string, {
      offset: args.offset as number | undefined,
      length: args.length as number | undefined,
      query: args.query as string | undefined,
      contextLines: args.contextLines as number | undefined,
    });
  },
};

// ---- ctx_summarize: compress data structurally or via model ----

const ctxSummarize: ToolDef = {
  name: "ctx_summarize",
  description:
    "Compress a stored payload or inline text into a small structured summary. " +
    "Structural mode (default) is free and deterministic: extracts keys, counts, signatures, first/last N lines. " +
    "Model mode uses a cheaper model for semantic summarization. " +
    "Always prefer structural mode unless you need semantic understanding.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Handle of a stored payload to summarize." },
      text: { type: "string", description: "Inline text to summarize (used if no id)." },
      mode: {
        type: "string",
        enum: ["structural", "model"],
        description: "structural = free, deterministic extraction. model = LLM summarization. Default: structural.",
      },
      maxTokens: { type: "integer", description: "Target max tokens for the summary. Default 500." },
    },
  },
  async handler(args, ctx) {
    const mode = (args.mode as string) ?? "structural";
    const maxTokens = (args.maxTokens as number) ?? 500;

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

    if (mode === "structural") {
      return structuralSummary(data, source, maxTokens);
    }

    // Model mode
    const prompt = `Summarize the following content in under ${maxTokens} tokens. ` +
      `Preserve: key facts, identifiers, errors, decisions, and any data structures. ` +
      `Drop: redundant examples, verbose descriptions, formatting noise.\n\n---\n${data}`;
    const summary = await ctx.modelCall(prompt, maxTokens);
    return { source, mode: "model", summary, originalTokens: Math.ceil(data.length / 4), summaryTokens: Math.ceil(summary.length / 4) };
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
    },
  },
  async handler(args, ctx) {
    const memStore = new ContextStore(ctx.workspaceRoot, ".pi/agent/context-store");
    const entries = memStore.list();
    const facts: string[] = [];

    for (const entry of entries) {
      if (entry.key !== "memory") continue;
      const full = memStore.read(entry.id, { length: Number.MAX_SAFE_INTEGER });
      if (!args.query || full.content.includes(args.query as string)) {
        facts.push(full.content);
      }
    }

    return { count: facts.length, facts };
  },
};

// ---- ctx_delegate: isolate work in a sub-agent ----

const ctxDelegate: ToolDef = {
  name: "ctx_delegate",
  description:
    "Delegate a separable subtask to a child Pi agent with a fresh context window. " +
    "The child does all the heavy reading/searching in its own context; " +
    "only its final summary returns to yours. " +
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

function structuralSummary(data: string, source: string, maxTokens: number): unknown {
  const trimmed = data.trim();
  const totalTokens = Math.ceil(trimmed.length / 4);
  const lines = trimmed.split("\n");
  const result: Record<string, unknown> = {
    source,
    mode: "structural",
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
