/**
 * Lightweight context telemetry.
 *
 * Events intentionally contain sizes, strategies, tool names, and handles only;
 * they never contain prompts, source text, command arguments, or tool payloads.
 *
 * The accounting domains are deliberately separate:
 *   - internalTokensProcessed: work kept inside a provider/runtime;
 *   - mainTokensPrevented: potential Main-bound tokens withheld by CE;
 *   - mainTokensInjected: tokens actually shown to Main;
 *   - storeTokensWritten: payload tokens persisted for later retrieval.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type ContextStrategy = "PASS" | "WARN" | "BLOCK" | "WRITE" | "SELECT" | "COMPRESS" | "ISOLATE";

export interface ContextEvent {
  version: 2;
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
  internalTokensProcessed: number;
  mainTokensPrevented: number;
  mainTokensInjected: number;
  storeTokensWritten: number;
  provider?: string;
  handle?: string;
  note?: string;
}

export interface StrategySummary {
  events: number;
  sourceTokens: number;
  visibleTokens: number;
  savedTokens: number;
  internalTokensProcessed: number;
  mainTokensPrevented: number;
  mainTokensInjected: number;
  storeTokensWritten: number;
}

export interface ContextSummary {
  sessionId?: string;
  events: number;
  /** Legacy aggregate fields. */
  sourceTokens: number;
  visibleTokens: number;
  savedTokens: number;
  /** Explicit accounting domains. */
  internalTokensProcessed: number;
  mainTokensPrevented: number;
  mainTokensInjected: number;
  storeTokensWritten: number;
  /** Compatibility alias for Main-context reduction. */
  reductionRatio: number;
  mainContextReductionRatio: number;
  byStrategy: Record<string, StrategySummary>;
  largest?: ContextEvent;
}

export interface RecentContextEvent {
  timestamp: string;
  strategy: ContextStrategy;
  tool: string;
  sourceTokens: number;
  visibleTokens: number;
  savedTokens: number;
  internalTokensProcessed: number;
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
  return typeof value === "string" && ["PASS", "WARN", "BLOCK", "WRITE", "SELECT", "COMPRESS", "ISOLATE"].includes(value);
}

export class ContextTelemetry {
  readonly sessionId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  private readonly maxEvents = 5000;

  record(
    workspaceRoot: string,
    event: {
      strategy: ContextStrategy;
      tool: string;
      sourceBytes?: number;
      visibleBytes?: number;
      sourceTokens?: number;
      visibleTokens?: number;
      internalTokensProcessed?: number;
      mainTokensPrevented?: number;
      mainTokensInjected?: number;
      storeTokensWritten?: number;
      provider?: string;
      handle?: string;
      note?: string;
    },
  ): void {
    try {
      const directory = resolve(workspaceRoot, ".pi/context-store");
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
      const sourceBytes = safeNumber(event.sourceBytes);
      const visibleBytes = safeNumber(event.visibleBytes);
      const sourceTokens = event.sourceTokens === undefined ? estimateTokens(sourceBytes) : safeNumber(event.sourceTokens);
      const visibleTokens = event.visibleTokens === undefined ? estimateTokens(visibleBytes) : safeNumber(event.visibleTokens);
      const mainTokensInjected = event.mainTokensInjected === undefined ? visibleTokens : safeNumber(event.mainTokensInjected);
      const mainTokensPrevented = event.mainTokensPrevented === undefined
        ? Math.max(0, sourceTokens - visibleTokens)
        : safeNumber(event.mainTokensPrevented);
      const item: ContextEvent = {
        version: 2,
        timestamp: new Date().toISOString(),
        sessionId: this.sessionId,
        strategy: event.strategy,
        tool: event.tool.slice(0, 120),
        sourceBytes,
        visibleBytes,
        sourceTokens,
        visibleTokens,
        savedTokens: mainTokensPrevented,
        internalTokensProcessed: safeNumber(event.internalTokensProcessed),
        mainTokensPrevented,
        mainTokensInjected,
        storeTokensWritten: safeNumber(event.storeTokensWritten),
        ...(event.provider ? { provider: event.provider.slice(0, 80) } : {}),
        ...(event.handle ? { handle: event.handle.slice(0, 120) } : {}),
        ...(event.note ? { note: event.note.replace(/[\r\n]+/g, " ").slice(0, 240) } : {}),
      };
      const path = this.path(workspaceRoot);
      appendFileSync(path, JSON.stringify(item) + "\n", "utf8");
      this.trimIfNeeded(path);
    } catch {
      // Telemetry must never interfere with tool execution.
    }
  }

