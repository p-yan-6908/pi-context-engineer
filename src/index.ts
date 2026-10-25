/**
 * pi-context-engineer — model-boundary context optimization.
 *
 * Initial model-facing results are budgeted, summarized, or offloaded with
 * exact recovery. Already-exposed messages and all internal Fabric values
 * remain untouched. Search semantics belong to Pi/Fabric, not this extension.
 * ctx_read, ctx_summarize and ctx_offload provide explicit selection,
 * compression and storage.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ContextStore, DEFAULT_CONTEXT_STORE_TTL_MS, MAX_CONTEXT_STORE_BYTES } from "./store.js";
import { compactErrorOutput, fabricSectionNames, isVerboseEditAcknowledgement, structuralPreview, type PreviewContentType } from "./preview.js";
import { ceTools, isErrorResult, type ToolContext } from "./tools.js";
import { enableFabricContextReadForChild, FABRIC_CONTEXT_READ_TOOL, readFabricFullOutput } from "./compat/fabric.js";
import { ContextTelemetry, REPEATED_OFFLOADED_CALL_NOTE } from "./telemetry.js";
import { FabricExecutionScopes } from "./execution-scope.js";
// ---- Config ----

interface CeConfig {
  enabled?: boolean;
  /** UTF-8 bytes before text results are auto-offloaded. Default: 16384. */
  readOffloadThreshold?: number;
  /** UTF-8 bytes before a model-boundary error is compacted. Default: 4096. */
  errorCompactionThreshold?: number;
  /** Maximum UTF-8 bytes retained by a compacted error. Default: 4096. */
  errorCompactionPreviewBytes?: number;
  /** Compact successful 2 KB+ edit envelopes while keeping their exact output addressable. */
  compactEditResults?: boolean;
  /** Show an activation notification at each session start. Default: false. */
  notifyOnStart?: boolean;
  /** UTF-8 preview budget retained in an offload handle message. Default: 2048. */
  offloadPreviewBytes?: number;
  /** Optional maximum bytes retained by the context store. */
  storeMaxBytes?: number;
  /** Optional age limit for stored payloads. */
  storeTtlMs?: number;
}

/** Settings earlier versions read. Reported so a stale config is not silently ignored. */
const REMOVED_CONFIG_KEYS = [
  "strict", "blockUnboundedReturns", "maxReturnTokens", "maxUnprocessedToolCalls", "quantitativePolicy", "policy",
  "runtimeAdvisoryThreshold", "resultPolicy", "compactStaleResults", "nestedResultThreshold",
];

/** Load config without throwing; bad JSON and removed settings become warnings surfaced by /ce settings. */
function loadConfigWithWarnings(cwd: string): { config: CeConfig; warnings: string[] } {
  const warnings: string[] = [];
  const configPath = resolve(cwd, ".pi", "context-engineer.json");
  if (!existsSync(configPath)) return { config: {}, warnings };
  let parsed: CeConfig;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8")) as CeConfig;
  } catch {
    warnings.push(`Ignored invalid JSON in ${configPath}; using defaults. Fix the file to clear this warning.`);
    return { config: {}, warnings };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push(`Ignored ${configPath}: it must contain a JSON object; using defaults.`);
    return { config: {}, warnings };
  }
  const removed = REMOVED_CONFIG_KEYS.filter((key) => Object.hasOwn(parsed, key));
  if (removed.length > 0) {
    warnings.push(`Ignored removed setting${removed.length === 1 ? "" : "s"}: ${removed.join(", ")}.` +
      (removed.includes("policy") || removed.includes("quantitativePolicy") ? " readOffloadThreshold sets the offload budget." : ""));
  }
  return { config: parsed, warnings };
}

function describeBoundedClamp(name: string, value: unknown, effective: number, minimum: number): string | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return `${name} is not numeric; using ${effective} bytes.`;
  if (Math.floor(parsed) !== parsed) return `${name} floored to ${effective} bytes (~${Math.ceil(effective / 4)} tokens ASCII-biased).`;
  if (parsed < minimum) return `${name} clamped to ${effective} bytes (~${Math.ceil(effective / 4)} tokens ASCII-biased).`;
  return undefined;
}

