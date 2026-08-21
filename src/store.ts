/**
 * Addressable off-window context storage.
 *
 * Payloads live on disk and handles carry only metadata into the model.  The
 * store is deliberately dependency-free: content hashing, bounded reads, and
 * literal line selection are enough for the v1 runtime, while semantic code
 * retrieval remains Fovea's responsibility.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface StoreEntry {
  id: string;
  key: string;
  created: string;
  lastAccessed: string;
  source: string;
  contentHash: string;
  contentType: "json" | "code" | "text" | "unknown";
  bytes: number;
  estimatedTokens: number;
  expiresAt?: string;
  data: string;
}

export interface StoreOptions {
  /** Remove entries older than this many milliseconds. */
  ttlMs?: number;
  /** Keep the total payload bytes below this value where possible. */
  maxBytes?: number;
}

export interface StoreWriteOptions {
  contentType?: StoreEntry["contentType"];
  expiresAt?: string;
}

export interface ReadOptions {
  /** 0-based UTF-8 byte offset. */
  offset?: number;
  /** Number of UTF-8 bytes to read. */
  length?: number;
  /** Literal substring to search for; returns matching lines with context. */
  query?: string;
  /** Lines of context around each query match. */
  contextLines?: number;
}

export interface ReadResult {
  id: string;
  totalBytes: number;
  totalTokens: number;
  bytesRead: number;
  content: string;
  matchedLines?: number[];
  truncated: boolean;
}

const DEFAULT_PREVIEW_BYTES = 2048;
const DEFAULT_CONTEXT_LINES = 2;

function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function utf8Slice(data: string, maxBytes: number): string {
  return Buffer.from(data, "utf8").subarray(0, maxBytes).toString("utf8");
}

export class ContextStore {
  private readonly dir: string;
  private readonly options: StoreOptions;

  constructor(workspaceRoot: string, relativeDir = ".pi/context-store", options: StoreOptions = {}) {
    this.dir = resolve(workspaceRoot, relativeDir);
    this.options = options;
  }

