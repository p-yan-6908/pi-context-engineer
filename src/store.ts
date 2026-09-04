/*
 * Addressable off-window context storage.
 *
 * The index contains metadata only. Payloads live in content-addressed blobs so
 * hash lookup, listing, and garbage collection never parse every payload.
 * Legacy <id>.json entries are migrated on first open.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { inferContentType, structuralPreview, type PreviewContentType } from "./preview.js";

export const DEFAULT_CONTEXT_STORE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_CONTEXT_STORE_BYTES = 500_000_000;
export const DEFAULT_MEMORY_STORE_MAX_BYTES = 5_000_000;

export interface StoreEntry {
  id: string;
  key: string;
  created: string;
  updatedAt: string;
  lastAccessed: string;
  source: string;
  contentHash: string;
  contentType: PreviewContentType;
  bytes: number;
  estimatedTokens: number;
  expiresAt?: string;
  data: string;
}

export interface StoreOptions {
  /** Remove entries older than this many milliseconds. Defaults to one week; 0 is persistent. */
  ttlMs?: number;
  /** Keep total payload bytes below this value; values above the global 500 MB cap are clamped. */
  maxBytes?: number;
}

export interface StoreWriteOptions {
  contentType?: StoreEntry["contentType"];
  expiresAt?: string;
  /** Replace an existing entry with the same key. */
  upsert?: boolean;
  /** Deduplicate identical content by hash. Defaults to true. */
  deduplicate?: boolean;
}

export interface ReadOptions {
  /** 0-based UTF-8 byte offset. Ranges expand to complete code points. */
  offset?: number;
  /** Number of UTF-8 bytes to read. Ranges expand at most one code point at each boundary. */
  length?: number;
  /** Literal substring to search for; returns matching lines with context. */
  query?: string;
  /** Dot/bracket JSON path, for example `$.results[0].name`. */
  jsonPath?: string;
  /** Lines of context around each query match. */
  contextLines?: number;
  /** Maximum matching windows to format while still counting every match. */
  maxMatches?: number;
}

export interface ReadResult {
  id: string;
  totalBytes: number;
  totalTokens: number;
  /** Stored payload type; retained on ranges and JSON-path selections. */
  contentType?: PreviewContentType;
  /** Selected JSON path when this is a structured lookup. */
  jsonPath?: string;
  /** Runtime type of the selected JSON value. */
  selectedType?: string;
  bytesRead: number;
  /** Actual byte offset used for a ranged read. */
  offset?: number;
  /** Copyable next byte offset when more ranged content remains. */
  nextOffset?: number;
  content: string;
  matchedLines?: number[];
  /** Total query matches when matchedLines is later metadata-capped. */
  totalMatches?: number;
  truncated: boolean;
}

type StoreMetadata = Omit<StoreEntry, "data"> & { blobPath: string };

export interface StoreHandle {
  id: string;
  key: string;
  source: string;
  contentType: PreviewContentType;
  preview: string;
  bytes: number;
  estimatedTokens: number;
}

interface StoreIndex {
  version: 1;
  entries: StoreMetadata[];
}

const DEFAULT_PREVIEW_BYTES = 2048;
const DEFAULT_CONTEXT_LINES = 2;
const STORE_DIR_MODE = 0o700;
const BLOB_MODE = 0o600;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 5;

function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function normalizeTtlMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CONTEXT_STORE_TTL_MS;
  return Math.max(0, Math.floor(value));
}

function normalizeMaxBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_CONTEXT_STORE_BYTES;
  return Math.max(0, Math.min(MAX_CONTEXT_STORE_BYTES, Math.floor(value)));
}

function isContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
}

/** Return a UTF-8 prefix that never ends inside a multi-byte code point. */
function utf8Prefix(data: string, maxBytes: number): string {
  const buffer = Buffer.from(data, "utf8");
  let end = Math.max(0, Math.min(buffer.length, Math.floor(maxBytes)));
  while (end > 0 && isContinuationByte(buffer[end])) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function normalizeId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && !value.includes("/") && !value.includes("\\")
    ? value
    : undefined;
}

export class ContextStore {
  private readonly dir: string;
  private readonly blobsDir: string;
  private readonly indexFile: string;
  private readonly lockFile: string;
  private readonly options: StoreOptions;

