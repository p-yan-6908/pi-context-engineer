/*
 * Addressable off-window context storage.
 *
 * The index contains metadata only. Payloads live in content-addressed blobs so
 * hash lookup, listing, and garbage collection never parse every payload.
 * Leftover <id>.json entries from the pre-0.4 layout are deleted on first open.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
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
import { fabricSection, fabricSectionNames, inferContentType, structuralPreview, type PreviewContentType } from "./preview.js";

export const DEFAULT_CONTEXT_STORE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_CONTEXT_STORE_BYTES = 500_000_000;

/** Extendable secret patterns redacted from previews and error text. */
export const SECRET_REDACT_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /sk-[A-Za-z0-9_\-]{8,}/g,
  /xox[baprs]-[A-Za-z0-9\-_]+/g,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
];

/** Redact secrets from preview/error text; extendable via extra patterns. */
export function redactSecrets(text: string, extra: RegExp[] = []): string {
  let out = text;
  for (const rx of [...SECRET_REDACT_PATTERNS, ...extra]) {
    try {
      rx.lastIndex = 0;
      out = out.replace(rx, "[REDACTED]");
    } catch {
      // A bad extra pattern must never break storage.
    }
  }
  return out;
}

/** Directories whose layout is initialized; avoids mkdir/chmod per operation. */
const layoutInitCache = new Set<string>();
/** Process-wide handle-ID counter ensuring auto IDs are unique. */
let storeIdCounter = 0;

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
}

export interface ReadOptions {
  /** 0-based UTF-8 byte offset. Ranges expand to complete code points. */
  offset?: number;
  /** Number of UTF-8 bytes to read. Ranges expand at most one code point at each boundary. */
  length?: number;
  /** Text to find per line; an array matches lines containing any of its terms. */
  query?: string | string[];
  /** Treat each query term as a JavaScript RegExp; scans the first 512 KB. */
  regex?: boolean;
  /** Case-insensitive query matching. */
  ignoreCase?: boolean;
  /** Dot/bracket JSON path, for example `$.results[0].name`. */
  jsonPath?: string;
  /** Fabric section name; offset/length then page within that section. */
  section?: string;
  /** Lines of context around each query match. */
  contextLines?: number;
  /** Maximum matching source lines per page, while counting every match. */
  maxMatches?: number;
  /** Opaque continuation from nextCursor; tied to this handle and query options. */
  cursor?: string;
  /** Internal serialized-result budget for query paging. */
  maxBytes?: number;
}

