/**
 * Lightweight context telemetry.
 *
 * New events contain sizes, strategies, tool names, and handle fingerprints;
 * they never contain prompts, source text, command arguments, or tool payloads.
 * Older event files can contain raw handle labels and are normalized on read.
 *
 * The accounting domains are deliberately separate:
 *   - mainTokensPrevented: potential Main-bound tokens withheld by CE;
 *   - mainTokensInjected: tokens actually shown to Main;
 *   - storeTokensWritten: payload tokens persisted for later retrieval.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { constants as osConstants } from "node:os";

/** Note on a call repeated after its result was offloaded; see offloadFollowUp. */
export const REPEATED_OFFLOADED_CALL_NOTE = "repeated a call whose result is already offloaded";

/** Whether the model's next call after a boundary offload read that handle; see offloadFollowUp.nextCall. */
export type NextCallFollowUp = "read" | "other";

function isNextCallFollowUp(value: unknown): value is NextCallFollowUp {
  return value === "read" || value === "other";
}

export type ContextStrategy = "PASS" | "WRITE" | "SELECT" | "COMPRESS";

/** How a ctx_read selected from its handle; the query text is never recorded. */
export interface ReadTelemetry {
  mode: "range" | "query" | "section" | "jsonPath";
  /** Start of a range read. */
  offset?: number;
  /** Matching lines of a query. */
  matches?: number;
}

const READ_MODES: ReadonlyArray<ReadTelemetry["mode"]> = ["range", "query", "section", "jsonPath"];
const SAFE_ERROR_CODES = new Set(Object.keys(osConstants.errno));

function normalizeRead(value: unknown): ReadTelemetry | undefined {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  if (!raw || !READ_MODES.includes(raw.mode as ReadTelemetry["mode"])) return undefined;
  return {
    mode: raw.mode as ReadTelemetry["mode"],
    ...(typeof raw.offset === "number" && Number.isFinite(raw.offset) ? { offset: raw.offset } : {}),
    ...(typeof raw.matches === "number" && Number.isFinite(raw.matches) ? { matches: raw.matches } : {}),
  };
}
function fingerprintHandle(value: string): string {
  const handle = value.slice(0, 120);
  if (/^sha256:[a-f0-9]{64}$/.test(handle)) return handle;
  return `sha256:${createHash("sha256").update(handle, "utf8").digest("hex")}`;
}
function normalizeHandles(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const handles = [...new Set(value.filter((h): h is string => typeof h === "string" && h.length > 0).map(fingerprintHandle))].slice(0, 64);
  return handles.length ? handles : undefined;
}
export type TelemetryScope = "session" | "lifetime";

export interface ContextEvent {
  version: 3;
  timestamp: string;
  sessionId: string;
  strategy: ContextStrategy;
  tool: string;
  /** Legacy payload-size fields retained for compatibility. */
  sourceBytes: number;
  visibleBytes: number;
  sourceTokens: number;
  visibleTokens: number;
  /** Legacy alias for mainTokensPrevented. */
  savedTokens: number;
  mainTokensPrevented: number;
  mainTokensInjected: number;
  storeTokensWritten: number;
  provider?: string;
  handle?: string;
  note?: string;
  read?: ReadTelemetry;
  /** Handles consumed inside this tool's program; never their contents. */
  derivedFrom?: string[];
  /** Set on the event that closes a boundary offload: whether the next call read its handle. */
  followUp?: NextCallFollowUp;
}

export interface StrategySummary {
  events: number;
  readbackTokens: number;
  netTokensSaved: number;
  sourceTokens: number;
  visibleTokens: number;
  savedTokens: number;
  mainTokensPrevented: number;
  mainTokensInjected: number;
  storeTokensWritten: number;
}

export interface ContextSummary {
  scope?: TelemetryScope;
  sessionId?: string;
  events: number;
  /** Legacy aggregate fields. */
  sourceTokens: number;
  visibleTokens: number;
  savedTokens: number;
  /** Model-visible handle retrievals and handle-derived final outputs. */
  readbackTokens: number;
  /** Gross prevention minus readback exposure, without crediting derived offloads again. */
  netTokensSaved: number;
  /** Explicit accounting domains. */
  mainTokensPrevented: number;
  mainTokensInjected: number;
  storeTokensWritten: number;
  /** Compatibility alias for Main-context reduction. */
  reductionRatio: number;
  mainContextReductionRatio: number;
  byStrategy: Record<string, StrategySummary>;
  /**
   * Whether boundary offloads were used: distinct handles, handles later read,
   * repeated source calls, ctx_read calls by mode, and whether the model's
   * next call read the handle. rangeFromStart counts range reads at offset 0,
   * which mostly re-read a preview's head.
   */
  offloadFollowUp: {
    handles: number;
    handlesRead: number;
    repeatedCalls: number;
    reads: { inProgram: number; range: number; rangeFromStart: number; query: number; queryMisses: number; section: number; jsonPath: number };
    nextCall: { read: number; other: number };
  };
  largest?: ContextEvent;
}

