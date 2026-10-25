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

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { mergeUsage, readUsage } from "./usage.js";

/** Note on a call repeated after its result was offloaded; see offloadFollowUp. */
export const REPEATED_OFFLOADED_CALL_NOTE = "repeated a call whose result is already offloaded";

export type ContextStrategy = "PASS" | "WARN" | "BLOCK" | "WRITE" | "SELECT" | "COMPRESS" | "ISOLATE";
export type TelemetryScope = "runtime" | "session" | "lifetime";

export interface ChildUsageFields {
  /** Actual provider-reported usage, not a byte/token estimate. */
  childUsage?: Usage;
  /** False means some or all usage was unavailable, never free work. */
  childUsageComplete?: boolean;
  /** False for Fabric captures that drop nested Usage from native session totals. */
  usageInParent?: boolean;
}

export interface ContextEvent extends ChildUsageFields {
  version: 2;
  timestamp: string;
  sessionId: string;
  /** Runtime/extension-instance identity; old event files may omit it. */
  runtimeId?: string;
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
  scope?: TelemetryScope;
  sessionId?: string;
  runtimeId?: string;
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
  childCalls: number;
  childUsage?: Usage;
  childUsageComplete?: boolean;
  /** Add only this usage to native parent totals to avoid double counting. */
  childUsageOutsideParent?: Usage;
  /** Whether boundary offloads were used: distinct handles, handles later read, and repeated source calls. */
  offloadFollowUp: { handles: number; handlesRead: number; repeatedCalls: number };
  largest?: ContextEvent;
}

export interface RecentContextEvent extends ChildUsageFields {
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

function childUsageFields(value: { childUsage?: unknown; childUsageComplete?: unknown; usageInParent?: unknown }): ChildUsageFields {
  if (value.childUsageComplete === undefined && value.childUsage === undefined) return {};
  const childUsage = readUsage(value.childUsage);
  return {
    ...(childUsage ? { childUsage } : {}),
    childUsageComplete: childUsage !== undefined && value.childUsageComplete === true,
    ...(typeof value.usageInParent === "boolean" ? { usageInParent: value.usageInParent } : {}),
  };
}

function isStrategy(value: unknown): value is ContextStrategy {
  return typeof value === "string" && ["PASS", "WARN", "BLOCK", "WRITE", "SELECT", "COMPRESS", "ISOLATE"].includes(value);
}

export class ContextTelemetry {
  readonly runtimeId = `${Date.now().toString(36)}-${process.pid.toString(36)}-${randomUUID()}`;
  private activeSessionId = this.runtimeId;
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
    event: ChildUsageFields & {
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
        runtimeId: this.runtimeId,
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
        ...childUsageFields(event),
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

  /**
   * Storage-failure note: records that a store write/read failed without
   * hiding the already-executed result. Never throws. Callers (tool_result
   * offload, ctx_offload) invoke this in their catch block so failures are
   * visible in session/lifetime summaries instead of silent.
   */
  recordStorageFailure(workspaceRoot: string, tool: string, detail?: unknown): void {
    try {
      const message = detail instanceof Error ? detail.message : typeof detail === "string" ? detail : "store unavailable";
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

  /** Events produced by this extension runtime only. */
  runtimeSummary(workspaceRoot: string): ContextSummary {
    return this.summarizeScope(workspaceRoot, "runtime");
  }

  private summarizeScope(workspaceRoot: string, scope: TelemetryScope): ContextSummary {
    const events = this.read(workspaceRoot).filter((event) =>
      scope === "lifetime"
        ? true
        : scope === "runtime"
          ? event.runtimeId === this.runtimeId || (!event.runtimeId && event.sessionId === this.sessionId)
          : event.sessionId === this.sessionId,
    );
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

    // ctx_* helpers carry the handle they were given, not a new boundary offload.
    const offloadHandles = new Set(events.filter(event => event.handle && (event.strategy === "WRITE" || event.strategy === "COMPRESS") && !event.tool.startsWith("ctx_")).map(event => event.handle!));
    const readHandles = new Set(events.filter(event => event.handle && (event.tool === "ctx_read" || event.tool === "ctx_summarize")).map(event => event.handle!));
    const offloadFollowUp = {
      handles: offloadHandles.size,
      handlesRead: [...offloadHandles].filter(handle => readHandles.has(handle)).length,
      repeatedCalls: events.filter(event => event.note === REPEATED_OFFLOADED_CALL_NOTE).length,
    };
    const childEvents = events.filter(event => event.childUsageComplete !== undefined);
    const childUsage = mergeUsage(...childEvents.map(event => event.childUsage));
    const childUsageOutsideParent = mergeUsage(...childEvents.filter(event => event.usageInParent === false).map(event => event.childUsage));
    const potentialMainTokens = mainTokensPrevented + mainTokensInjected;
    const mainContextReductionRatio = potentialMainTokens > 0 ? mainTokensPrevented / potentialMainTokens : 0;
    return {
      scope,
      ...(scope !== "lifetime" ? { sessionId: this.sessionId } : {}),
      ...(scope === "runtime" ? { runtimeId: this.runtimeId } : {}),
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
      childCalls: childEvents.length,
      ...(childUsage ? { childUsage } : {}),
      ...(childEvents.length ? { childUsageComplete: childEvents.every(event => event.childUsageComplete === true) } : {}),
      ...(childUsageOutsideParent ? { childUsageOutsideParent } : {}),
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
        internalTokensProcessed: event.internalTokensProcessed,
        mainTokensPrevented: event.mainTokensPrevented,
        mainTokensInjected: event.mainTokensInjected,
        storeTokensWritten: event.storeTokensWritten,
        ...childUsageFields(event),
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
      runtimeId: typeof raw.runtimeId === "string" ? raw.runtimeId : raw.sessionId,
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
      ...childUsageFields(raw),
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