export interface ReadResult {
  /** Transport status, independent of the stored payload text. */
  ok: boolean;
  id: string;
  totalBytes: number;
  totalTokens: number;
  /** Stored payload type; retained on ranges and JSON-path selections. */
  contentType?: PreviewContentType;
  /** Selected JSON path when this is a structured lookup. */
  jsonPath?: string;
  /** Runtime type of the selected JSON value. */
  selectedType?: string;
  /** Selected Fabric section; offset, nextOffset and sectionBytes are relative to it. */
  section?: string;
  sectionBytes?: number;
  bytesRead: number;
  /** Actual byte offset used for a ranged read. */
  offset?: number;
  /** Copyable next byte offset when more ranged content remains. */
  nextOffset?: number;
  content: string;
  matchedLines?: number[];
  /** Total query matches when matchedLines is later metadata-capped. */
  totalMatches?: number;
  /** Continue a query with the same options and this cursor. */
  nextCursor?: string;
  /** Regex totals cover only the scanned prefix when true. */
  scanTruncated?: boolean;
  /** Lines matching each term of a multi-term query, or each word of a phrase that matched nothing. */
  termMatches?: Record<string, number>;
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
/** Regex queries scan this prefix; literal queries scan the whole payload. */
const REGEX_SCAN_BYTES = 512 * 1024;
/** Most terms in one query, and most words counted for a phrase that matched nothing. */
const MAX_QUERY_TERMS = 16;
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

function lineMatcher(term: string, regex: boolean, ignoreCase: boolean): (line: string) => boolean {
  if (regex) {
    const pattern = new RegExp(term, ignoreCase ? "i" : "");
    return (line) => pattern.test(line);
  }
  if (ignoreCase) {
    const needle = term.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
  return (line) => line.includes(term);
}

/**
 * Facts about a literal query that matched nothing, each naming the call that
 * would match: lines that differ only in case, regex syntax in a literal query,
 * and the words of a phrase that occur on separate lines. The miss itself is
 * still reported first, so a true negative stays a negative.
 */
function queryMissHints(lines: string[], terms: string[], regex: boolean, ignoreCase: boolean): { text: string; termMatches?: Record<string, number> } {
  if (regex) return { text: "" };
  const linesWith = (term: string, fold: boolean): number => {
    const match = lineMatcher(term, false, fold);
    return lines.reduce((count, line) => count + (match(line) ? 1 : 0), 0);
  };
  const hints: string[] = [];
  if (!ignoreCase) {
    const fold = terms.map((term) => lineMatcher(term, false, true));
    const folded = lines.filter((line) => fold.some((match) => match(line))).length;
    if (folded > 0) hints.push(`${folded} line(s) match ignoring case; add ignoreCase: true.`);
  }
  if (terms.some((term) => /\||\.\*|\.\+|\\[dwsb]|^\^|\$$/.test(term))) {
    hints.push("The query contains regex syntax; add regex: true to match it as a pattern.");
  }
  const words = terms.length === 1 ? [...new Set(terms[0].split(/\s+/).filter(Boolean))].slice(0, MAX_QUERY_TERMS) : [];
  if (words.length < 2) return { text: hints.length ? ` ${hints.join(" ")}` : "" };
  const termMatches = Object.fromEntries(words.map((word) => [word, linesWith(word, ignoreCase)]));
  const found = words.filter((word) => termMatches[word] > 0);
  const counts = words.map((word) => `${JSON.stringify(word)} ${termMatches[word]}`).join(", ");
  hints.push(found.length > 1
    ? `Its words match separately: ${counts} line(s); query: ${JSON.stringify(found)} matches lines with any of them.`
    : found.length === 1
      ? `Its words match separately: ${counts} line(s); query: ${JSON.stringify(found[0])} matches those lines.`
      : "None of its words occur either.");
  return { text: ` ${hints.join(" ")}`, termMatches };
}

function isContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
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

  /** Write a payload, deduplicating identical content by hash. */
  write(
    key: string,
    source: string,
    data: string,
    writeOptions: StoreWriteOptions = {},
  ): StoreHandle {
    return this.writeIf(key, source, data, () => true, writeOptions)!;
  }

  /** Decide with the exact handle before writing, refreshing, or evicting anything. */
  writeIf(
    key: string,
    source: string,
    data: string,
    admit: (handle: StoreHandle) => boolean,
    writeOptions: StoreWriteOptions = {},
  ): StoreHandle | undefined {
    const bytes = Buffer.byteLength(data, "utf8");
    const contentHash = this.hash(data);

    return this.withLock(() => {
      let entries = this.loadAll();
      const now = new Date().toISOString();
      const existingByHash = entries.find((entry) => entry.contentHash === contentHash && !this.isExpired(entry) && this.hasUsableBlob(entry));
      const entry: StoreMetadata = existingByHash ?? {
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

      const handle = this.handleResult(entry, data);
      if (!admit(handle)) return undefined;
      entries = this.cleanEntries(entries);
      if (existingByHash) {
        existingByHash.lastAccessed = now;
        existingByHash.updatedAt = now;
      } else {
        this.writeBlob(entry.blobPath, data);
        entries.push(entry);
      }
      this.writeIndex(entries);
      this.gcLocked(entry.id);
      return handle;
    });
  }

  /** Read a UTF-8 byte range, matching lines, a Fabric section, or a focused JSON path. */
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

      if (opts.section !== undefined) {
        const data = readFileSync(blob, "utf8");
        return this.readSection(entry, data, opts);
      }

      if (opts.query !== undefined) return this.readQuery(entry, blob, opts);

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

  has(id: string): boolean {
    const entry = this.loadAll().find((candidate) => candidate.id === id);
    return Boolean(entry && !this.isExpired(entry) && this.hasUsableBlob(entry));
  }

  private ensureLayout(): void {
    const initialized = layoutInitCache.has(this.dir);
    if (!initialized || !existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: STORE_DIR_MODE });
    if (!initialized || !existsSync(this.blobsDir)) mkdirSync(this.blobsDir, { recursive: true, mode: STORE_DIR_MODE });
    if (!initialized) {
      try { chmodSync(this.dir, STORE_DIR_MODE); } catch { /* best effort */ }
      try { chmodSync(this.blobsDir, STORE_DIR_MODE); } catch { /* best effort */ }
      this.removeLegacyEntries();
      layoutInitCache.add(this.dir);
    }

    if (!existsSync(this.indexFile)) {
      this.withLock(() => {
        if (existsSync(this.indexFile)) return;
        this.writeIndex([]);
      });
    }
  }

  /**
   * Delete <id>.json entries from the pre-0.4 layout. Versions 0.4 to 0.6
   * copied them into blobs but never deleted the originals, which then sat
   * outside the TTL, the size cap and cleanup. A store still in that layout
   * dates from before 0.4.0, so its entries are dropped rather than migrated.
   * Only files that parse as a legacy entry named after its own id are removed.
   */
  private removeLegacyEntries(): void {
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const file of files) {
      if (!file.endsWith(".json") || file === "index.json") continue;
      const path = join(this.dir, file);
      try {
        if (!lstatSync(path).isFile()) continue;
        const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreEntry> | null;
        if (typeof raw?.id === "string" && typeof raw.key === "string" && typeof raw.data === "string" && `${raw.id}.json` === file) {
          unlinkSync(path);
        }
      } catch {
        // Leave unreadable or unrecognized files alone.
      }
    }
  }

