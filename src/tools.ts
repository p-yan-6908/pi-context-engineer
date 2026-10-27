/**
 * pi-context-engineer — CE tool implementations.
 *
 * Each tool maps to a context engineering strategy:
 *   ctx_read      → Write (recall offloaded data) + Select (query/slice)
 *   ctx_summarize → Compress (deterministic structural extraction)
 *
 * These are registered as Pi tools and are callable inside current Fabric
 * programs through the `extensions.*` provider.
 */

import { ContextStore } from "./store.js";

// ---- Types ----

/** Headroom reserved for the JSON envelope around a CE tool result. */
const RESULT_ENVELOPE_SLACK_BYTES = 1024;
/** Default ceiling for one CE tool result; mirrors index.ts's offload threshold. */
const DEFAULT_MAX_RETURN_BYTES = 16_384;
/**
 * Result budget for ctx_read inside a Fabric program, where a result is
 * program data rather than model context. Fabric hands the program the
 * selected text twice (content and text) beside its details, which keeps a
 * 512 KB read well inside Fabric's default 2,000,000-character nested limit.
 */
export const NESTED_READ_BUDGET_BYTES = 512 * 1024;
type SummaryMode = "structural" | "code";
const DEFAULT_SUMMARY_TOKENS = 500;
const MIN_SUMMARY_TOKENS = 64;
const MAX_SUMMARY_TOKENS = 4000;
function normalizeSummaryMode(value: unknown): SummaryMode | null {
  const mode = value == null ? "structural" : String(value);
  return mode === "structural" || mode === "code" ? mode : null;
}
function normalizeSummaryTokens(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SUMMARY_TOKENS;
  return Math.max(MIN_SUMMARY_TOKENS, Math.min(MAX_SUMMARY_TOKENS, Math.floor(parsed)));
}
/** Bounded prefix for stored-payload summarization; avoids unbounded MAX_SAFE_INTEGER reads. */
const SUMMARIZE_STORED_CAP_BYTES = 512 * 1024;
/**
 * Detect handler error results. The Pi tool wrapper in index.ts uses this to
 * throw from execute (Pi ignores returned isError flags). Handler errors
 * carry an explicit isError discriminator, never payload-text heuristics.
 */
export function isErrorResult(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as Record<string, unknown>).isError === true
  );
}