  constructor(workspaceRoot: string, relativeDir = ".pi/context-store", options: StoreOptions = {}) {
    this.dir = resolve(workspaceRoot, relativeDir);
    this.blobsDir = join(this.dir, "blobs");
    this.indexFile = join(this.dir, "index.json");
    this.lockFile = join(this.dir, ".index.lock");
    this.options = {
      ttlMs: normalizeTtlMs(options.ttlMs),
      maxBytes: normalizeMaxBytes(options.maxBytes),
    };
    this.ensureLayout();
  }

  /** Write a payload, deduplicating identical content by hash unless disabled. */
  write(
    key: string,
    source: string,
    data: string,
    writeOptions: StoreWriteOptions = {},
  ): StoreHandle {
    const bytes = Buffer.byteLength(data, "utf8");
    const contentHash = this.hash(data);

    return this.withLock(() => {
      let entries = this.loadAll();
      entries = this.cleanEntries(entries);

      const now = new Date().toISOString();
      const existingByKey = writeOptions.upsert ? entries.find((entry) => entry.key === key) : undefined;
      if (existingByKey) entries = entries.filter((entry) => entry.id !== existingByKey.id);

      const existingByHash = writeOptions.deduplicate === false
        ? undefined
        : entries.find((entry) => entry.contentHash === contentHash && !this.isExpired(entry));
      if (existingByHash) {
        existingByHash.lastAccessed = now;
        existingByHash.updatedAt = now;
        this.writeIndex(entries);
        this.gcLocked(existingByHash.id);
        return this.handleResult(existingByHash, data);
      }

      const entry: StoreMetadata = {
        id: this.makeId(key, contentHash),
        key,
        created: now,
        updatedAt: now,
        lastAccessed: now,
        source,
        contentHash,
        contentType: writeOptions.contentType ?? inferContentType(data),
        bytes,
        estimatedTokens: estimateTokens(bytes),
        blobPath: contentHash,
        ...(writeOptions.expiresAt
          ? { expiresAt: writeOptions.expiresAt }
          : this.options.ttlMs
            ? { expiresAt: new Date(Date.now() + this.options.ttlMs).toISOString() }
            : {}),
      };

      this.writeBlob(entry.blobPath, data);
      entries.push(entry);
      this.writeIndex(entries);
      this.gcLocked(entry.id);
      return this.handleResult(entry, data);
    });
  }