  /** Write a payload, deduplicating identical content by hash. */
  write(key: string, source: string, data: string, writeOptions: StoreWriteOptions = {}): { id: string; preview: string; bytes: number; estimatedTokens: number } {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });

    const bytes = Buffer.byteLength(data, "utf8");
    const contentHash = this.hash(data);
    const existing = this.findByContentHash(contentHash);
    if (existing && !this.isExpired(existing)) {
      existing.lastAccessed = new Date().toISOString();
      this.writeEntry(existing);
      this.gc();
      return this.handleResult(existing);
    }
    if (existing) this.delete(existing.id);

    const now = new Date();
    const entry: StoreEntry = {
      id: this.makeId(key, contentHash),
      key,
      created: now.toISOString(),
      lastAccessed: now.toISOString(),
      source,
      contentHash,
      contentType: writeOptions.contentType ?? inferContentType(data),
      bytes,
      estimatedTokens: estimateTokens(bytes),
      ...(writeOptions.expiresAt ? { expiresAt: writeOptions.expiresAt } : this.options.ttlMs ? { expiresAt: new Date(now.getTime() + this.options.ttlMs).toISOString() } : {}),
      data,
    };

    this.writeEntry(entry);
    this.gc(this.options, entry.id);
    return this.handleResult(entry);
  }

  /** Read a UTF-8 byte range or literal line matches. */
  read(id: string, opts: ReadOptions = {}): ReadResult {
    const entry = this.loadEntry(id);
    if (!entry) {
      return { id, totalBytes: 0, totalTokens: 0, bytesRead: 0, content: `Error: no stored result with id "${id}".`, truncated: false };
    }
    if (this.isExpired(entry)) {
      this.delete(id);
      return { id, totalBytes: 0, totalTokens: 0, bytesRead: 0, content: `Error: stored result "${id}" has expired.`, truncated: false };
    }

    entry.lastAccessed = new Date().toISOString();
    this.writeEntry(entry);
    const { data } = entry;

    if (opts.query) {
      const contextLines = opts.contextLines ?? DEFAULT_CONTEXT_LINES;
      const lines = data.split("\n");
      const matches: number[] = [];
      const result: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(opts.query)) continue;
        matches.push(i + 1);
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length - 1, i + contextLines);
        for (let j = start; j <= end; j++) result.push(`${j === i ? ">>" : "  "} ${j + 1}: ${lines[j]}`);
        result.push("");
      }
      const content = matches.length === 0
        ? `No matches for "${opts.query}" in ${entry.key} (${entry.bytes} bytes).`
        : `${matches.length} match(es) for "${opts.query}":\n${result.join("\n")}`;
      return {
        id,
        totalBytes: entry.bytes,
        totalTokens: entry.estimatedTokens,
        bytesRead: Buffer.byteLength(content, "utf8"),
        content,
        matchedLines: matches,
        truncated: false,
      };
    }

    const buffer = Buffer.from(data, "utf8");
    const offset = Math.max(0, opts.offset ?? 0);
    const length = Math.max(0, opts.length ?? DEFAULT_PREVIEW_BYTES * 4);
    const slice = buffer.subarray(offset, offset + length).toString("utf8");
    const end = Math.min(buffer.length, offset + length);
    const truncated = end < buffer.length;
    const remaining = Math.max(0, buffer.length - end);
    return {
      id,
      totalBytes: entry.bytes,
      totalTokens: entry.estimatedTokens,
      bytesRead: Buffer.byteLength(slice, "utf8"),
      content: truncated ? slice + `\n... [${remaining} more bytes, use ctx_read with offset to continue]` : slice,
      truncated,
    };
  }

  /** List metadata only; payload data never appears in this result. */
  list(): Array<Omit<StoreEntry, "data">> {
    if (!existsSync(this.dir)) return [];
    return this.loadAll()
      .map((entry) => {
        const { data: _data, ...meta } = entry;
        return meta;
      })
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  /** Remove expired entries and, when configured, oldest entries over budget. */
  gc(options: StoreOptions = this.options, protectedId?: string): { removed: number; bytes: number } {
    if (!existsSync(this.dir)) return { removed: 0, bytes: 0 };
    const entries = this.loadAll();
    let removed = 0;
    for (const entry of entries) {
      if (this.isExpired(entry, options)) {
        if (this.delete(entry.id)) removed++;
      }
    }

    const remaining = this.loadAll();
    let bytes = remaining.reduce((total, entry) => total + entry.bytes, 0);
    if (options.maxBytes !== undefined && options.maxBytes >= 0 && bytes > options.maxBytes) {
      const oldest = [...remaining].sort((a, b) => (a.lastAccessed ?? a.created).localeCompare(b.lastAccessed ?? b.created));
      for (const entry of oldest) {
        if (bytes <= options.maxBytes) break;
        if (entry.id === protectedId) continue;
        if (this.delete(entry.id)) {
          bytes -= entry.bytes;
          removed++;
        }
      }
    }
    return { removed, bytes };
  }

  delete(id: string): boolean {
    const file = this.path(id);
    if (!existsSync(file)) return false;
    unlinkSync(file);
    return true;
  }

  has(id: string): boolean {
    return existsSync(this.path(id));
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private writeEntry(entry: StoreEntry): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(entry.id), JSON.stringify(entry, null, 2), "utf8");
  }

  private loadEntry(id: string): StoreEntry | null {
    const file = this.path(id);
    if (!existsSync(file)) return null;
    try {
      return this.normalizeEntry(JSON.parse(readFileSync(file, "utf8")) as Partial<StoreEntry>);
    } catch {
      return null;
    }
  }

  private loadAll(): StoreEntry[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => {
        try { return this.normalizeEntry(JSON.parse(readFileSync(join(this.dir, file), "utf8")) as Partial<StoreEntry>); } catch { return undefined; }
      })
      .filter((entry): entry is StoreEntry => Boolean(entry));
  }

  private findByContentHash(contentHash: string): StoreEntry | null {
    return this.loadAll().find((entry) => entry.contentHash === contentHash) ?? null;
  }

  private isExpired(entry: StoreEntry, options = this.options): boolean {
    if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) return true;
    return options.ttlMs !== undefined && Date.parse(entry.created) + options.ttlMs <= Date.now();
  }

  private normalizeEntry(raw: Partial<StoreEntry>): StoreEntry | null {
    if (typeof raw.id !== "string" || typeof raw.key !== "string" || typeof raw.data !== "string") return null;
    const bytes = raw.bytes ?? Buffer.byteLength(raw.data, "utf8");
    return {
      id: raw.id,
      key: raw.key,
      created: raw.created ?? new Date().toISOString(),
      lastAccessed: raw.lastAccessed ?? raw.created ?? new Date().toISOString(),
      source: raw.source ?? "unknown",
      contentHash: raw.contentHash ?? this.hash(raw.data),
      contentType: raw.contentType ?? inferContentType(raw.data),
      bytes,
      estimatedTokens: raw.estimatedTokens ?? estimateTokens(bytes),
      ...(raw.expiresAt ? { expiresAt: raw.expiresAt } : {}),
      data: raw.data,
    };
  }

  private handleResult(entry: StoreEntry): { id: string; preview: string; bytes: number; estimatedTokens: number } {
    const preview = utf8Slice(entry.data, DEFAULT_PREVIEW_BYTES);
    const truncated = entry.bytes > DEFAULT_PREVIEW_BYTES;
    return {
      id: entry.id,
      preview: truncated ? preview + "\n... [truncated, use ctx_read to inspect]" : preview,
      bytes: entry.bytes,
      estimatedTokens: entry.estimatedTokens,
    };
  }

  private hash(data: string): string {
    return createHash("sha256").update(data, "utf8").digest("hex");
  }

  private makeId(key: string, contentHash: string): string {
    return `${key.replace(/[^a-z0-9]/gi, "-").slice(0, 32)}-${contentHash.slice(0, 12)}`;
  }
}

function inferContentType(data: string): StoreEntry["contentType"] {
  const trimmed = data.trim();
  try {
    JSON.parse(trimmed);
    return "json";
  } catch {
    if (/^(?:import |export |from |const |let |var |function |class |interface |def |package )/m.test(trimmed)) return "code";
    return trimmed.length > 0 ? "text" : "unknown";
  }
}