  private withLock<T>(fn: () => T): T {
    if (!layoutInitCache.has(this.dir) || !existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true, mode: STORE_DIR_MODE });
      try { chmodSync(this.dir, STORE_DIR_MODE); } catch { /* best effort */ }
      layoutInitCache.add(this.dir);
    }
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

  private baseResult(entry: StoreMetadata): Pick<ReadResult, "ok" | "id" | "totalBytes" | "totalTokens" | "contentType"> {
    return {
      ok: true,
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
        ...(requestedOffset < totalBytes ? { nextOffset: requestedOffset } : {}),
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
      ...(truncated ? { nextOffset: actualEnd } : {}),
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
        ok: false,
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
        ok: false,
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
          ok: false,
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

  private readSection(entry: StoreMetadata, data: string, opts: ReadOptions): ReadResult {
    const section = opts.section ?? "";
    const names = fabricSectionNames(data);
    const selected = names ? fabricSection(data, section) : undefined;
    if (!selected) {
      return {
        ...this.baseResult(entry),
        section,
        ok: false,
        content: names
          ? `Error: stored result "${entry.id}" has no section ${JSON.stringify(section)}; available: ${names.slice(0, 24).map((name) => JSON.stringify(name)).join(", ")}.`
          : `Error: stored result "${entry.id}" is not a Fabric sectioned result or has ambiguous section boundaries; use query or offset/length.`,
        bytesRead: 0,
        truncated: false,
      };
    }

    const bytes = Buffer.from(selected.text, "utf8");
    const sectionBytes = bytes.byteLength;
    const requestedOffset = Math.max(0, Math.min(sectionBytes, Math.floor(Number(opts.offset) || 0)));
    const requestedLength = Math.max(0, Math.floor(Number(opts.length ?? DEFAULT_PREVIEW_BYTES * 4) || 0));
    // Expand to complete code points, as ranged reads do.
    let start = requestedOffset;
    while (start > 0 && start < sectionBytes && (bytes[start] & 0xc0) === 0x80) start--;
    let end = Math.min(sectionBytes, requestedOffset + requestedLength);
    while (end < sectionBytes && (bytes[end] & 0xc0) === 0x80) end++;
    const content = bytes.subarray(start, end).toString("utf8");
    const truncated = end < sectionBytes;
    return {
      ...this.baseResult(entry),
      section,
      sectionBytes,
      bytesRead: end - start,
      offset: start,
      ...(truncated ? { nextOffset: end } : {}),
      content: truncated
        ? content + `\n... [${sectionBytes - end} more section bytes, use ctx_read with section and offset=${end} to continue]`
        : content,
      truncated,
    };
  }

  private readQuery(entry: StoreMetadata, blob: string, opts: ReadOptions): ReadResult {
    const terms = [...new Set((Array.isArray(opts.query) ? opts.query : [opts.query]).map((term) => String(term ?? "")))]
      .filter(Boolean).slice(0, MAX_QUERY_TERMS);
    if (terms.length === 0) return this.errorResult(entry.id, "Error: query needs at least one non-empty term.");
    const regex = opts.regex === true;
    const ignoreCase = opts.ignoreCase === true;
    let matchers: Array<(line: string) => boolean>;
    try { matchers = terms.map((term) => lineMatcher(term, regex, ignoreCase)); }
    catch { return this.errorResult(entry.id, `Error: invalid regex in query ${JSON.stringify(opts.query)}.`); }
    const scanPrefix = regex && entry.bytes > REGEX_SCAN_BYTES;
    const data = scanPrefix
      ? this.readBlobBytes(blob, 0, this.alignUtf8Start(blob, REGEX_SCAN_BYTES)).toString("utf8")
      : readFileSync(blob, "utf8");
    const lines = data.split("\n");
    const contextLines = Math.max(0, Math.min(50, Math.floor(opts.contextLines ?? DEFAULT_CONTEXT_LINES)));
    const maxMatches = Math.max(1, Math.floor(opts.maxMatches ?? Number.MAX_SAFE_INTEGER));
    const fingerprint = createHash("sha256").update(JSON.stringify([entry.id, entry.contentHash, terms, regex, ignoreCase, contextLines])).digest("hex").slice(0, 16);
    const cursorFor = (line: number, byte = 0): string => Buffer.from(JSON.stringify([1, fingerprint, line, byte])).toString("base64url");
    let firstLine = 0, firstByte = 0;
    if (opts.cursor !== undefined) {
      try {
        if (typeof opts.cursor !== "string" || opts.cursor.length > 256) throw new Error();
        const [version, signature, line, byte] = JSON.parse(Buffer.from(opts.cursor, "base64url").toString("utf8"));
        if (version !== 1 || signature !== fingerprint || !Number.isInteger(line) || line < 0 || line >= lines.length ||
          !Number.isInteger(byte) || byte < 0 || byte > Buffer.byteLength(lines[line], "utf8") ||
          (byte > 0 && (Buffer.from(lines[line])[byte] & 0xc0) === 0x80)) throw new Error();
        firstLine = line; firstByte = byte;
      } catch { return this.errorResult(entry.id, "Error: invalid query cursor; use nextCursor with the same handle and query options."); }
    }
    const perTerm = terms.map(() => 0);
    const matches: number[] = [];
    let totalMatches = 0;
    // Count the entire scan, but retain only the page's nearby hits plus a
    // lookahead. Dense queries must not allocate a second full-payload index.
    const collectLimit = maxMatches + contextLines * 2 + 1;
    for (let i = 0; i < lines.length; i++) {
      let hit = false;
      for (let t = 0; t < matchers.length; t++) {
        if (!matchers[t](lines[i])) continue;
        perTerm[t]++; hit = true;
      }
      if (hit) {
        totalMatches++;
        if (i + contextLines >= firstLine && matches.length < collectLimit) matches.push(i);
      }
    }
    const label = terms.length === 1 ? JSON.stringify(terms[0]) : `any of ${terms.map((term) => JSON.stringify(term)).join(", ")}`;
    let termMatches = terms.length > 1 ? Object.fromEntries(terms.map((term, t) => [term, perTerm[t]])) : undefined;
    const scannedNote = scanPrefix ? `\n... [regex scanned the first ${REGEX_SCAN_BYTES} of ${entry.bytes} bytes; use offset reads for the rest]` : "";
    if (!totalMatches) {
      const miss = queryMissHints(lines, terms, regex, ignoreCase);
      termMatches = miss.termMatches ?? termMatches;
      const scanned = scanPrefix ? `first ${REGEX_SCAN_BYTES} of ${entry.bytes} bytes scanned` : `${entry.bytes} bytes`;
      const content = `No matches for ${label} in ${entry.key} (${scanned}).${miss.text}`;
      return { ...this.baseResult(entry), content, bytesRead: Buffer.byteLength(content), matchedLines: [], totalMatches,
        ...(termMatches ? { termMatches } : {}), ...(scanPrefix ? { scanTruncated: true } : {}), truncated: scanPrefix };
    }
    // Union the page's context intervals first: each physical source line appears once,
    // even when every adjacent line matches. Cursors advance through that union.
    const windows: Array<[number, number]> = [];
    for (const line of matches) {
      const start = Math.max(0, line - contextLines), end = Math.min(lines.length - 1, line + contextLines);
      const previous = windows[windows.length - 1];
      if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
      else windows.push([start, end]);
    }
    const hitLines = new Set(matches);
    const counts = termMatches ? ` (${terms.map((term, t) => `${JSON.stringify(term)}: ${perTerm[t]}`).join(", ")})` : "";
    const header = `${totalMatches} match(es) for ${label}${counts}:\n`;
    const budget = opts.maxBytes ?? Infinity;
    const sampleSize = Number.isFinite(budget) ? Math.max(1, Math.min(64, Math.floor(budget / 32))) : Infinity;
    const makeResult = (rows: string[], pageMatches: number[], nextCursor?: string): ReadResult => {
      const content = header + rows.join("\n") +
        (nextCursor ? `\n... [more matches/context; continue with cursor ${JSON.stringify(nextCursor)}]` : "") + scannedNote;
      return { ...this.baseResult(entry), content, bytesRead: Buffer.byteLength(content),
        matchedLines: pageMatches.slice(0, sampleSize), totalMatches,
        ...(termMatches ? { termMatches } : {}), ...(nextCursor ? { nextCursor } : {}),
        ...(scanPrefix ? { scanTruncated: true } : {}), truncated: !!nextCursor || scanPrefix };
    };
    const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
    const reserve = Number.isFinite(budget) ? size(makeResult([], Array(Math.min(maxMatches, sampleSize)).fill(lines.length), cursorFor(lines.length, entry.bytes))) + 32 : 0;
    let rowBytes = 0, nextCursor: string | undefined;
    const rows: string[] = [], pageMatches: number[] = [];
    outer: for (const [start, end] of windows) {
      for (let line = Math.max(start, firstLine); line <= end; line++) {
        const byte = line === firstLine ? firstByte : 0;
        const hit = hitLines.has(line);
        if (hit && pageMatches.length >= maxMatches) { nextCursor = cursorFor(line, byte); break outer; }
        const source = Buffer.from(lines[line]);
        const prefix = `${hit ? ">>" : "  "} ${line + 1}: ${byte ? `[continued at byte ${byte}] ` : ""}`;
        const row = prefix + source.subarray(byte).toString("utf8");
        const encoded = size(row) - 2 + (rows.length ? 2 : 0);
        if (rowBytes + encoded + reserve > budget) {
          if (rows.length) { nextCursor = cursorFor(line, byte); break outer; }
          // The conservative reserve may exceed a tiny page even though one
          // complete row fits. In particular an empty context line has no byte
          // prefix for the binary search below, but must still make progress.
          const afterLine = line < end || windows.some(([s]) => s > end) ? cursorFor(line + 1) : undefined;
          const whole = makeResult([row], hit ? [line + 1] : [], afterLine);
          if (size(whole) <= budget) return whole;
          // A single long line can exceed a page. Page its UTF-8 bytes without
          // advancing past unseen text, rather than slicing away later matches.
          let low = byte + 1, high = source.length, best: ReadResult | undefined;
          while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            let stop = middle;
            while (stop < source.length && (source[stop] & 0xc0) === 0x80) stop++;
            const next = stop < source.length ? cursorFor(line, stop) : afterLine;
            const candidate = makeResult([prefix + source.subarray(byte, stop).toString("utf8")], hit ? [line + 1] : [], next);
            if (stop > byte && size(candidate) <= budget) { best = candidate; low = middle + 1; }
            else high = middle - 1;
          }
          return best ?? this.errorResult(entry.id, "Error: query metadata exceeds the read budget; narrow the query.");
        }
        rows.push(row); rowBytes += encoded;
        if (hit) pageMatches.push(line + 1);
      }
    }
    return makeResult(rows, pageMatches, nextCursor);
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

  private isExpired(entry: StoreMetadata, options = this.options): boolean {
    if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) return true;
    // ttlMs=0 explicitly means no age-based expiry.
    return options.ttlMs !== undefined && options.ttlMs > 0 && Date.parse(entry.created) + options.ttlMs <= Date.now();
  }

  private handleResult(entry: StoreMetadata, data: string): StoreHandle {
    const preview = redactSecrets(structuralPreview(data, DEFAULT_PREVIEW_BYTES, entry.contentType));
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
    return { ok: false, id, totalBytes: 0, totalTokens: 0, bytesRead: 0, content: redactSecrets(content), truncated: false };
  }

  private hash(data: string): string {
    return createHash("sha256").update(data, "utf8").digest("hex");
  }

  private makeId(key: string, contentHash: string): string {
    const slug = key.replace(/[^a-z0-9]/gi, "-").slice(0, 24) || "ctx";
    storeIdCounter = (storeIdCounter + 1) % 1296;
    const suffix = `${Date.now().toString(36).slice(-4)}${storeIdCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(-6);
    return `${slug}-${contentHash.slice(0, 8)}-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
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