export interface ToolContext {
  store: ContextStore;
  workspaceRoot: string;
  /** Byte budget for one ctx_read result: under the offload threshold at the model boundary, NESTED_READ_BUDGET_BYTES in a program. */
  maxReturnBytes?: number;
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
    "Read part of a previously offloaded tool result by its handle; cheaper than re-running the call that produced it. " +
    "Use offset/length for a byte range, query for matching lines, section for a named part of a Fabric sectioned result, or jsonPath for JSON payloads only. " +
    "At the model boundary a result stays under the offload threshold. Inside fabric_exec a read returns up to 512 KB, with the selected text in .text and metadata in .details.result, to filter in code.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The handle returned when the data was offloaded." },
      offset: { type: "integer", description: "0-based byte offset for ranged read. Defaults to 0." },
      length: { type: "integer", description: "Bytes to read. Defaults to the most one result allows. Ranged results include a copyable nextOffset when more remains." },
      query: {
        anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        description: "Literal text to find per line, or an array of terms to match lines containing any of them. Overrides offset/length.",
      },
      regex: { type: "boolean", description: "Treat each query term as a JavaScript RegExp matched per line. Default false (literal)." },
      ignoreCase: { type: "boolean", description: "Case-insensitive query matching. Default false (case-sensitive)." },
      jsonPath: { type: "string", description: "Dot/bracket JSON path for a stored JSON payload, e.g. $.results[0].name; no wildcards or slices. Overrides section/query/offset/length." },
      section: { type: "string", description: "Section name listed in a Fabric sectioned preview. Overrides query; offset/length page within the section." },
      contextLines: { type: "integer", description: "Lines of context around each query match. Default 2; clamped to 0-50." },
      maxMatches: { type: "integer", description: "Maximum matching lines per query page; totalMatches counts the scanned payload. Default 100; maximum 500." },
      cursor: { type: "string", description: "Query continuation from nextCursor. Keep the same id, query, regex, ignoreCase and contextLines; page size may change." },
    },
    required: ["id"],
  },
  async handler(args, ctx) {
    // At the model boundary, self-cap output so a ctx_read result never
    // reaches the auto-offload threshold; otherwise reading a handle would
    // produce another handle. Inside a program the caller passes the larger
    // nested budget.
    const budget = Math.max(
      512,
      (ctx.maxReturnBytes ?? DEFAULT_MAX_RETURN_BYTES) - RESULT_ENVELOPE_SLACK_BYTES
    );
    const id = args.id as string | undefined;
    if (typeof id !== "string" || id.length === 0) {
      return { error: "ctx_read requires a stored id.", code: "missing_id", isError: true as const };
    }

    if (args.jsonPath !== undefined) {
      const result = await ctx.store.read(id, {
        jsonPath: String(args.jsonPath),
      });
      if (!result.ok) {
        return { error: result.content, code: "stored_read_failed", isError: true as const };
      }
      return capContent(result, budget, "narrow the JSON path or select a smaller value");
    }

    if (args.section !== undefined) {
      const requested = args.length as number | undefined;
      const result = await ctx.store.read(id, {
        section: String(args.section),
        offset: args.offset as number | undefined,
        length: Math.min(requested ?? budget, budget),
      });
      if (!result.ok) {
        return { error: result.content, code: "stored_read_failed", isError: true as const };
      }
      return capContent(result, budget, "use offset to page through the section");
    }

    const terms = (Array.isArray(args.query) ? args.query : args.query == null ? [] : [args.query])
      .map((term) => String(term)).filter(Boolean);
    if (terms.length > 0) {
      const regex = args.regex === true;
      if (regex) {
        for (const term of terms) {
          try {
            new RegExp(term);
          } catch {
            return { error: `Invalid regex: ${term}`, code: "invalid_regex", isError: true as const };
          }
        }
      }
      const requestedContextLines = Number(args.contextLines);
      const contextLines = Number.isFinite(requestedContextLines)
        ? Math.max(0, Math.min(50, Math.floor(requestedContextLines)))
        : undefined;
      const maxMatches = Math.max(1, Math.min(500, Math.floor(Number(args.maxMatches) || 100)));
      const result = await ctx.store.read(id, {
        query: terms.length === 1 ? terms[0] : terms,
        regex,
        ignoreCase: args.ignoreCase === true,
        contextLines,
        maxMatches,
        cursor: args.cursor as string | undefined,
        maxBytes: budget,
      });
      if (!result.ok) {
        return { error: result.content, code: "stored_read_failed", isError: true as const };
      }
      // Query pages are budgeted before formatting and carry a lossless cursor.
      // Miss hints have no cursor and can still use the general content cap.
      return result.totalMatches ? result : capContent(result, budget, "narrow the query or reduce contextLines");
    }

    if (args.cursor !== undefined) return { error: "cursor requires a query.", code: "invalid_cursor", isError: true as const };
    const requested = args.length as number | undefined;
    const result = await ctx.store.read(id, {
      offset: args.offset as number | undefined,
      length: Math.min(requested ?? budget, budget),
    });
    if (!result.ok) {
      return { error: result.content, code: "stored_read_failed", isError: true as const };
    }
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

// ---- ctx_summarize: compress data structurally ----

const ctxSummarize: ToolDef = {
  name: "ctx_summarize",
  description:
    "Compress a stored payload or inline text into a small structured summary. " +
    "Deterministic and free: extracts keys, counts, signatures, and first/last lines.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Handle of a stored payload to summarize." },
      text: { type: "string", description: "Inline text to summarize (used if no id)." },
      mode: {
        type: "string",
        enum: ["structural", "code"],
        description: "structural = general extraction. code = code-aware extraction. Default: structural.",
      },
      maxTokens: { type: "integer", description: "Target max tokens for the summary. Default 500." },
    },
  },
  async handler(args, ctx) {
    const mode = normalizeSummaryMode(args.mode);
    if (!mode) return { error: "Unknown summary mode. Use structural or code.", code: "invalid_summary_mode", allowedModes: ["structural", "code"], isError: true as const };
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
      return { error: "Provide either id (stored payload) or text (inline).", code: "missing_id_or_text", isError: true as const };
    }

    if (storedId) {
      const prefix = readStoredPrefix(ctx.store, storedId, SUMMARIZE_STORED_CAP_BYTES);
      if (prefix.error) return { error: prefix.error, code: "stored_read_failed", source, isError: true as const };
      data = prefix.data;
      const summary = summarizeText(data ?? "", maxTokens, mode, source) as Record<string, unknown>;
      if (prefix.truncated) {
        return {
          ...summary,
          inputTruncated: true,
          totalBytes: prefix.totalBytes,
          note: `Stored payload truncated to first ${SUMMARIZE_STORED_CAP_BYTES} bytes of ${prefix.totalBytes}; use ctx_read with offset to page through the rest.`,
        };
      }
      return summary;
    }
    return summarizeText(data ?? "", maxTokens, mode, source);
  },
};

function isContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
}

/**
 * Bounded prefix read for summarization. Probes totalBytes with a
 * zero-length read, then reads at most capBytes and strips the store's paging
 * note via bytesRead so summaries never ingest an unbounded payload.
 */
function readStoredPrefix(
  store: ContextStore,
  id: string,
  capBytes: number
): { data: string; totalBytes: number; truncated: boolean; error?: string } {
  const probe = store.read(id, { offset: 0, length: 0 });
  if (!probe.ok) return { data: "", totalBytes: 0, truncated: false, error: probe.content };
  const totalBytes = probe.totalBytes;
  if (totalBytes === 0) return { data: "", totalBytes: 0, truncated: false };
  const bounded = Math.max(1, Math.min(capBytes, totalBytes));
  const result = store.read(id, { offset: 0, length: bounded });
  if (!result.ok) return { data: "", totalBytes, truncated: false, error: result.content };
  const payloadBytes = result.truncated ? result.bytesRead : Buffer.byteLength(result.content, "utf8");
  const data = Buffer.from(result.content, "utf8").subarray(0, payloadBytes).toString("utf8");
  return { data, totalBytes, truncated: result.truncated };
}

// ---- Export all tools ----

export const ceTools: ToolDef[] = [
  ctxRead,
  ctxSummarize,
];

export const ceToolMap = new Map(ceTools.map((t) => [t.name, t]));

// ---- Structural summary implementation ----

/** Deterministic compression behind ctx_summarize. */
function summarizeText(data: string, maxTokens = 500, mode: "structural" | "code" = "structural", source = "inline"): unknown {
  const budget = normalizeSummaryTokens(maxTokens);
  return capSummary(structuralSummary(data, source, budget, mode), budget);
}

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