  summary(workspaceRoot: string, allSessions = false): ContextSummary {
    const events = this.read(workspaceRoot).filter((event) => allSessions || event.sessionId === this.sessionId);
    const byStrategy: Record<string, StrategySummary> = {};
    let sourceTokens = 0;
    let visibleTokens = 0;
    let savedTokens = 0;
    let internalTokensProcessed = 0;
    let mainTokensPrevented = 0;
    let mainTokensInjected = 0;
    let storeTokensWritten = 0;
    let largest: ContextEvent | undefined;

    for (const event of events) {
      sourceTokens += event.sourceTokens;
      visibleTokens += event.visibleTokens;
      savedTokens += event.savedTokens;
      internalTokensProcessed += event.internalTokensProcessed;
      mainTokensPrevented += event.mainTokensPrevented;
      mainTokensInjected += event.mainTokensInjected;
      storeTokensWritten += event.storeTokensWritten;
      const bucket = byStrategy[event.strategy] ??= {
        events: 0,
        sourceTokens: 0,
        visibleTokens: 0,
        savedTokens: 0,
        internalTokensProcessed: 0,
        mainTokensPrevented: 0,
        mainTokensInjected: 0,
        storeTokensWritten: 0,
      };
      bucket.events++;
      bucket.sourceTokens += event.sourceTokens;
      bucket.visibleTokens += event.visibleTokens;
      bucket.savedTokens += event.savedTokens;
      bucket.internalTokensProcessed += event.internalTokensProcessed;
      bucket.mainTokensPrevented += event.mainTokensPrevented;
      bucket.mainTokensInjected += event.mainTokensInjected;
      bucket.storeTokensWritten += event.storeTokensWritten;
      if (!largest || event.mainTokensPrevented > largest.mainTokensPrevented) largest = event;
    }

    const potentialMainTokens = mainTokensPrevented + mainTokensInjected;
    const mainContextReductionRatio = potentialMainTokens > 0 ? mainTokensPrevented / potentialMainTokens : 0;
    return {
      ...(allSessions ? {} : { sessionId: this.sessionId }),
      events: events.length,
      sourceTokens,
      visibleTokens,
      savedTokens,
      internalTokensProcessed,
      mainTokensPrevented,
      mainTokensInjected,
      storeTokensWritten,
      reductionRatio: mainContextReductionRatio,
      mainContextReductionRatio,
      byStrategy,
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
        internalTokensProcessed: event.internalTokensProcessed,
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
      version: 2,
      timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date(0).toISOString(),
      sessionId: raw.sessionId,
      strategy: raw.strategy,
      tool: typeof raw.tool === "string" ? raw.tool.slice(0, 120) : "unknown",
      sourceBytes,
      visibleBytes,
      sourceTokens,
      visibleTokens,
      savedTokens: mainTokensPrevented,
      internalTokensProcessed: safeNumber(raw.internalTokensProcessed),
      mainTokensPrevented,
      mainTokensInjected: raw.mainTokensInjected === undefined ? visibleTokens : safeNumber(raw.mainTokensInjected),
      storeTokensWritten: safeNumber(raw.storeTokensWritten),
      ...(typeof raw.provider === "string" ? { provider: raw.provider } : {}),
      ...(typeof raw.handle === "string" ? { handle: raw.handle } : {}),
      ...(typeof raw.note === "string" ? { note: raw.note } : {}),
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