function collectBoundedWarnings(cfg: CeConfig): string[] {
  const warnings: string[] = [];
  const push = (msg: string | undefined): void => { if (msg) warnings.push(msg); };
  push(describeBoundedClamp("readOffloadThreshold", cfg.readOffloadThreshold, effectiveOffloadThreshold(cfg), 256));
  push(describeBoundedClamp("errorCompactionThreshold", cfg.errorCompactionThreshold, boundedNumber(cfg.errorCompactionThreshold, 4096, 256), 256));
  push(describeBoundedClamp("errorCompactionPreviewBytes", cfg.errorCompactionPreviewBytes, boundedNumber(cfg.errorCompactionPreviewBytes, 4096, 256, 64_000), 256));
  push(describeBoundedClamp("offloadPreviewBytes", cfg.offloadPreviewBytes, boundedNumber(cfg.offloadPreviewBytes, 2048, 256, 4096), 256));
  // Upper clamps (1B / 64K / 4K caps) also surface so silent shrinking is visible.
  if (typeof cfg.readOffloadThreshold === "number" && cfg.readOffloadThreshold > 1_000_000_000) warnings.push(`readOffloadThreshold clamped to 1000000000 bytes (~250000000 tokens ASCII-biased).`);
  if (typeof cfg.errorCompactionPreviewBytes === "number" && cfg.errorCompactionPreviewBytes > 64_000) warnings.push(`errorCompactionPreviewBytes clamped to 64000 bytes.`);
  if (typeof cfg.offloadPreviewBytes === "number" && cfg.offloadPreviewBytes > 4096) warnings.push(`offloadPreviewBytes clamped to 4096 bytes.`);
  return warnings;
}

/** UTF-8 bytes before a text result is offloaded: about 4K tokens of ASCII. */
const DEFAULT_OFFLOAD_BYTES = 16_384;

function effectiveOffloadThreshold(cfg: CeConfig): number {
  return boundedNumber(cfg.readOffloadThreshold, DEFAULT_OFFLOAD_BYTES, 256);
}

function boundedNumber(value: unknown, fallback: number, minimum = 0, maximum = 1_000_000_000): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.floor(parsed))) : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function isProviderBounded(toolName: string, input: Record<string, unknown>, textLength: number): boolean {
  if (/^(?:fovea_|extensions\.fovea_)/.test(toolName)) {
    const maxTokens = typeof input.maxTokens === "number" ? input.maxTokens : undefined;
    if (maxTokens !== undefined && textLength <= maxTokens * 4) return true;
  }
  return false;
}

function inputHint(input: Record<string, unknown>): string {
  return String(input.path ?? input.pattern ?? input.command ?? input.script ?? input.code ?? input.query ?? "result");
}

function strategyForTool(toolName: string): "WRITE" | "SELECT" | "COMPRESS" | "PASS" {
  if (/offload/.test(toolName)) return "WRITE";
  if (/read|grep|fovea|select/.test(toolName)) return "SELECT";
  if (/summar|compress/.test(toolName)) return "COMPRESS";
  return "PASS";
}

type ReadSurface = "model" | "fabric";

function readRecipe(id: string, surface: ReadSurface): string {
  const tool = surface === "fabric" ? "extensions.ctx_read" : "ctx_read";
  return `${tool}({ id: "${id}", offset: 0, length: 2048 })`;
}

