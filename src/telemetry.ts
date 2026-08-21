/**
 * Lightweight context telemetry.
 *
 * Events intentionally contain sizes, strategies, tool names, and handles only;
 * they never contain prompts, source text, command arguments, or tool payloads.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type ContextStrategy = "PASS" | "WARN" | "BLOCK" | "WRITE" | "SELECT" | "COMPRESS" | "ISOLATE";

export interface ContextEvent {
  version: 1;
  timestamp: string;
  sessionId: string;
  strategy: ContextStrategy;
  tool: string;
  sourceBytes: number;
  visibleBytes: number;
  sourceTokens: number;
  visibleTokens: number;
  savedTokens: number;
  provider?: string;
  handle?: string;
  note?: string;
}

export interface StrategySummary {
  events: number;
  sourceTokens: number;
  visibleTokens: number;
  savedTokens: number;
}

export interface ContextSummary {
  sessionId?: string;
  events: number;
  sourceTokens: number;
  visibleTokens: number;
  savedTokens: number;
  reductionRatio: number;
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
  note?: string;
  handle?: string;
}

function estimateTokens(charsOrBytes: number): number {
  return Math.ceil(charsOrBytes / 4);
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
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
      const item: ContextEvent = {
        version: 1,
        timestamp: new Date().toISOString(),
        sessionId: this.sessionId,
        strategy: event.strategy,
        tool: event.tool.slice(0, 120),
        sourceBytes,
        visibleBytes,
        sourceTokens,
        visibleTokens,
        savedTokens: Math.max(0, sourceTokens - visibleTokens),
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
    let largest: ContextEvent | undefined;

    for (const event of events) {
      sourceTokens += event.sourceTokens;
      visibleTokens += event.visibleTokens;
      savedTokens += event.savedTokens;
      const bucket = byStrategy[event.strategy] ??= { events: 0, sourceTokens: 0, visibleTokens: 0, savedTokens: 0 };
      bucket.events++;
      bucket.sourceTokens += event.sourceTokens;
      bucket.visibleTokens += event.visibleTokens;
      bucket.savedTokens += event.savedTokens;
      if (!largest || event.savedTokens > largest.savedTokens) largest = event;
    }

    return {
      ...(allSessions ? {} : { sessionId: this.sessionId }),
      events: events.length,
      sourceTokens,
      visibleTokens,
      savedTokens,
      reductionRatio: sourceTokens > 0 ? savedTokens / sourceTokens : 0,
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
        .map((line) => JSON.parse(line) as ContextEvent)
        .filter((event) => event && event.version === 1 && typeof event.sessionId === "string");
    } catch {
      return [];
    }
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
