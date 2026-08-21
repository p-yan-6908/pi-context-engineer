/**
 * pi-context-engineer — off-window storage layer.
 *
 * Implements the "Write" strategy: heavy tool results are written to disk and
 * referenced by handle, never inlined into model context.
 *
 * Storage layout:
 *   <workspace>/.pi/context-store/<id>.json   ← data + metadata
 *
 * Each entry is self-describing so handles survive session restarts and can
 * be inspected outside the agent.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

export interface StoreEntry {
  id: string;
  key: string;            // human label, e.g. "grep-results-router"
  created: string;        // ISO timestamp
  source: string;         // what produced this, e.g. "grep" | "read_file" | "bash"
  bytes: number;
  estimatedTokens: number;
  data: string;           // the full payload, kept on disk only
}

export interface ReadOptions {
  /** 0-based start byte offset */
  offset?: number;
  /** number of bytes to read */
  length?: number;
  /** literal substring to search for; if set, returns matching lines with context */
  query?: string;
  /** lines of context around each query match */
  contextLines?: number;
}

export interface ReadResult {
  id: string;
  totalBytes: number;
  totalTokens: number;
  bytesRead: number;
  /** the requested slice or matched lines */
  content: string;
  /** when query mode, the matched line numbers */
  matchedLines?: number[];
  truncated: boolean;
}

const DEFAULT_PREVIEW_BYTES = 2048;   // ~512 tokens
const DEFAULT_CONTEXT_LINES = 2;

export class ContextStore {
  private readonly dir: string;

  constructor(workspaceRoot: string, relativeDir = ".pi/context-store") {
    this.dir = resolve(workspaceRoot, relativeDir);
  }

  /** Write a payload to disk, return a handle + preview. */
  write(key: string, source: string, data: string): { id: string; preview: string; bytes: number; estimatedTokens: number } {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });

    const id = this.makeId(key, data);
    const entry: StoreEntry = {
      id,
      key,
      created: new Date().toISOString(),
      source,
      bytes: Buffer.byteLength(data, "utf-8"),
      estimatedTokens: Math.ceil(data.length / 4),
      data,
    };

    writeFileSync(this.path(id), JSON.stringify(entry, null, 2), "utf-8");

    const preview = data.slice(0, DEFAULT_PREVIEW_BYTES);
    const truncated = data.length > DEFAULT_PREVIEW_BYTES;

    return {
      id,
      preview: truncated ? preview + "\n... [truncated, use ctx_read to inspect]" : preview,
      bytes: entry.bytes,
      estimatedTokens: entry.estimatedTokens,
    };
  }

  /** Read a slice or search within a stored payload. */
  read(id: string, opts: ReadOptions = {}): ReadResult {
    const entry = this.loadEntry(id);
    if (!entry) {
      return {
        id,
        totalBytes: 0,
        totalTokens: 0,
        bytesRead: 0,
        content: `Error: no stored result with id "${id}".`,
        truncated: false,
      };
    }

    const { data } = entry;

    // Query mode: search for a literal substring, return matching lines + context
    if (opts.query) {
      const contextLines = opts.contextLines ?? DEFAULT_CONTEXT_LINES;
      const lines = data.split("\n");
      const matches: number[] = [];
      const result: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(opts.query)) {
          matches.push(i + 1);
          const start = Math.max(0, i - contextLines);
          const end = Math.min(lines.length - 1, i + contextLines);
          for (let j = start; j <= end; j++) {
            const prefix = j === i ? ">>" : "  ";
            result.push(`${prefix} ${j + 1}: ${lines[j]}`);
          }
          result.push(""); // blank line between matches
        }
      }

      return {
        id,
        totalBytes: entry.bytes,
        totalTokens: entry.estimatedTokens,
        bytesRead: Buffer.byteLength(result.join("\n"), "utf-8"),
        content: matches.length === 0
          ? `No matches for "${opts.query}" in ${entry.key} (${entry.bytes} bytes).`
          : `${matches.length} match(es) for "${opts.query}":\n${result.join("\n")}`,
        matchedLines: matches,
        truncated: false,
      };
    }

    // Range mode: byte offset + length
    const offset = opts.offset ?? 0;
    const length = opts.length ?? DEFAULT_PREVIEW_BYTES * 4;
    const slice = data.slice(offset, offset + length);
    const truncated = offset + length < data.length;

    return {
      id,
      totalBytes: entry.bytes,
      totalTokens: entry.estimatedTokens,
      bytesRead: Buffer.byteLength(slice, "utf-8"),
      content: truncated
        ? slice + `\n... [${entry.bytes - offset - length} more bytes, use ctx_read with offset to continue]`
        : slice,
      truncated,
    };
  }

  /** List all stored entries (metadata only, no data). */
  list(): Array<Omit<StoreEntry, "data">> {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const raw = JSON.parse(readFileSync(join(this.dir, f), "utf-8")) as StoreEntry;
        const { data: _data, ...meta } = raw;
        return meta;
      })
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  /** Delete a stored entry. */
  delete(id: string): boolean {
    const p = this.path(id);
    if (existsSync(p)) {
      unlinkSync(p);
      return true;
    }
    return false;
  }

  /** Check if an entry exists. */
  has(id: string): boolean {
    return existsSync(this.path(id));
  }

  // --- internals ---

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private loadEntry(id: string): StoreEntry | null {
    const p = this.path(id);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as StoreEntry;
  }

  private makeId(key: string, data: string): string {
    const hash = createHash("sha256").update(key + data).digest("hex").slice(0, 12);
    return `${key.replace(/[^a-z0-9]/gi, "-").slice(0, 32)}-${hash}`;
  }
}