function formatHandleText(
  id: string,
  bytes: number,
  estimatedTokens: number,
  text: string,
  previewBytes: number,
  surface: ReadSurface = "model",
  contentType: PreviewContentType = "unknown",
  readsHandles = false,
): string {
  const preview = structuralPreview(text, previewBytes);
  const complete = Buffer.byteLength(text, "utf8") <= previewBytes;
  const tool = surface === "fabric" ? "extensions.ctx_read" : "ctx_read";
  // Offer only the access modes this payload supports: jsonPath on text is
  // the most common failed read.
  const sections = fabricSectionNames(text);
  const jsonExample = text.startsWith('{"textBlocks":') ? "$.textBlocks[0].text" : "$.field";
  const actions = [
    `  ${tool}({ id: "${id}", query: "term" })  // matching lines`,
    `  ${tool}({ id: "${id}", offset: 0, length: 4096 })  // byte window; continue at nextOffset`,
    ...(sections?.length ? [`  ${tool}({ id: "${id}", section: ${JSON.stringify(sections[0])} })  // one section listed in the preview`] : []),
    ...(contentType === "json" ? [`  ${tool}({ id: "${id}", jsonPath: "${jsonExample}" })  // JSON value; no wildcards or slices`] : []),
  ];
  return `[offloaded to handle "${id}" — ${bytes} bytes (~${estimatedTokens} tokens). The full result is stored; read the handle instead of re-running the call:]\n` +
    (readsHandles
      ? "This program read stored handles and its return still exceeded the boundary. Narrow the selection (smaller length, tighter query, one section) or return a digest.\n"
      : "") +
    `${actions.join("\n")}\n` +
    `Preview (structural selection${complete ? ", complete" : ", not a prefix"}; up to ${previewBytes} bytes):\n${preview}`;
}

// ---- Extension setup ----