  /** Read a UTF-8 byte range, literal line matches, or a focused JSON path. */
  read(id: string, opts: ReadOptions = {}): ReadResult {
    return this.withLock(() => {
      let entries = this.loadAll();
      entries = this.cleanEntries(entries);
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry) {
        if (entries.length !== this.loadAll().length) this.writeIndex(entries);
        return this.errorResult(id, `Error: no stored result with id "${id}".`);
      }
      if (this.isExpired(entry)) {
        entries = entries.filter((candidate) => candidate.id !== id);
        this.writeIndex(entries);
        this.pruneUnreferencedBlobs(entries);
        return this.errorResult(id, `Error: stored result "${id}" has expired.`);
      }

      const blob = this.blobPath(entry);
      if (!this.hasUsableBlob(entry)) {
        entries = entries.filter((candidate) => candidate.id !== id);
        this.writeIndex(entries);
        return this.errorResult(id, `Error: stored result "${id}" is unavailable (missing payload blob).`);
      }

      entry.lastAccessed = new Date().toISOString();
      this.writeIndex(entries);

      if (opts.jsonPath !== undefined) {
        const data = readFileSync(blob, "utf8");
        return this.readJsonPath(entry, data, opts);
      }

      if (opts.query !== undefined) {
        const data = readFileSync(blob, "utf8");
        return this.readQuery(entry, data, opts);
      }

      return this.readRange(entry, blob, opts);
    });
  }

  /** List metadata only; payload data is never parsed or returned. Expired entries are pruned first. */
  list(): Array<Omit<StoreEntry, "data">> {
    return this.withLock(() => {
      const { entries } = this.gcLocked();
      return entries
        .map(({ blobPath: _blobPath, ...meta }) => meta)
        .sort((a, b) => b.created.localeCompare(a.created));
    });
  }

  /** Remove expired entries and, when configured, oldest entries over budget. */
  gc(options: StoreOptions = this.options, protectedId?: string): { removed: number; bytes: number } {
    return this.withLock(() => {
      const { removed, bytes } = this.gcLocked(protectedId, options);
      return { removed, bytes };
    });
  }

  delete(id: string): boolean {
    return this.withLock(() => {
      const entries = this.loadAll();
      const remaining = entries.filter((entry) => entry.id !== id);
      if (remaining.length === entries.length) return false;
      this.writeIndex(remaining);
      this.pruneUnreferencedBlobs(remaining);
      return true;
    });
  }

  has(id: string): boolean {
    const entry = this.loadAll().find((candidate) => candidate.id === id);
    return Boolean(entry && !this.isExpired(entry) && this.hasUsableBlob(entry));
  }

  private ensureLayout(): void {
    mkdirSync(this.dir, { recursive: true, mode: STORE_DIR_MODE });
    mkdirSync(this.blobsDir, { recursive: true, mode: STORE_DIR_MODE });
    chmodSync(this.dir, STORE_DIR_MODE);
    chmodSync(this.blobsDir, STORE_DIR_MODE);

    if (!existsSync(this.indexFile)) {
      this.withLock(() => {
        if (existsSync(this.indexFile)) return;
        const migrated = this.migrateLegacyEntries();
        this.writeIndex(migrated);
      });
    }
  }

  private migrateLegacyEntries(): StoreMetadata[] {
    const entries: StoreMetadata[] = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json") || file === "index.json") continue;
      try {
        const legacyFile = join(this.dir, file);
        chmodSync(legacyFile, BLOB_MODE);
        const raw = JSON.parse(readFileSync(legacyFile, "utf8")) as Partial<StoreEntry>;
        const legacy = this.normalizeLegacyEntry(raw);
        if (!legacy) continue;
        const metadata = this.toMetadata(legacy);
        this.writeBlob(metadata.blobPath, legacy.data);
        entries.push(metadata);
      } catch {
        // A corrupt legacy entry should not make the entire store unusable.
      }
    }
    return entries;
  }

  private withLock<T>(fn: () => T): T {
    mkdirSync(this.dir, { recursive: true, mode: STORE_DIR_MODE });
    chmodSync(this.dir, STORE_DIR_MODE);
    let fd: number | undefined;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (fd === undefined) {
      try {
        fd = openSync(this.lockFile, "wx", BLOB_MODE);
        writeFileSync(fd, `${process.pid}\n`, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(this.lockFile).mtimeMs > LOCK_TIMEOUT_MS) unlinkSync(this.lockFile);
        } catch {
          // The owner may have released the lock between stat and unlink.
        }
        if (Date.now() >= deadline) throw new Error(`Timed out acquiring context store lock: ${this.lockFile}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
      }
    }

    try {
      return fn();
    } finally {
      try { fsyncSync(fd); } catch { /* lock durability is not required */ }
      closeSync(fd);
      try { unlinkSync(this.lockFile); } catch { /* another recovery path may have removed it */ }
    }
  }

  private loadAll(): StoreMetadata[] {
    if (!existsSync(this.indexFile)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.indexFile, "utf8")) as Partial<StoreIndex> | StoreMetadata[];
      const rawEntries = Array.isArray(raw) ? raw : raw.entries;
      if (!Array.isArray(rawEntries)) return [];
      return rawEntries
        .map((entry) => this.normalizeMetadata(entry as Partial<StoreMetadata>))
        .filter((entry): entry is StoreMetadata => Boolean(entry));
    } catch {
      return [];
    }
  }

  private writeIndex(entries: StoreMetadata[]): void {
    this.writeAtomic(this.indexFile, JSON.stringify({ version: 1, entries }, null, 2), BLOB_MODE);
  }

  private writeBlob(blobPath: string, data: string): void {
    const target = join(this.blobsDir, blobPath);
    if (existsSync(target)) {
      try {
        if (statSync(target).isFile() && statSync(target).size === Buffer.byteLength(data, "utf8")) {
          chmodSync(target, BLOB_MODE);
          return;
        }
      } catch {
        // Recreate a missing or unreadable blob below.
      }
      try { unlinkSync(target); } catch { /* best effort before atomic replacement */ }
    }
    this.writeAtomic(target, data, BLOB_MODE);
  }

  private writeAtomic(path: string, data: string, mode: number): void {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", mode);
    try {
      writeFileSync(fd, data, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temporary, path);
      chmodSync(path, mode);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
      throw error;
    }
  }

  private blobPath(entry: StoreMetadata): string {
    const name = /^[a-f0-9]{64}$/.test(entry.blobPath) ? entry.blobPath : entry.contentHash;
    return join(this.blobsDir, name);
  }

  private hasUsableBlob(entry: StoreMetadata): boolean {
    try {
      const info = statSync(this.blobPath(entry));
      return info.isFile() && info.size === entry.bytes;
    } catch {
      return false;
    }
  }

  private readBlobBytes(path: string, offset: number, length: number): Buffer {
    if (length <= 0) return Buffer.alloc(0);
    const fd = openSync(path, "r");
    const buffer = Buffer.alloc(length);
    let total = 0;
    try {
      while (total < length) {
        const count = readSync(fd, buffer, total, length - total, offset + total);
        if (count === 0) break;
        total += count;
      }
    } finally {
      closeSync(fd);
    }
    return buffer.subarray(0, total);
  }

  private alignUtf8Start(path: string, offset: number): number {
    let actual = offset;
    while (actual > 0 && isContinuationByte(this.readBlobBytes(path, actual, 1)[0])) actual--;
    return actual;
  }

  private alignUtf8End(path: string, end: number, totalBytes: number): number {
    let actual = end;
    while (actual < totalBytes && isContinuationByte(this.readBlobBytes(path, actual, 1)[0])) actual++;
    return actual;
  }

  private baseResult(entry: StoreMetadata): Pick<ReadResult, "id" | "totalBytes" | "totalTokens" | "contentType"> {
    return {
      id: entry.id,
      totalBytes: entry.bytes,
      totalTokens: entry.estimatedTokens,
      contentType: entry.contentType,
    };
  }

  private readRange(entry: StoreMetadata, blob: string, opts: ReadOptions): ReadResult {
    const totalBytes = entry.bytes;
    const requestedOffset = Math.max(0, Math.min(totalBytes, Math.floor(Number(opts.offset) || 0)));
    const requestedLength = Math.max(0, Math.floor(Number(opts.length ?? DEFAULT_PREVIEW_BYTES * 4) || 0));
    if (requestedLength === 0) {
      return {
        ...this.baseResult(entry),
        bytesRead: 0,
        offset: requestedOffset,
        nextOffset: requestedOffset < totalBytes ? requestedOffset : undefined,
        content: "",
        truncated: requestedOffset < totalBytes,
      };
    }

    const requestedEnd = Math.min(totalBytes, requestedOffset + requestedLength);
    // Expand both boundaries to complete code points. This may return up to
    // three bytes beyond the requested end, but never emits U+FFFD for a valid
    // payload and always provides a copyable progress offset.
    const actualOffset = this.alignUtf8Start(blob, requestedOffset);
    const actualEnd = this.alignUtf8End(blob, requestedEnd, totalBytes);
    const content = this.readBlobBytes(blob, actualOffset, Math.max(0, actualEnd - actualOffset)).toString("utf8");
    const truncated = actualEnd < totalBytes;
    return {
      ...this.baseResult(entry),
      bytesRead: actualEnd - actualOffset,
      offset: actualOffset,
      nextOffset: truncated ? actualEnd : undefined,
      content: truncated
        ? content + `\n... [${totalBytes - actualEnd} more bytes, use ctx_read with offset=${actualEnd} to continue]`
        : content,
      truncated,
    };
  }

  private readJsonPath(entry: StoreMetadata, data: string, opts: ReadOptions): ReadResult {
    const jsonPath = opts.jsonPath ?? "$";
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return {
        ...this.baseResult(entry),
        jsonPath,
        content: `Error: stored result "${entry.id}" is not valid JSON; JSON path "${jsonPath}" cannot be selected.`,
        bytesRead: 0,
        truncated: false,
      };
    }

    const parsedPath = parseJsonPath(jsonPath);
    if (typeof parsedPath === "string") {
      return {
        ...this.baseResult(entry),
        jsonPath,
        content: `Error: ${parsedPath}`,
        bytesRead: 0,
        truncated: false,
      };
    }

    let selected = parsed;
    for (const segment of parsedPath) {
      if (Array.isArray(selected) && typeof segment === "number" && segment >= 0 && segment < selected.length) {
        selected = selected[segment];
      } else if (selected && typeof selected === "object" && !Array.isArray(selected) && Object.prototype.hasOwnProperty.call(selected, segment)) {
        selected = (selected as Record<string, unknown>)[segment];
      } else {
        return {
          ...this.baseResult(entry),
          jsonPath,
          content: `Error: JSON path "${jsonPath}" was not found in stored result "${entry.id}".`,
          bytesRead: 0,
          truncated: false,
        };
      }
    }

    const content = JSON.stringify(selected, null, 2) ?? String(selected);
    return {
      ...this.baseResult(entry),
      jsonPath,
      selectedType: Array.isArray(selected) ? "array" : selected === null ? "null" : typeof selected,
      bytesRead: Buffer.byteLength(content, "utf8"),
      content,
      truncated: false,
    };
  }

  private readQuery(entry: StoreMetadata, data: string, opts: ReadOptions): ReadResult {
    const contextLines = Math.max(0, opts.contextLines ?? DEFAULT_CONTEXT_LINES);
    const maxMatches = Math.max(1, opts.maxMatches ?? Number.MAX_SAFE_INTEGER);
    const lines = data.split("\n");
    const matches: number[] = [];
    const result: string[] = [];
    let totalMatches = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(opts.query as string)) continue;
      totalMatches++;
      if (matches.length >= maxMatches) continue;
      matches.push(i + 1);
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length - 1, i + contextLines);
      for (let j = start; j <= end; j++) result.push(`${j === i ? ">>" : "  "} ${j + 1}: ${lines[j]}`);
      result.push("");
    }
    const omitted = Math.max(0, totalMatches - matches.length);
    const content = totalMatches === 0
      ? `No matches for "${opts.query}" in ${entry.key} (${entry.bytes} bytes).`
      : `${totalMatches} match(es) for "${opts.query}":\n${result.join("\n")}` +
        (omitted > 0 ? `\n... [${omitted} additional matches counted but not formatted]` : "");
    return {
      ...this.baseResult(entry),
      bytesRead: Buffer.byteLength(content, "utf8"),
      content,
      matchedLines: matches,
      totalMatches,
      truncated: omitted > 0,
    };
  }

  private cleanEntries(entries: StoreMetadata[], options = this.options): StoreMetadata[] {
    const kept: StoreMetadata[] = [];
    let changed = false;
    for (const entry of entries) {
      if (this.isExpired(entry, options) || !this.hasUsableBlob(entry)) {
        changed = true;
        continue;
      }
      kept.push(entry);
    }
    if (changed) {
      this.writeIndex(kept);
      this.pruneUnreferencedBlobs(kept);
    }
    return kept;
  }

  private gcLocked(protectedId?: string, options = this.options): { entries: StoreMetadata[]; removed: number; bytes: number } {
    let entries = this.loadAll();
    const before = entries.length;
    entries = this.cleanEntries(entries, options);
    let removed = before - entries.length;
    let bytes = entries.reduce((total, entry) => total + entry.bytes, 0);

    if (options.maxBytes !== undefined && options.maxBytes >= 0 && bytes > options.maxBytes) {
      const oldest = [...entries].sort((a, b) => (a.lastAccessed ?? a.created).localeCompare(b.lastAccessed ?? b.created));
      for (const entry of oldest) {
        if (bytes <= options.maxBytes) break;
        if (entry.id === protectedId) continue;
        entries = entries.filter((candidate) => candidate.id !== entry.id);
        bytes -= entry.bytes;
        removed++;
      }
      this.writeIndex(entries);
    }

    this.pruneUnreferencedBlobs(entries);
    return { entries, removed, bytes };
  }

  private pruneUnreferencedBlobs(entries: StoreMetadata[]): void {
    const referenced = new Set(entries.map((entry) => entry.blobPath));
    for (const file of readdirSync(this.blobsDir)) {
      if (file.includes(".tmp") || referenced.has(file)) continue;
      try { unlinkSync(join(this.blobsDir, file)); } catch { /* best effort cleanup */ }
    }
  }

  private normalizeLegacyEntry(raw: Partial<StoreEntry>): StoreEntry | null {
    if (typeof raw.id !== "string" || typeof raw.key !== "string" || typeof raw.data !== "string") return null;
    const bytes = Buffer.byteLength(raw.data, "utf8");
    const created = raw.created ?? new Date().toISOString();
    return {
      id: raw.id,
      key: raw.key,
      created,
      updatedAt: raw.updatedAt ?? raw.lastAccessed ?? created,
      lastAccessed: raw.lastAccessed ?? created,
      source: raw.source ?? "unknown",
      contentHash: typeof raw.contentHash === "string" && /^[a-f0-9]{64}$/.test(raw.contentHash)
        ? raw.contentHash
        : this.hash(raw.data),
      contentType: raw.contentType ?? inferContentType(raw.data),
      bytes,
      estimatedTokens: raw.estimatedTokens ?? estimateTokens(bytes),
      ...(raw.expiresAt ? { expiresAt: raw.expiresAt } : {}),
      data: raw.data,
    };
  }

  private normalizeMetadata(raw: Partial<StoreMetadata>): StoreMetadata | null {
    if (
      typeof raw.id !== "string" ||
      typeof raw.key !== "string" ||
      !/^[a-f0-9]{64}$/.test(raw.contentHash)
    ) return null;
    const created = typeof raw.created === "string" ? raw.created : new Date().toISOString();
    const bytes = typeof raw.bytes === "number" && Number.isFinite(raw.bytes) ? Math.max(0, raw.bytes) : 0;
    const blobPath = typeof raw.blobPath === "string" && /^[a-f0-9]{64}$/.test(raw.blobPath)
      ? raw.blobPath
      : raw.contentHash;
    const contentType = raw.contentType === "json" || raw.contentType === "code" || raw.contentType === "text" || raw.contentType === "unknown"
      ? raw.contentType
      : "unknown";
    return {
      id: raw.id,
      key: raw.key,
      created,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : (typeof raw.lastAccessed === "string" ? raw.lastAccessed : created),
      lastAccessed: typeof raw.lastAccessed === "string" ? raw.lastAccessed : created,
      source: typeof raw.source === "string" ? raw.source : "unknown",
      contentHash: raw.contentHash,
      contentType,
      bytes,
      estimatedTokens: typeof raw.estimatedTokens === "number" && Number.isFinite(raw.estimatedTokens)
        ? Math.max(0, raw.estimatedTokens)
        : estimateTokens(bytes),
      ...(typeof raw.expiresAt === "string" ? { expiresAt: raw.expiresAt } : {}),
      blobPath,
    };
  }

  private toMetadata(entry: StoreEntry): StoreMetadata {
    const { data: _data, ...metadata } = entry;
    return { ...metadata, blobPath: entry.contentHash };
  }

  private isExpired(entry: StoreMetadata, options = this.options): boolean {
    if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) return true;
    // ttlMs=0 explicitly means no age-based expiry.
    return options.ttlMs !== undefined && options.ttlMs > 0 && Date.parse(entry.created) + options.ttlMs <= Date.now();
  }

  private handleResult(entry: StoreMetadata, data: string): StoreHandle {
    const preview = structuralPreview(data, DEFAULT_PREVIEW_BYTES, entry.contentType);
    const truncated = entry.bytes > DEFAULT_PREVIEW_BYTES;
    return {
      id: entry.id,
      key: entry.key,
      source: entry.source,
      contentType: entry.contentType,
      preview: truncated ? preview + "\n... [truncated, use ctx_read to inspect]" : preview,
      bytes: entry.bytes,
      estimatedTokens: entry.estimatedTokens,
    };
  }

  private errorResult(id: string, content: string): ReadResult {
    return { id, totalBytes: 0, totalTokens: 0, bytesRead: 0, content, truncated: false };
  }

  private hash(data: string): string {
    return createHash("sha256").update(data, "utf8").digest("hex");
  }

  private makeId(key: string, contentHash: string): string {
    return `${key.replace(/[^a-z0-9]/gi, "-").slice(0, 32)}-${contentHash.slice(0, 12)}`;
  }
}

function parseJsonPath(path: string): Array<string | number> | string {
  const input = path.trim();
  if (!input) return "JSON path must not be empty.";
  if (input === "$") return [];

  const segments: Array<string | number> = [];
  let index = input.startsWith("$") ? 1 : 0;
  if (input.startsWith(".", index)) index++;

  while (index < input.length) {
    if (input[index] === ".") {
      index++;
      if (index >= input.length) return `JSON path "${path}" ends after a separator.`;
    }

    if (input[index] === "[") {
      const close = input.indexOf("]", index + 1);
      if (close < 0) return `JSON path "${path}" has an unclosed bracket.`;
      const token = input.slice(index + 1, close).trim();
      if (/^\d+$/.test(token)) segments.push(Number(token));
      else if ((token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'") && token.endsWith("'"))) {
        segments.push(token.slice(1, -1));
      } else {
        return `JSON path "${path}" has an invalid bracket segment "${token}".`;
      }
      index = close + 1;
      continue;
    }

    const match = /^[A-Za-z_$][\w$-]*/.exec(input.slice(index));
    if (!match) return `JSON path "${path}" has an invalid segment near "${input.slice(index)}".`;
    segments.push(match[0]);
    index += match[0].length;
  }
  return segments;
}