export interface RecentContextEvent {
  timestamp: string;
  strategy: ContextStrategy;
  tool: string;
  sourceTokens: number;
  visibleTokens: number;
  savedTokens: number;
  mainTokensPrevented: number;
  mainTokensInjected: number;
  storeTokensWritten: number;
  note?: string;
  handle?: string;
}

function estimateTokens(charsOrBytes: number): number {
  return Math.ceil(charsOrBytes / 4);
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isStrategy(value: unknown): value is ContextStrategy {
  return typeof value === "string" && ["PASS", "WRITE", "SELECT", "COMPRESS"].includes(value);
}

export class ContextTelemetry {
  /** Until session_start binds the host session, events belong to this runtime. */
  private activeSessionId = `${Date.now().toString(36)}-${process.pid.toString(36)}-${randomUUID()}`;
  private readonly maxEvents = 5000;

  get sessionId(): string {
    return this.activeSessionId;
  }

  /** Bind this runtime to the host Pi session once session_start provides it. */
  setSessionId(sessionId: unknown): void {
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) return;
    this.activeSessionId = sessionId.trim().slice(0, 240);
  }

  record(
    workspaceRoot: string,
    event: {
      strategy: ContextStrategy;
      tool: string;
      sourceBytes?: number;
      visibleBytes?: number;
      sourceTokens?: number;
      visibleTokens?: number;
      mainTokensPrevented?: number;
      mainTokensInjected?: number;
      storeTokensWritten?: number;
      provider?: string;
      handle?: string;
      note?: string;
      read?: ReadTelemetry;
      derivedFrom?: string[];
      followUp?: NextCallFollowUp;
    },
  ): void {
    try {
      const directory = resolve(workspaceRoot, ".pi/context-store");
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
      const sourceBytes = safeNumber(event.sourceBytes);
      const visibleBytes = safeNumber(event.visibleBytes);
      const sourceTokens = event.sourceTokens === undefined ? estimateTokens(sourceBytes) : safeNumber(event.sourceTokens);
      const visibleTokens = event.visibleTokens === undefined ? estimateTokens(visibleBytes) : safeNumber(event.visibleTokens);
      const mainTokensInjected = event.mainTokensInjected === undefined ? visibleTokens : safeNumber(event.mainTokensInjected);
      const mainTokensPrevented = event.mainTokensPrevented === undefined
        ? Math.max(0, sourceTokens - visibleTokens)
        : safeNumber(event.mainTokensPrevented);
      const item: ContextEvent = {
        version: 3,
        timestamp: new Date().toISOString(),
        sessionId: this.sessionId,
        strategy: event.strategy,
        tool: event.tool.slice(0, 120),
        sourceBytes,
        visibleBytes,
        sourceTokens,
        visibleTokens,
        savedTokens: mainTokensPrevented,
        mainTokensPrevented,
        mainTokensInjected,
        storeTokensWritten: safeNumber(event.storeTokensWritten),
        ...(event.provider ? { provider: event.provider.slice(0, 80) } : {}),
        ...(event.handle ? { handle: fingerprintHandle(event.handle) } : {}),
        ...(event.note ? { note: event.note.replace(/[\r\n]+/g, " ").slice(0, 240) } : {}),
        ...(normalizeRead(event.read) ? { read: normalizeRead(event.read) } : {}),
        ...(normalizeHandles(event.derivedFrom) ? { derivedFrom: normalizeHandles(event.derivedFrom) } : {}),
        ...(isNextCallFollowUp(event.followUp) ? { followUp: event.followUp } : {}),
      };
      const path = this.path(workspaceRoot);
      appendFileSync(path, JSON.stringify(item) + "\n", { encoding: "utf8", mode: 0o600 });
      this.trimIfNeeded(path);
    } catch {
      // Telemetry must never interfere with tool execution.
    }
  }

  /**
   * Storage-failure note: records that a store write/read failed without
   * hiding the already-executed result. Never throws. Callers (tool_result
   * offload, ctx_offload) invoke this in their catch block so failures are
   * visible in session/lifetime summaries instead of silent.
   */
  recordStorageFailure(workspaceRoot: string, tool: string, detail?: unknown): void {
    try {
      // Error messages can contain paths or user input; record only a safe code.
      const rawCode = detail && typeof detail === "object" ? (detail as { code?: unknown }).code : undefined;
      const message = typeof rawCode === "string" && SAFE_ERROR_CODES.has(rawCode) ? rawCode : "unknown";
      this.record(workspaceRoot, {
        strategy: "WRITE",
        tool,
        sourceBytes: 0,
        visibleBytes: 0,
        note: `storage-failure: ${message}`.slice(0, 240),
      });
    } catch {
      // Telemetry must never interfere with tool execution.
    }
  }

  /** Backward-compatible session/lifetime summary API. */
  summary(workspaceRoot: string, allSessions = false): ContextSummary {
    return this.summarizeScope(workspaceRoot, allSessions ? "lifetime" : "session");
  }

  private summarizeScope(workspaceRoot: string, scope: TelemetryScope): ContextSummary {
    const history = this.read(workspaceRoot);
    const boundaryHandles = new Set<string>();
    const readbacks = new Set<ContextEvent>();
    // Resolve provenance chronologically before selecting a session: a read in
    // this session can consume a handle introduced in a previous one.
    for (const event of history) {
      if (event.derivedFrom?.some(handle => boundaryHandles.has(handle)) ||
        ((event.tool === "ctx_read" || event.tool === "ctx_summarize") && !!event.handle && boundaryHandles.has(event.handle))) readbacks.add(event);
      if (event.handle && (event.strategy === "WRITE" || event.strategy === "COMPRESS") && !event.tool.startsWith("ctx_")) boundaryHandles.add(event.handle);
    }
    const events = history.filter((event) => scope === "lifetime" || event.sessionId === this.sessionId);
    const byStrategy: Record<string, StrategySummary> = {};
    let sourceTokens = 0;
    let visibleTokens = 0;
    let savedTokens = 0;
    let mainTokensPrevented = 0;
    let mainTokensInjected = 0;
    let storeTokensWritten = 0;
    let readbackTokens = 0;
    let netTokensSaved = 0;
    let largest: ContextEvent | undefined;

    for (const event of events) {
      const isReadback = readbacks.has(event);
      const readback = isReadback ? event.mainTokensInjected : 0;
      const net = isReadback ? -readback : event.mainTokensPrevented;
      readbackTokens += readback; netTokensSaved += net;
      sourceTokens += event.sourceTokens;
      visibleTokens += event.visibleTokens;
      savedTokens += event.savedTokens;
      mainTokensPrevented += event.mainTokensPrevented;
      mainTokensInjected += event.mainTokensInjected;
      storeTokensWritten += event.storeTokensWritten;
      const bucket = byStrategy[event.strategy] ??= {
        events: 0, readbackTokens: 0, netTokensSaved: 0,
        sourceTokens: 0,
        visibleTokens: 0,
        savedTokens: 0,
        mainTokensPrevented: 0,
        mainTokensInjected: 0,
        storeTokensWritten: 0,
      };
      bucket.events++;
      bucket.readbackTokens += readback; bucket.netTokensSaved += net;
      bucket.sourceTokens += event.sourceTokens;
      bucket.visibleTokens += event.visibleTokens;
      bucket.savedTokens += event.savedTokens;
      bucket.mainTokensPrevented += event.mainTokensPrevented;
      bucket.mainTokensInjected += event.mainTokensInjected;
      bucket.storeTokensWritten += event.storeTokensWritten;
      if (!largest || event.mainTokensPrevented > largest.mainTokensPrevented) largest = event;
    }

    // ctx_* helpers carry the handle they were given, not a new boundary offload.
    const offloadHandles = new Set(events.filter(event => event.handle && (event.strategy === "WRITE" || event.strategy === "COMPRESS") && !event.tool.startsWith("ctx_")).map(event => event.handle!));
    const readHandles = new Set(events.filter(event => event.handle && (event.tool === "ctx_read" || event.tool === "ctx_summarize")).map(event => event.handle!));
    const reads = events.filter(event => event.tool === "ctx_read" && event.read).map(event => ({ ...event.read!, inProgram: event.note === "internal CE helper result" }));
    const offloadFollowUp = {
      handles: offloadHandles.size,
      handlesRead: [...offloadHandles].filter(handle => readHandles.has(handle)).length,
      repeatedCalls: events.filter(event => event.note === REPEATED_OFFLOADED_CALL_NOTE).length,
      reads: {
        inProgram: reads.filter(read => read.inProgram).length,
        range: reads.filter(read => read.mode === "range").length,
        rangeFromStart: reads.filter(read => read.mode === "range" && read.offset === 0).length,
        query: reads.filter(read => read.mode === "query").length,
        queryMisses: reads.filter(read => read.mode === "query" && read.matches === 0).length,
        section: reads.filter(read => read.mode === "section").length,
        jsonPath: reads.filter(read => read.mode === "jsonPath").length,
      },
      nextCall: {
        read: events.filter(event => event.followUp === "read").length,
        other: events.filter(event => event.followUp === "other").length,
      },
    };
    const potentialMainTokens = mainTokensPrevented + mainTokensInjected;
    const mainContextReductionRatio = potentialMainTokens > 0 ? mainTokensPrevented / potentialMainTokens : 0;
    return {
      scope,
      ...(scope !== "lifetime" ? { sessionId: this.sessionId } : {}),
      events: events.length,
      readbackTokens, netTokensSaved,
      sourceTokens,
      visibleTokens,
      savedTokens,
      mainTokensPrevented,
      mainTokensInjected,
      storeTokensWritten,
      reductionRatio: mainContextReductionRatio,
      mainContextReductionRatio,
      byStrategy,
      offloadFollowUp,
      ...(largest ? { largest } : {}),
    };
  }

  recent(workspaceRoot: string, limit = 20, allSessions = false): RecentContextEvent[] {
    return this.read(workspaceRoot)
      .filter((event) => allSessions || event.sessionId === this.sessionId)
      .slice(-Math.max(1, Math.min(limit, 100)))
      .map((event) => ({
        timestamp: event.timestamp,
        strategy: event.strategy,
        tool: event.tool,
        sourceTokens: event.sourceTokens,
        visibleTokens: event.visibleTokens,
        savedTokens: event.savedTokens,
        mainTokensPrevented: event.mainTokensPrevented,
        mainTokensInjected: event.mainTokensInjected,
        storeTokensWritten: event.storeTokensWritten,
        ...(event.note ? { note: event.note } : {}),
        ...(event.handle ? { handle: event.handle } : {}),
      }));
  }

  clear(workspaceRoot: string): void {
    try {
      const path = this.path(workspaceRoot);
      if (existsSync(path)) writeFileSync(path, "", "utf8");
    } catch {
      // Best effort only.
    }
  }

  private path(workspaceRoot: string): string {
    return resolve(workspaceRoot, ".pi/context-store/context-events.jsonl");
  }

  private read(workspaceRoot: string): ContextEvent[] {
    try {
      const path = this.path(workspaceRoot);
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .slice(-this.maxEvents)
        .map((line) => {
          try { return this.normalize(JSON.parse(line) as Record<string, unknown>); }
          catch { return undefined; }
        })
        .filter((event): event is ContextEvent => event !== undefined);
    } catch {
      return [];
    }
  }

  private normalize(raw: Record<string, unknown>): ContextEvent | undefined {
    if (!raw || typeof raw.sessionId !== "string" || !isStrategy(raw.strategy)) return undefined;
    const sourceBytes = safeNumber(raw.sourceBytes);
    const visibleBytes = safeNumber(raw.visibleBytes);
    const sourceTokens = raw.sourceTokens === undefined ? estimateTokens(sourceBytes) : safeNumber(raw.sourceTokens);
    const visibleTokens = raw.visibleTokens === undefined ? estimateTokens(visibleBytes) : safeNumber(raw.visibleTokens);
    const legacySaved = raw.savedTokens === undefined ? Math.max(0, sourceTokens - visibleTokens) : safeNumber(raw.savedTokens);
    const mainTokensPrevented = raw.mainTokensPrevented === undefined ? legacySaved : safeNumber(raw.mainTokensPrevented);
    return {
      version: 3,
      timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date(0).toISOString(),
      sessionId: raw.sessionId,
      strategy: raw.strategy,
      tool: typeof raw.tool === "string" ? raw.tool.slice(0, 120) : "unknown",
      sourceBytes,
      visibleBytes,
      sourceTokens,
      visibleTokens,
      savedTokens: mainTokensPrevented,
      mainTokensPrevented,
      mainTokensInjected: raw.mainTokensInjected === undefined ? visibleTokens : safeNumber(raw.mainTokensInjected),
      storeTokensWritten: safeNumber(raw.storeTokensWritten),
      ...(typeof raw.provider === "string" ? { provider: raw.provider } : {}),
      ...(typeof raw.handle === "string" && raw.handle ? { handle: fingerprintHandle(raw.handle) } : {}),
      ...(typeof raw.note === "string" ? { note: raw.note } : {}),
      ...(normalizeRead(raw.read) ? { read: normalizeRead(raw.read) } : {}),
      ...(normalizeHandles(raw.derivedFrom) ? { derivedFrom: normalizeHandles(raw.derivedFrom) } : {}),
      ...(isNextCallFollowUp(raw.followUp) ? { followUp: raw.followUp } : {}),
    };
  }

  private trimIfNeeded(path: string): void {
    try {
      const raw = readFileSync(path, "utf8");
      if (raw.length < 2_000_000) return;
      const lines = raw.split("\n").filter(Boolean).slice(-this.maxEvents);
      writeFileSync(path, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf8");
    } catch {
      // Best effort only.
    }
  }
}