export default function contextEngineer(pi: ExtensionAPI): void {
  const initialConfig = loadConfigWithWarnings(process.cwd()).config;
  const fabricContextRead = enableFabricContextReadForChild(initialConfig.enabled !== false);
  // The read path a handle for this result can name, or undefined when this
  // process has none; an unreadable handle would turn offload into data loss.
  // Pi's --tools allowlist also governs extension tools.
  const readSurfaceFor = (toolName: string): ReadSurface | undefined => {
    if (toolName === "fabric_exec") return fabricContextRead ? "fabric" : undefined;
    const active = pi.getActiveTools?.();
    if (!active || active.includes(FABRIC_CONTEXT_READ_TOOL)) return "model";
    return fabricContextRead && active.includes("fabric_exec") ? "fabric" : undefined;
  };
  const configCache = new Map<string, { mtimeMs: number; config: CeConfig; warnings: string[] }>();

  const configFor = (cwd: string): CeConfig => configWithWarnings(cwd).config;

  const configWithWarnings = (cwd: string): { config: CeConfig; warnings: string[] } => {
    const configPath = resolve(cwd, ".pi", "context-engineer.json");
    let mtimeMs = -1;
    try { mtimeMs = statSync(configPath).mtimeMs; } catch { /* no project config */ }
    const hit = configCache.get(cwd);
    if (hit?.mtimeMs === mtimeMs) return { config: hit.config, warnings: hit.warnings };
    const { config, warnings: loadWarnings } = loadConfigWithWarnings(cwd);
    const warnings = [...loadWarnings, ...collectBoundedWarnings(config)];
    configCache.set(cwd, { mtimeMs, config, warnings });
    return { config, warnings };
  };

  const configWarningsFor = (cwd: string): string[] => configWithWarnings(cwd).warnings;

  // Track parent executions by their stable toolCallId. Fabric-generated
  // nested IDs carry the documented `fabric_` prefix, so overlapping programs
  // can finish out of order without a shared depth counter misclassifying an
  // unrelated result.
  const fabricExecutions = new FabricExecutionScopes();
  // fabric_exec calls whose program reads handles; see formatHandleText.
  const handleReadingCalls = new Set<string>();
  // Offloaded calls by tool and input. Repeating one suggests the handle went
  // unused; telemetry reports it through offloadFollowUp.
  const offloadedCalls = new Map<string, string>();
  const callKey = (toolName: string, input: unknown): string =>
    createHash("sha256").update(`${toolName}\0${JSON.stringify(input ?? {})}`).digest("hex");
  const rememberOffloadedCall = (toolName: string, input: unknown, handle: string): void => {
    const key = callKey(toolName, input);
    offloadedCalls.delete(key);
    offloadedCalls.set(key, handle);
    if (offloadedCalls.size > 256) offloadedCalls.delete(offloadedCalls.keys().next().value!);
  };
  const telemetry = new ContextTelemetry();
  const storeFor = (cwd: string, cfg: CeConfig): ContextStore => new ContextStore(
    cwd,
    ".pi/context-store",
    { maxBytes: cfg.storeMaxBytes, ttlMs: cfg.storeTtlMs },
  );

  // Compact at tool_result, before first model exposure, never in a context
  // hook after a result has been seen. Rewriting an earlier message invalidates
  // the provider's cached prefix (including all following messages) and can
  // force the agent to reread evidence. Pi's explicit/automatic session
  // compaction remains responsible for shortening accumulated history.

  // Track each fabric_exec so tool_result can tell its final result from the
  // nested results its program consumes.

  pi.on("tool_call", async (event, ctx) => {
    const handle = offloadedCalls.get(callKey(event.toolName, event.input));
    if (handle && configFor(ctx.cwd).enabled !== false) {
      telemetry.record(ctx.cwd, {
        strategy: "PASS", tool: event.toolName, handle,
        mainTokensPrevented: 0, mainTokensInjected: 0, note: REPEATED_OFFLOADED_CALL_NOTE,
      });
    }
    return undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "fabric_exec") return undefined;

    const cfg = configFor(ctx.cwd);
    if (cfg.enabled === false) return undefined;

    // Current pi-fabric calls this field `code`; accept the older `program`
    // spelling as well so the extension remains compatible with both versions.
    const input = event.input as { code?: unknown; program?: unknown };
    const program = typeof input.code === "string"
      ? input.code
      : typeof input.program === "string"
        ? input.program
        : undefined;
    if (!program || typeof program !== "string") return undefined;

    fabricExecutions.start({
      toolCallId: event.toolCallId,
      workspaceRoot: ctx.cwd,
      startedAt: Date.now(),
    });

    if (/\bctx_read\b/.test(program)) handleReadingCalls.add(event.toolCallId);
    return undefined;
  });

  // A later extension can block the call after this hook. Always close the
  // scope at lifecycle end even when no tool_result fired.
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== "fabric_exec") return;
    fabricExecutions.finish(event.toolCallId);
    handleReadingCalls.delete(event.toolCallId);
  });

  // A model-boundary text result over the threshold is stored and replaced
  // by a handle and preview that ctx_read can expand. This covers any tool,
  // including the final result of fabric_exec.

  const PREVIEW_BYTES = 2048;
  const ERROR_COMPACTION_THRESHOLD = 4096;
  const ERROR_COMPACTION_PREVIEW_BYTES = 4096;

  pi.on("tool_result", async (event, ctx) => {
    const nested = fabricExecutions.isNestedToolResult(event.toolCallId);
    if (event.toolName === "fabric_exec" && !nested) fabricExecutions.finish(event.toolCallId);
    const readsHandles = event.toolName === "fabric_exec" && !nested && handleReadingCalls.delete(event.toolCallId);
    // Provider proxies are still program data, not model context. Replacing
    // details.result with a handle breaks callers that inspect that value.
    if (nested) return undefined;

    const cfg = configFor(ctx.cwd);
    if (cfg.enabled === false) return undefined;

    const textBlocks = event.content.flatMap((item, index) =>
      item.type === "text" ? [{ index, text: item.text }] : []);
    if (textBlocks.length === 0) return undefined;
    const textBytes = textBlocks.reduce((bytes, block) => bytes + Buffer.byteLength(block.text, "utf8"), 0);
    const diagnosticText = textBlocks.map((block) => block.text).join("\n");
    const existingDetails = asRecord(event.details) ?? {};
    const input = (event.input ?? {}) as Record<string, unknown>;
    const threshold = effectiveOffloadThreshold(cfg);
    const errorThreshold = boundedNumber(cfg.errorCompactionThreshold, ERROR_COMPACTION_THRESHOLD, 256);
    const errorBudget = boundedNumber(cfg.errorCompactionPreviewBytes, ERROR_COMPACTION_PREVIEW_BYTES, 256, 64_000);
    const previewBytes = boundedNumber(cfg.offloadPreviewBytes, PREVIEW_BYTES, 256, 4096);
    const alreadyOffloaded = existingDetails.ce_offloaded === true ||
      (textBlocks.length === 1 && /^\[offloaded to handle "[^"]+"/.test(textBlocks[0].text));
    const providerBounded = isProviderBounded(event.toolName, input, textBytes);
    const compactEditAck = cfg.compactEditResults !== false && textBytes >= 2048 &&
      textBlocks.some((block) => isVerboseEditAcknowledgement(block.text));

    if (event.isError ? textBytes < errorThreshold :
      alreadyOffloaded || event.toolName === "ctx_read" || providerBounded ||
      (!compactEditAck && textBytes < threshold)) {
      if (event.toolName === "fabric_exec" && textBytes >= 1024) {
        telemetry.record(ctx.cwd, {
          strategy: "PASS", tool: event.toolName, sourceBytes: textBytes, visibleBytes: textBytes,
          mainTokensPrevented: 0, mainTokensInjected: Math.ceil(textBytes / 4),
          note: "final result kept inline",
        });
      }
      return undefined;
    }

    const surface = readSurfaceFor(event.toolName);
    if (!surface) {
      telemetry.record(ctx.cwd, {
        strategy: "PASS", tool: event.toolName, sourceBytes: textBytes, visibleBytes: textBytes,
        mainTokensPrevented: 0, mainTokensInjected: Math.ceil(textBytes / 4),
        note: "kept inline: ctx_read is not available in this process",
      });
      return undefined;
    }

    // Fabric truncates a final output over its own cap and keeps the full text
    // in a scratch file it soon deletes; store that text so the handle is
    // complete. Single-text handles otherwise store the exact text. Multi-text
    // handles retain every original text and its content-array position.
    const fabricFullOutput = event.toolName === "fabric_exec" && textBlocks.length === 1
      ? readFabricFullOutput(textBlocks[0].text) : undefined;
    const payload = fabricFullOutput ?? (textBlocks.length === 1 ? textBlocks[0].text : JSON.stringify({ textBlocks }));
    const key = `${event.toolName}-${inputHint(input)}`.replace(/[^a-z0-9-]/gi, "-").slice(0, 48);
    let offloaded: ReturnType<ContextStore["write"]>;
    try {
      offloaded = storeFor(ctx.cwd, cfg).write(key, event.toolName, payload);
    } catch (err) {
      // Storage failure must not hide results of an already executed action.
      telemetry.recordStorageFailure(ctx.cwd, event.toolName, err);
      return undefined;
    }
    const recovery = `Full original ${textBlocks.length === 1 ? "text" : "text blocks (with original indices)"}: ${readRecipe(offloaded.id, surface)}`;
    let replacement: string;
    if (event.isError) {
      // Reserve room for the recovery recipe inside the configured budget.
      const remaining = errorBudget - Buffer.byteLength(recovery, "utf8") - 1;
      replacement = `${remaining > 0 ? compactErrorOutput(diagnosticText, remaining) + "\n" : ""}${recovery}`;
    } else {
      replacement = formatHandleText(offloaded.id, offloaded.bytes, offloaded.estimatedTokens, payload, previewBytes, surface, offloaded.contentType, readsHandles);
    }
    // Preserve media positions and a bounded allowance of short independent
    // text notes. The handle retains ALL original text blocks with indices.
    const kept = new Set<number>();
    let keptBytes = 0;
    if (!event.isError && textBlocks.length > 1) {
      for (const block of textBlocks) {
        const bytes = Buffer.byteLength(block.text, "utf8");
        if (bytes <= 256 && keptBytes + bytes <= Math.min(512, previewBytes / 4)) {
          kept.add(block.index); keptBytes += bytes;
        }
      }
      if (kept.size === textBlocks.length) {
        kept.delete(textBlocks[0].index);
        keptBytes -= Buffer.byteLength(textBlocks[0].text, "utf8");
      }
    }
    const firstTextIndex = textBlocks.find(block => !kept.has(block.index))!.index;
    const content = event.content.map((item, index) => item.type === "text" && !kept.has(index)
      ? { ...item, text: index === firstTextIndex ? replacement : "" } : item);
    const visibleBytes = Buffer.byteLength(replacement, "utf8") + keptBytes;
    const sourceTokens = Math.ceil(textBytes / 4);
    const visibleTokens = Math.ceil(visibleBytes / 4);
    telemetry.record(ctx.cwd, {
      strategy: event.isError ? "COMPRESS" : "WRITE", tool: event.toolName,
      sourceBytes: textBytes, visibleBytes, mainTokensPrevented: Math.max(0, sourceTokens - visibleTokens),
      mainTokensInjected: visibleTokens, storeTokensWritten: offloaded.estimatedTokens, handle: offloaded.id,
      note: event.isError ? "error compacted with exact recovery" : compactEditAck
        ? "verbose successful edit acknowledgement offloaded" : fabricFullOutput !== undefined
          ? "Fabric-truncated result offloaded with its full output" : "large final text result offloaded",
    });
    if (!event.isError) rememberOffloadedCall(event.toolName, input, offloaded.id);
    // Details are rendering/state data in native Pi and program data in Fabric.
    // Only content crosses the native model boundary; do not destroy details.
    return {
      content,
      details: {
        ...existingDetails,
        ce_offloaded: true, ce_handle: offloaded.id, ce_content_type: offloaded.contentType,
        ce_original_bytes: textBytes, ce_original_tokens: sourceTokens,
        ce_saved_tokens: Math.max(0, sourceTokens - visibleTokens),
        ...(textBlocks.length > 1 ? { ce_text_blocks: textBlocks.length } : {}),
        ...(fabricFullOutput !== undefined ? { ce_fabric_full_output: true } : {}),
        ...(event.isError ? { ce_error_compacted: true, ce_error_original_bytes: textBytes,
          ce_error_original_tokens: sourceTokens, ce_error_compacted_bytes: visibleBytes } : {}),
        ...(!event.isError && compactEditAck ? { ce_compacted_edit_ack: true } : {}),
      },
    };
  });

  // ================================================================
  // Standalone CE tools
  // ================================================================
  // Thin wrappers around the store and handler functions in tools.ts,
  // callable directly or as extensions.* inside Fabric programs.

  for (const def of ceTools) {
    pi.registerTool({
      name: def.name,
      label: def.name,
      description: def.description,
      parameters: Type.Object(
        Object.fromEntries(
          Object.entries(def.inputSchema.properties ?? {}).map(([k, v]) => {
            const schema = v as { type?: string; description?: string };
            const property = schema.type === "string"
              ? Type.String({ description: schema.description })
              : schema.type === "integer"
                ? Type.Integer({ description: schema.description })
                : schema.type === "boolean"
                  ? Type.Boolean({ description: schema.description })
                  : Type.Any({ description: schema.description });
            const required = (def.inputSchema.required as string[] | undefined)?.includes(k) ?? false;
            return [k, required ? property : Type.Optional(property)];
          })
        )
      ),
      async execute(_id, params, _signal, _onUpdate, execCtx) {
        const toolConfig = configFor(execCtx.cwd);
        const nested = fabricExecutions.isNestedToolResult(_id);
        const toolCtx: ToolContext = {
          store: storeFor(execCtx.cwd, toolConfig),
          workspaceRoot: execCtx.cwd,
          maxReturnBytes: effectiveOffloadThreshold(toolConfig),
        };

        try {
          const result = await def.handler(params, toolCtx);
          const serialized = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          if (isErrorResult(result)) throw new Error(serialized);
          const resultRecord = result && typeof result === "object" ? result as Record<string, unknown> : undefined;
          const sourceTokens = [resultRecord?.originalTokens, resultRecord?.totalTokens, resultRecord?.resultTokens]
            .find((value): value is number => typeof value === "number" && Number.isFinite(value));
          telemetry.record(execCtx.cwd, {
            strategy: strategyForTool(def.name),
            tool: def.name,
            sourceTokens: sourceTokens ?? Math.ceil(serialized.length / 4),
            visibleBytes: Buffer.byteLength(serialized, "utf8"),
            // An explicit read/summary is not a second prevention of the source
            // already offloaded. Nested helper results are not Main exposure.
            mainTokensPrevented: 0,
            mainTokensInjected: nested ? 0 : Math.ceil(Buffer.byteLength(serialized, "utf8") / 4),
            note: nested ? "internal CE helper result" : "CE helper result",
            ...(typeof (params as { id?: unknown }).id === "string" ? { handle: (params as { id: string }).id } : {}),
          });
          // Preserve exact structured helper values, including nested Fabric consumers.
          const maybeHandle = resultRecord as Record<string, unknown> | undefined;
          const handleBytes = maybeHandle?.bytes ?? maybeHandle?.totalBytes ?? maybeHandle?.bytesRead;
          const handleTokens = maybeHandle?.estimatedTokens ?? maybeHandle?.totalTokens;
          const isOffloadHandle = !!maybeHandle && typeof maybeHandle.id === "string" && (typeof handleBytes === "number" || typeof handleTokens === "number" || typeof maybeHandle.preview === "string");
          return {
            content: [{ type: "text" as const, text: serialized }],
            details: isOffloadHandle
              ? {
                  tool: def.name,
                  result,
                  id: maybeHandle.id as string,
                  ...(typeof handleBytes === "number" ? { bytes: handleBytes as number } : {}),
                  ...(typeof handleTokens === "number" ? { estimatedTokens: handleTokens as number } : {}),
                }
              : { tool: def.name, result },
          };
        } catch (err) {
          throw new Error(`Tool ${def.name} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
      },
    });
  }

  // ================================================================
  // ctx_offload tool (for manual offloading)
  // ================================================================

  pi.registerTool({
    name: "ctx_offload",
    label: "ctx_offload",
    description:
      "Offload a large result to disk storage and return a compact handle + preview. " +
      "Signature: { key, source, data } — data accepts text/content aliases, source defaults to 'manual'. " +
      "The data stays out of context. Use ctx_read to inspect slices later.",
    parameters: Type.Object({
      key: Type.String({ description: "Human-readable label for the data." }),
      source: Type.Optional(Type.String({ description: "What produced this data (e.g. 'grep', 'read', 'bash'). Default: 'manual'." })),
      data: Type.Optional(Type.String({ description: "The full payload to offload." })),
      text: Type.Optional(Type.String({ description: "Alias for data." })),
      content: Type.Optional(Type.String({ description: "Alias for data." })),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const payload = (params.data ?? params.text ?? params.content) as string | undefined;
      if (payload === undefined) {
        throw new Error("ctx_offload requires a payload: extensions.ctx_offload({ key, source, data }) — data accepts text/content aliases.");
      }
      const store = storeFor(execCtx.cwd, configFor(execCtx.cwd));
      let result: ReturnType<ContextStore["write"]>;
      try {
        result = store.write(
          params.key as string,
          ((params.source as string) ?? "manual"),
          payload
        );
      } catch (err) {
        telemetry.recordStorageFailure(execCtx.cwd, "ctx_offload", err);
        throw new Error(`ctx_offload failed: storage unavailable (${err instanceof Error ? err.message : String(err)}). The payload was not stored; nothing was hidden.`, { cause: err });
      }
      const visibleText = `Offloaded ${result.bytes} bytes (~${result.estimatedTokens} tokens at ~4 chars/token, ASCII-biased) to handle "${result.id}" [${result.contentType}].\nStructural preview:\n${result.preview}\nRead later with ${readRecipe(result.id, fabricExecutions.isNestedToolResult(_id) ? "fabric" : "model")}; use jsonPath for a focused JSON value.`;
      const visibleBytes = Buffer.byteLength(visibleText, "utf8");
      telemetry.record(execCtx.cwd, {
        strategy: "WRITE",
        tool: "ctx_offload",
        sourceBytes: result.bytes,
        visibleBytes,
        mainTokensPrevented: 0,
        mainTokensInjected: fabricExecutions.isNestedToolResult(_id) ? 0 : Math.ceil(visibleBytes / 4),
        storeTokensWritten: result.estimatedTokens,
        handle: result.id,
        note: "manual context offload",
      });
      return {
        content: [{
          type: "text" as const,
          text: visibleText,
        }],
        details: {
          id: result.id,
          bytes: result.bytes,
          estimatedTokens: result.estimatedTokens,
          ce_offloaded: true,
          ce_handle: result.id,
          ce_content_type: result.contentType,
          ce_original_bytes: result.bytes,
          ce_original_tokens: result.estimatedTokens,
        },
      };
    },
  });

  // ================================================================
  // Observability commands
  // ================================================================

  pi.registerCommand("ce", {
    description: "Inspect Context Engineer policy, token savings, and settings",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const command = parts[0] ?? "status";
      const allSessions = parts.includes("--all");
      let message: string;

      if (command === "status") {
        const summary = telemetry.summary(ctx.cwd, allSessions);
        const reduction = `${(summary.reductionRatio * 100).toFixed(1)}%`;
        const strategyLines = Object.entries(summary.byStrategy)
          .sort(([, left], [, right]) => right.mainTokensPrevented - left.mainTokensPrevented)
          .map(([name, bucket]) => `  ${name.padEnd(8)} ${bucket.mainTokensPrevented.toLocaleString()} Main tokens prevented (${bucket.events} event${bucket.events === 1 ? "" : "s"})`);
        message = [
          `Context Engineer${allSessions ? " (all sessions)" : " (current session)"}`,
          `Main tokens prevented: ${summary.mainTokensPrevented.toLocaleString()}`,
          `Main tokens injected: ${summary.mainTokensInjected.toLocaleString()}`,
          `Store tokens written: ${summary.storeTokensWritten.toLocaleString()}`,
          `Main context reduction: ${summary.mainTokensPrevented.toLocaleString()} tokens (${reduction})`,
          `Events: ${summary.events}`,
          `Offloads read back: ${summary.offloadFollowUp.handlesRead}/${summary.offloadFollowUp.handles}; repeated offloaded calls: ${summary.offloadFollowUp.repeatedCalls}`,
          ...(strategyLines.length > 0 ? ["", "By strategy:", ...strategyLines] : []),
          ...(summary.largest ? ["", `Largest Main-context prevention: ${summary.largest.tool} — ${summary.largest.mainTokensPrevented.toLocaleString()} tokens`] : []),
        ].join("\n");
      } else if (command === "trace") {
        const events = telemetry.recent(ctx.cwd, 20, allSessions);
        message = events.length === 0
          ? "No Context Engineer events recorded."
          : events.map((event) => `${event.timestamp.slice(11, 19)} ${event.strategy.padEnd(8)} ${event.tool} prevented=${event.mainTokensPrevented} injected=${event.mainTokensInjected} store=${event.storeTokensWritten}${event.note ? ` — ${event.note}` : ""}`).join("\n");
      } else if (command === "settings") {
        const cfg = configFor(ctx.cwd);
        message = JSON.stringify({
          enabled: cfg.enabled !== false,
          readOffloadThreshold: effectiveOffloadThreshold(cfg),
          warnings: configWarningsFor(ctx.cwd),
          errorCompactionThreshold: boundedNumber(cfg.errorCompactionThreshold, ERROR_COMPACTION_THRESHOLD, 256),
          errorCompactionPreviewBytes: boundedNumber(cfg.errorCompactionPreviewBytes, ERROR_COMPACTION_PREVIEW_BYTES, 256, 64_000),
          offloadPreviewBytes: boundedNumber(cfg.offloadPreviewBytes, PREVIEW_BYTES, 256, 4096),
          compactEditResults: cfg.compactEditResults !== false,
          notifyOnStart: cfg.notifyOnStart === true,
          storeMaxBytes: Math.min(MAX_CONTEXT_STORE_BYTES, cfg.storeMaxBytes ?? MAX_CONTEXT_STORE_BYTES),
          storeTtlMs: cfg.storeTtlMs ?? DEFAULT_CONTEXT_STORE_TTL_MS,
        }, null, 2);
      } else if (command === "clear") {
        telemetry.clear(ctx.cwd);
        message = "Context Engineer telemetry cleared for this workspace.";
      } else {
        message = "Usage: /ce [status|trace|settings|clear] [--all]";
      }

      ctx.ui.notify(message, "info");
    },
  });

  // ================================================================
  // Session lifecycle logging
  // ================================================================

  pi.on("session_start", async (_event, ctx) => {
    fabricExecutions.clear();
    handleReadingCalls.clear();
    offloadedCalls.clear();
    telemetry.setSessionId(ctx.sessionManager?.getSessionId?.());
    const cfg = configFor(ctx.cwd);
    if (cfg.enabled === false) return;
    if (ctx.hasUI && cfg.notifyOnStart === true) {
      ctx.ui.notify(
        "context-engineer: active — runtime boundary guard, addressable context, /ce status",
        "info"
      );
    }
  });
}
