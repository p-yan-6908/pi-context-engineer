/**
 * pi-context-engineer — model-boundary context optimization.
 *
 * fabric_exec preflight is advisory by default, with explicit strict modes.
 * Initial model-facing results are budgeted, summarized, or offloaded with
 * exact recovery. Already-exposed messages and all internal Fabric values
 * remain untouched. Search semantics belong to Pi/Fabric, not this extension.
 * Standalone ctx_* helpers provide explicit selection, storage and isolation.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { mergeUsage, readUsage } from "./usage.js";
import { Type } from "typebox";
import { ContextStore, DEFAULT_CONTEXT_STORE_TTL_MS, MAX_CONTEXT_STORE_BYTES } from "./store.js";
import { compactErrorOutput, isVerboseEditAcknowledgement, structuralPreview } from "./preview.js";
import { ceTools, isErrorResult, summarizeText, type ToolContext } from "./tools.js";
import { evaluateProgram, runtimeAdvisoryLine, type WrapperOptions } from "./wrapper.js";
import { runChildPiResult } from "./child.js";
import { ContextTelemetry } from "./telemetry.js";
import { FabricExecutionScopes } from "./execution-scope.js";
import { DEFAULT_RUNTIME_OFFLOAD_BYTES, resolveRuntimeByteBudget, validateContextBoundaryPolicy, type ContextBoundaryPolicy } from "./quantitative-policy.js";

export {
  contextEffects,
  contextEffectFor,
  isBoundedContextEffect,
  isContextHelperName,
  isFoveaName,
  normalizeCalleeName,
} from "./context-effects.js";
export type {
  BoundExpression,
  BoundUnit,
  ContextEffect,
  ContextEffectKind,
  ContextProvenanceLocation,
  ContextProvenanceStep,
  ResolvedBound,
} from "./context-effects.js";
export { explainProgram, explanationFromAnalysis, formatProgramExplanation } from "./explanation.js";
export type { ProgramExplanation } from "./explanation.js";
export { DEFAULT_CONTEXT_BOUNDARY_POLICY, evaluateReturnBudget, MAX_CONTEXT_BOUNDARY_BUDGET, validateContextBoundaryPolicy } from "./quantitative-policy.js";
export type { ContextBoundaryPolicy, QuantitativeDecision } from "./quantitative-policy.js";

// ---- Config ----

export type ResultPolicy = "auto" | "inline" | "offload" | "summarize";

interface CeConfig extends WrapperOptions {
  /** User-facing alias for quantitativePolicy in context-engineer.json. */
  policy?: ContextBoundaryPolicy;
  enabled?: boolean;
  /** UTF-8 bytes before text results are auto-offloaded. Default: 16384. */
  readOffloadThreshold?: number;
  /** Automatic boundary behavior: auto, inline, offload, or summarize. Default: auto. */
  resultPolicy?: ResultPolicy;
  /** UTF-8 bytes before a model-boundary error is compacted. Default: 4096. */
  errorCompactionThreshold?: number;
  /** Maximum UTF-8 bytes retained by a compacted error. Default: 4096. */
  errorCompactionPreviewBytes?: number;
  /** fabric_exec boundary results at or above this size get a one-line
   *  advisory instead of silence. Default: 0 (disabled). */
  runtimeAdvisoryThreshold?: number;
  /** @deprecated Accepted but ignored. Previously exposed messages stay prefix-stable. */
  compactStaleResults?: boolean;
  /** Compact successful 2 KB+ edit envelopes while keeping their exact output addressable. */
  compactEditResults?: boolean;
  /** Show an activation notification at each session start. Default: false. */
  notifyOnStart?: boolean;
  /** @deprecated Ignored: internal Fabric provider values are never rewritten. */
  nestedResultThreshold?: number;
  /** UTF-8 preview budget retained in an offload handle message. Default: 2048. */
  offloadPreviewBytes?: number;
  /** Optional maximum bytes retained by the context store. */
  storeMaxBytes?: number;
  /** Optional age limit for stored payloads. */
  storeTtlMs?: number;
}

function loadConfig(cwd: string): CeConfig {
  return loadConfigWithWarnings(cwd).config;
}

/** Load config without throwing; bad JSON and invalid policy become warnings surfaced via ctx_status. */
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
  const configuredPolicy = (parsed as CeConfig).policy ?? (parsed as CeConfig).quantitativePolicy;
  if (configuredPolicy !== undefined) {
    if (!configuredPolicy || typeof configuredPolicy !== "object") {
      warnings.push("Ignored invalid context policy (must be an object); using defaults for policy.");
      const { policy: _droppedPolicy, quantitativePolicy: _droppedQuant, ...rest } = parsed as Record<string, unknown>;
      return { config: rest as unknown as CeConfig, warnings };
    }
    const errors = validateContextBoundaryPolicy(configuredPolicy as ContextBoundaryPolicy);
    if (errors.length > 0) {
      warnings.push(`Ignored invalid context policy (${errors.join(" ")}); using defaults for policy.`);
      const { policy: _droppedPolicy2, quantitativePolicy: _droppedQuant2, ...rest } = parsed as Record<string, unknown>;
      return { config: rest as unknown as CeConfig, warnings };
    }
    return { config: configuredPolicy === undefined ? parsed : { ...parsed, quantitativePolicy: configuredPolicy as ContextBoundaryPolicy }, warnings };
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
  push(describeBoundedClamp("readOffloadThreshold", cfg.readOffloadThreshold, resolveRuntimeByteBudget(cfg.readOffloadThreshold, cfg.quantitativePolicy ?? cfg.policy), 256));
  push(describeBoundedClamp("errorCompactionThreshold", cfg.errorCompactionThreshold, boundedNumber(cfg.errorCompactionThreshold, 4096, 256), 256));
  push(describeBoundedClamp("errorCompactionPreviewBytes", cfg.errorCompactionPreviewBytes, boundedNumber(cfg.errorCompactionPreviewBytes, 4096, 256, 64_000), 256));
  push(describeBoundedClamp("offloadPreviewBytes", cfg.offloadPreviewBytes, boundedNumber(cfg.offloadPreviewBytes, 2048, 256, 4096), 256));
  // Upper clamps (1B / 64K / 4K caps) also surface so silent shrinking is visible.
  if (typeof cfg.readOffloadThreshold === "number" && cfg.readOffloadThreshold > 1_000_000_000) warnings.push(`readOffloadThreshold clamped to 1000000000 bytes (~250000000 tokens ASCII-biased).`);
  if (typeof cfg.errorCompactionPreviewBytes === "number" && cfg.errorCompactionPreviewBytes > 64_000) warnings.push(`errorCompactionPreviewBytes clamped to 64000 bytes.`);
  if (typeof cfg.offloadPreviewBytes === "number" && cfg.offloadPreviewBytes > 4096) warnings.push(`offloadPreviewBytes clamped to 4096 bytes.`);
  return warnings;
}

function effectivePolicyFor(cfg: CeConfig): ContextBoundaryPolicy | undefined {
  return cfg.quantitativePolicy ?? cfg.policy;
}

function effectiveOffloadThreshold(cfg: CeConfig): number {
  return resolveRuntimeByteBudget(cfg.readOffloadThreshold, effectivePolicyFor(cfg));
}

const DEFAULT_RESULT_POLICY: ResultPolicy = "auto";
const RESULT_POLICIES = new Set<ResultPolicy>(["auto", "inline", "offload", "summarize"]);

function normalizeResultPolicy(value: unknown): ResultPolicy {
  return typeof value === "string" && RESULT_POLICIES.has(value as ResultPolicy)
    ? value as ResultPolicy
    : DEFAULT_RESULT_POLICY;
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
  // Budgeted ctx_recall declares maxTokens (default 1000 in tools.ts); exempt like fovea when actual fits.
  if (/^(?:ctx_recall|extensions\.ctx_recall)$/.test(toolName)) {
    const raw = (input as Record<string, unknown>).maxTokens;
    const maxTokens = typeof raw === "number" ? raw : 1000;
    if (Number.isFinite(maxTokens) && maxTokens >= 0 && textLength <= Math.floor(maxTokens) * 4) return true;
  }
  return false;
}

function inputHint(input: Record<string, unknown>): string {
  return String(input.path ?? input.pattern ?? input.command ?? input.script ?? input.code ?? input.query ?? "result");
}

function strategyForTool(toolName: string): "WRITE" | "SELECT" | "COMPRESS" | "ISOLATE" | "PASS" {
  if (/offload/.test(toolName)) return "WRITE";
  if (/read|grep|fovea|select|recall/.test(toolName)) return "SELECT";
  if (/summar|compress/.test(toolName)) return "COMPRESS";
  if (/delegat|agent/.test(toolName)) return "ISOLATE";
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
): string {
  const preview = structuralPreview(text, previewBytes);
  const truncated = Buffer.byteLength(text, "utf8") > previewBytes;
  const tool = surface === "fabric" ? "extensions.ctx_read" : "ctx_read";
  const actions =
    `  ${tool}({ id: "${id}", query: "field-or-term" })       // search inside the handle\n` +
    `  ${tool}({ id: "${id}", offset: 0, length: 4096 })      // read a window\n` +
    `  ${tool}({ id: "${id}", section: "name" })              // named section of a sectioned preview\n` +
    `  ${tool}({ id: "${id}", jsonPath: "$.path.to.field" })  // JSON payloads only — not for text previews`;
  const handle =
    `[offloaded to handle "${id}" — ${bytes} bytes (~${estimatedTokens} tokens). The FULL result is stored; nothing is lost. Do not re-run the command — read the handle instead:]\n` +
    actions +
    `\nPreview (first ${previewBytes} bytes of the stored payload):\n${preview}` +
    (truncated ? `\n[preview ends mid-payload; the handle holds the rest]` : ``);
  return handle;
}

// ---- Always-on boundary cheat sheet ---------------------------------------
// Injected at before_agent_start so the rules travel with the extension
// lifecycle: enable context-engineer and they appear, disable it and they are
// gone. Kept deliberately small; the deep playbook lives in the skill.

const BOUNDARY_GUIDELINES = `

## Context boundary (context-engineer)

Tool results over ~16 KB auto-offload to a session-scoped handle: you see a
structural preview, not the blob. An \`[offloaded to handle ...]\` notice means
the data is SAFE and readable — pull slices with \`ctx_read\`; do not re-run the
command to "get the full output".
- Pull slices with \`extensions.ctx_read({ id, offset, length })\`; field names and text
  occurrences with \`{ id, query }\`; named parts with \`{ id, section }\`.
- \`jsonPath\` only on JSON handles (\`ctx_offload\` payloads). Auto-offloaded
  previews are sectioned text — \`jsonPath\` fails there.
- Handles die with the session and nest: read slices, never re-read raw sources.
- Prefer deterministic compression: \`extensions.ctx_summarize({ text, mode: "structural" | "code", maxTokens })\`.
  Aggregate in-guest before offloading.
`;
// ---- Extension setup ----

export default function contextEngineer(pi: ExtensionAPI): void {
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
  const telemetry = new ContextTelemetry();
  const failedChildUsage = new Map<string, { usage?: Usage; complete: boolean }>();
  // execute must throw on failure. Restore measured usage through Pi's
  // supported middleware instead of marking a failed tool as successful.
  // Always-on boundary cheat sheet: travels with the extension lifecycle.
  // Appended after the current system prompt (see claude-rules example idiom).
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: event.systemPrompt + BOUNDARY_GUIDELINES,
  }));

  pi.on("tool_result", async (event) => {
    const pending = failedChildUsage.get(event.toolCallId);
    if (!pending) return undefined;
    failedChildUsage.delete(event.toolCallId);
    const usage = event.usage ?? pending.usage;
    return {
      ...(usage ? { usage } : {}),
      details: { ...asRecord(event.details), ce_child_usage_complete: pending.complete },
    };
  });

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

  // ================================================================
  // Fix 2: Intercept fabric_exec via tool_call hook
  // ================================================================
  //
  // This is the primary enforcement. When the model calls fabric_exec,
  // we intercept the program BEFORE it runs. If the analyzer detects a
  // passthrough (raw tool result returned with no processing), runtime-first
  // mode executes under the actual boundary guard; strict mode blocks.

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

    const decision = evaluateProgram(program, cfg);

    if (decision.tier === "BLOCK") {
      telemetry.record(ctx.cwd, {
        strategy: "BLOCK",
        tool: "fabric_exec",
        sourceTokens: decision.analysis.metrics.estimatedSourceTokens ?? 0,
        visibleTokens: Math.ceil(decision.guidance.length / 4),
        mainTokensPrevented: decision.analysis.metrics.estimatedSourceTokens ?? 0,
        mainTokensInjected: Math.ceil(decision.guidance.length / 4),
        note: decision.analysis.reasons[0] ?? "static policy block",
      });
      return {
        block: true,
        reason: decision.guidance,
      };
    }

    // PASS and WARN both execute; track the execution so tool_result can tell
    // model-boundary results apart from intermediate ones. BLOCK does not
    // execute, so it must not open a scope.
    fabricExecutions.start({
      toolCallId: event.toolCallId,
      workspaceRoot: ctx.cwd,
      startedAt: Date.now(),
    });

    // WARN is annotated in the tool_result hook.
    return undefined;
  });

  // A later extension can block a call after CE preflight. Always close any
  // optimistic scope at lifecycle end even when no tool_result fired.
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== "fabric_exec") return;
    fabricExecutions.finish(event.toolCallId);
  });

  // ================================================================
  // Fix 4: Auto-offload large text results via tool_result hook
  // ================================================================
  //
  // When a text result exceeds the threshold, offload the full content to
  // disk and replace the in-context result with a handle
  // + preview. The model can use ctx_read to inspect the full content
  // later without re-reading the file.
  //
  // This applies to both the built-in `read` tool and any tool whose
  // result is text content (including fabric_exec results that are large).

  // Unified byte budgets: runtime default preserved at 16KB (~4K tokens ASCII-biased);
  // static policy maxBytes (8KB) documented in quantitative-policy; policy.maxBytes unifies when set.
  const READ_OFFLOAD_THRESHOLD = DEFAULT_RUNTIME_OFFLOAD_BYTES; // 16_384 bytes, ~4K tokens ASCII-biased
  const PREVIEW_BYTES = 2048;
  const ERROR_COMPACTION_THRESHOLD = 4096;
  const ERROR_COMPACTION_PREVIEW_BYTES = 4096;

  pi.on("tool_result", async (event, ctx) => {
    const nested = fabricExecutions.isNestedToolResult(event.toolCallId);
    if (event.toolName === "fabric_exec" && !nested) fabricExecutions.finish(event.toolCallId);
    // Provider proxies are still program data, not model context. Replacing
    // details.result with a handle breaks callers that inspect that value.
    if (nested) return undefined;

    const cfg = configFor(ctx.cwd);
    if (cfg.enabled === false) return undefined;
    const resultPolicy = normalizeResultPolicy(cfg.resultPolicy);
    if (resultPolicy === "inline") return undefined;

    const textBlocks = event.content.flatMap((item, index) =>
      item.type === "text" ? [{ index, text: item.text }] : []);
    if (textBlocks.length === 0) return undefined;
    const textBytes = textBlocks.reduce((bytes, block) => bytes + Buffer.byteLength(block.text, "utf8"), 0);
    // Single-text handles retain the exact old read-back contract. Multi-text
    // handles retain every original text and its content-array position.
    const payload = textBlocks.length === 1 ? textBlocks[0].text : JSON.stringify({ textBlocks });
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
      alreadyOffloaded || event.toolName === "ctx_read" ||
      (resultPolicy === "auto" && providerBounded) ||
      (resultPolicy !== "offload" && !compactEditAck && textBytes < threshold)) {
      if (event.toolName === "fabric_exec" && textBytes >= 1024) {
        telemetry.record(ctx.cwd, {
          strategy: "PASS", tool: event.toolName, sourceBytes: textBytes, visibleBytes: textBytes,
          mainTokensPrevented: 0, mainTokensInjected: Math.ceil(textBytes / 4),
          note: "final result kept inline",
        });
      }
      const advisoryThreshold = cfg.runtimeAdvisoryThreshold ?? 0;
      if (!event.isError && event.toolName === "fabric_exec" && advisoryThreshold > 0 && textBytes >= advisoryThreshold) {
        const advisory = runtimeAdvisoryLine(textBytes);
        return { content: event.content.map((item, index) => item.type === "text" && index === textBlocks[0].index ? { ...item, text: `${item.text}\n${advisory}` } : item), details: { ...existingDetails, ce_advisory: advisory } };
      }
      return undefined;
    }

    const key = `${event.toolName}-${inputHint(input)}`.replace(/[^a-z0-9-]/gi, "-").slice(0, 48);
    let offloaded: ReturnType<ContextStore["write"]>;
    try {
      offloaded = storeFor(ctx.cwd, cfg).write(key, event.toolName, payload);
    } catch (err) {
      // Storage failure must not hide results of an already executed action.
      telemetry.recordStorageFailure(ctx.cwd, event.toolName, err);
      return undefined;
    }
    const recovery = `Full original ${textBlocks.length === 1 ? "text" : "text blocks (with original indices)"}: ${readRecipe(offloaded.id, event.toolName === "fabric_exec" ? "fabric" : "model")}`;
    let replacement: string;
    const compressed = event.isError || resultPolicy === "summarize";
    if (event.isError) {
      // Reserve room for the recovery recipe inside the configured budget.
      const remaining = errorBudget - Buffer.byteLength(recovery, "utf8") - 1;
      replacement = `${remaining > 0 ? compactErrorOutput(diagnosticText, remaining) + "\n" : ""}${recovery}`;
    } else if (resultPolicy === "summarize") {
      const summary = JSON.stringify(summarizeText(payload, Math.floor(previewBytes / 4)));
      replacement = `Structural summary:\n${structuralPreview(summary, previewBytes)}\n${recovery}`;
    } else {
      replacement = formatHandleText(offloaded.id, offloaded.bytes, offloaded.estimatedTokens, payload, previewBytes, event.toolName === "fabric_exec" ? "fabric" : "model");
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
      strategy: compressed ? "COMPRESS" : "WRITE", tool: event.toolName,
      sourceBytes: textBytes, visibleBytes, mainTokensPrevented: Math.max(0, sourceTokens - visibleTokens),
      mainTokensInjected: visibleTokens, storeTokensWritten: offloaded.estimatedTokens, handle: offloaded.id,
      note: event.isError ? "error compacted with exact recovery" : resultPolicy === "summarize"
        ? "structural boundary summary with exact recovery" : compactEditAck
          ? "verbose successful edit acknowledgement offloaded" : "large final text result offloaded",
    });
    // Details are rendering/state data in native Pi and program data in Fabric.
    // Only content crosses the native model boundary; do not destroy details.
    return {
      content,
      details: {
        ...existingDetails,
        ce_offloaded: true, ce_handle: offloaded.id, ce_content_type: offloaded.contentType,
        ce_original_bytes: textBytes, ce_original_tokens: sourceTokens,
        ce_return_policy: resultPolicy, ce_saved_tokens: Math.max(0, sourceTokens - visibleTokens),
        ...(textBlocks.length > 1 ? { ce_text_blocks: textBlocks.length } : {}),
        ...(event.isError ? { ce_error_compacted: true, ce_error_original_bytes: textBytes,
          ce_error_original_tokens: sourceTokens, ce_error_compacted_bytes: visibleBytes } : {}),
        ...(!event.isError && resultPolicy === "summarize" ? { ce_summarized: true } : {}),
        ...(!event.isError && compactEditAck ? { ce_compacted_edit_ack: true } : {}),
      },
    };
  });

  // ================================================================
  // Standalone CE tools
  // ================================================================
  // These are available for the model to call directly. They cover all
  // four CE strategies. The tools are thin wrappers around the store
  // and handler functions in tools.ts.

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
      async execute(_id, params, signal, _onUpdate, execCtx) {
        const currentModel = execCtx.model
          ? `${execCtx.model.provider}/${execCtx.model.id}`
          : undefined;
        const toolConfig = configFor(execCtx.cwd);
        let childUsage: Usage | undefined;
        let childCalls = 0;
        let childUsageComplete = true;
        let childOutputTruncated = false;
        const childBudgetModes = new Set<string>();
        const nested = fabricExecutions.isNestedToolResult(_id);
        const captureUsage = (result: { usage?: unknown; usageComplete?: boolean; outputTruncated?: boolean; budgetEnforcement?: string }) => {
          childOutputTruncated ||= result.outputTruncated === true;
          if (result.budgetEnforcement) childBudgetModes.add(result.budgetEnforcement);
          const observed = readUsage(result.usage);
          const complete = observed !== undefined && result.usageComplete !== false;
          childUsage = mergeUsage(childUsage, observed);
          childUsageComplete &&= complete;
          telemetry.record(execCtx.cwd, {
            strategy: "ISOLATE", tool: def.name,
            internalTokensProcessed: observed?.totalTokens, mainTokensInjected: 0, mainTokensPrevented: 0,
            childUsage: observed, childUsageComplete: complete, usageInParent: !nested,
            note: nested ? "child usage outside native totals (Fabric capture)" : "child usage included via native tool Usage",
          });
        };
        const child = async (prompt: string, options: Parameters<typeof runChildPiResult>[1]): Promise<string> => {
          childCalls++;
          try {
            const result = await runChildPiResult(prompt, options);
            captureUsage(result);
            return result.text;
          } catch (error) {
            captureUsage((error ?? {}) as { usage?: unknown; usageComplete?: boolean; outputTruncated?: boolean; budgetEnforcement?: string });
            throw error;
          }
        };
        const toolCtx: ToolContext = {
          store: storeFor(execCtx.cwd, toolConfig),
          workspaceRoot: execCtx.cwd,
          signal: signal ?? execCtx.signal,
          maxReturnBytes: effectiveOffloadThreshold(toolConfig),
          callTool: async () => {
            throw new Error("callTool is only available inside a Fabric program; use pi.* or extensions.* there.");
          },
          spawnAgent: (prompt, opts) => child(prompt, {
            cwd: execCtx.cwd,
            signal: signal ?? execCtx.signal,
            model: opts?.model ?? currentModel,
            timeoutMs: opts?.timeoutMs ?? 90_000,
            maxTokens: opts?.maxTokens ?? 1200,
            maxTurns: opts?.maxTurns ?? 8,
          }),
          modelCall: (prompt, maxTokens, opts) => child(prompt, {
            cwd: execCtx.cwd,
            signal: opts?.signal ?? signal ?? execCtx.signal,
            model: currentModel,
            noTools: true,
            maxTokens: maxTokens ?? 500,
            maxTurns: 1,
            timeoutMs: 90_000,
          }),
        };

        try {
          const handled = await def.handler(params, toolCtx);
          const result = childCalls && asRecord(handled) ? {
            ...asRecord(handled),
            ...(childOutputTruncated ? { childOutputTruncated: true } : {}),
            ...(childBudgetModes.has("stream") ? { generationBudget: { enforcement: "stream", approximate: true, mayOvershoot: true } } : {}),
          } : handled;
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
            mainTokensInjected: fabricExecutions.isNestedToolResult(_id) ? 0 : Math.ceil(Buffer.byteLength(serialized, "utf8") / 4),
            note: fabricExecutions.isNestedToolResult(_id) ? "internal CE helper result" : "CE helper result",
          });
          // Preserve exact structured helper values, including nested Fabric consumers.
          const maybeHandle = resultRecord as Record<string, unknown> | undefined;
          const handleBytes = maybeHandle?.bytes ?? maybeHandle?.totalBytes ?? maybeHandle?.bytesRead;
          const handleTokens = maybeHandle?.estimatedTokens ?? maybeHandle?.totalTokens;
          const isOffloadHandle = !!maybeHandle && typeof maybeHandle.id === "string" && (typeof handleBytes === "number" || typeof handleTokens === "number" || typeof maybeHandle.preview === "string");
          return {
            content: [{ type: "text" as const, text: serialized }],
            ...(childUsage ? { usage: childUsage } : {}),
            details: isOffloadHandle
              ? {
                  tool: def.name,
                  result,
                  ...(childCalls ? { ce_child_calls: childCalls, ce_child_usage: childUsage, ce_child_usage_complete: childUsageComplete, ce_child_budget_enforcement: [...childBudgetModes], ce_child_output_truncated: childOutputTruncated } : {}),
                  id: maybeHandle.id as string,
                  ...(typeof handleBytes === "number" ? { bytes: handleBytes as number } : {}),
                  ...(typeof handleTokens === "number" ? { estimatedTokens: handleTokens as number } : {}),
                }
              : { tool: def.name, result, ...(childCalls ? { ce_child_calls: childCalls, ce_child_usage: childUsage, ce_child_usage_complete: childUsageComplete, ce_child_budget_enforcement: [...childBudgetModes], ce_child_output_truncated: childOutputTruncated } : {}) },
          };
        } catch (err) {
          // Fabric currently drops captured Usage; telemetry above keeps it
          // independently visible without guessing at concurrent parent IDs.
          if (childCalls && !nested) {
            failedChildUsage.set(_id, { usage: childUsage, complete: childUsageComplete });
            if (failedChildUsage.size > 256) failedChildUsage.delete(failedChildUsage.keys().next().value!);
          }
          throw Object.assign(new Error(`Tool ${def.name} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err }),
            childCalls ? { usage: childUsage, usageComplete: childUsageComplete } : {});
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
  // ctx_status tool (policy introspection for agents)
  // ================================================================

  pi.registerTool({
    name: "ctx_status",
    label: "ctx_status",
    description:
      "Report context-engineer policy state: enabled, strict mode, result policy, " +
      "offload/error thresholds, and token savings for one scope. Compact by default; detail=full includes all scopes and diagnostic breakdowns.",
    parameters: Type.Object({
      scope: Type.Optional(Type.Union([
        Type.Literal("runtime"),
        Type.Literal("session"),
        Type.Literal("lifetime"),
      ], { description: "Telemetry scope to report. Default: session." })),
      detail: Type.Optional(Type.Union([Type.Literal("compact"), Type.Literal("full")], {
        description: "Compact (default) returns one scope without per-event/per-strategy breakdowns; full restores all three scopes and diagnostics.",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const cfg = configFor(execCtx.cwd);
      const requestedScope = (params as { scope?: unknown }).scope;
      const scope = requestedScope === "runtime" || requestedScope === "lifetime" ? requestedScope : "session";
      const full = (params as { detail?: unknown }).detail === "full";
      // Default status reads only the requested scope, not the lifetime event log three times.
      const summaries = new Map<string, ReturnType<ContextTelemetry["summary"]>>();
      const getSummary = (selected: "runtime" | "session" | "lifetime") => {
        if (!summaries.has(selected)) summaries.set(selected, selected === "runtime"
          ? telemetry.runtimeSummary(execCtx.cwd) : telemetry.summary(execCtx.cwd, selected === "lifetime"));
        return summaries.get(selected)!;
      };
      const selectedSummary = getSummary(scope);
      const { byStrategy: _byStrategy, largest: _largest, ...compactSummary } = selectedSummary;
      const summary = full ? selectedSummary : compactSummary;
      const effectiveReadThreshold = effectiveOffloadThreshold(cfg);
      const warnings = configWarningsFor(execCtx.cwd);
      const body = {
        enabled: cfg.enabled !== false,
        strict: cfg.strict ?? false,
        resultPolicy: normalizeResultPolicy(cfg.resultPolicy),
        readOffloadThreshold: effectiveReadThreshold,
        nestedResultThreshold: null, // Deprecated: Fabric owns internal transport limits.
        errorCompactionThreshold: boundedNumber(cfg.errorCompactionThreshold, ERROR_COMPACTION_THRESHOLD, 256),
        errorCompactionPreviewBytes: boundedNumber(cfg.errorCompactionPreviewBytes, ERROR_COMPACTION_PREVIEW_BYTES, 256, 64_000),
        runtimeAdvisoryThreshold: cfg.runtimeAdvisoryThreshold ?? 0,
        blockUnboundedReturns: cfg.strict === true || cfg.blockUnboundedReturns === true,
        compactStaleResults: false, // Legacy field: historical context is never rewritten.
        compactEditResults: cfg.compactEditResults !== false,
        notifyOnStart: cfg.notifyOnStart === true,
        offloadPreviewBytes: boundedNumber(cfg.offloadPreviewBytes, PREVIEW_BYTES, 256, 4096),
        storeTtlMs: cfg.storeTtlMs ?? DEFAULT_CONTEXT_STORE_TTL_MS,
        storeMaxBytes: Math.min(MAX_CONTEXT_STORE_BYTES, cfg.storeMaxBytes ?? MAX_CONTEXT_STORE_BYTES),
        maxReturnTokens: cfg.maxReturnTokens ?? 4000,
        telemetryScope: scope,
        warnings,
        policy: `runtime guard executes uncertain programs and auto-offloads actual ${effectiveReadThreshold}-byte+ boundary results (~${Math.ceil(effectiveReadThreshold / 4)} tokens ASCII-biased); static maxBytes 8KB unifies via policy.maxBytes; strict/blockUnboundedReturns restores fail-closed preflight`,
        detail: full ? "full" : "compact",
        summary,
        ...(full ? { runtime: getSummary("runtime"), session: getSummary("session"), lifetime: getSummary("lifetime") } : {}),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
        details: body,
      };
    },
  });

  // ================================================================
  // ce_exec tool (pre-flight validation gate)
  // ================================================================
  // Even though we now intercept fabric_exec directly via tool_call,
  // ce_exec remains useful as an explicit validation tool the model
  // can call to check a program before running it.

  pi.registerTool({
    name: "ce_exec",
    label: "ce_exec",
    description:
      "Validate a fabric_exec TypeScript program for context engineering compliance. " +
      "Programs that return raw tool results without processing are flagged. " +
      "Returns PASS/WARN/BLOCK with guidance. The fabric_exec tool itself is now " +
      "also intercepted automatically — this tool is for pre-checking.",
    parameters: Type.Object({
      program: Type.String({ description: "TypeScript program to validate." }),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const program = params.program as string;
      const cfg = configFor(execCtx.cwd);

      if (cfg.enabled === false) {
        throw new Error("context-engineer is disabled by config.");
      }

      const decision = evaluateProgram(program, cfg);

      if (decision.tier === "BLOCK") {
        return {
          // A BLOCK diagnostic is a successful validation, not an execution.
          content: [{ type: "text" as const, text: decision.guidance }],
          details: {
            tier: "BLOCK",
            blocked: true,
            hardBlock: decision.analysis.hardBlock,
            toolCalls: decision.analysis.metrics.toolCalls,
            rawReturn: decision.analysis.metrics.returnIsRawToolResult,
            returnTaint: decision.analysis.metrics.returnTaint,
            reductionRatio: decision.analysis.metrics.estimatedReductionRatio,
            provablyBounded: decision.analysis.metrics.provablyBounded,
            returnIsReduced: decision.analysis.metrics.returnIsReduced,
            transformationCount: decision.analysis.metrics.transformationCount,
            boundedSelectionCalls: decision.analysis.metrics.boundedSelectionCalls,
            hasProcessing: decision.analysis.metrics.hasProcessingBetweenToolAndReturn,
          },
        };
      }

      const message = decision.tier === "WARN"
        ? `Program passed analysis with a warning:\n${decision.guidance}\n\nSafe to run via fabric_exec.`
        : "Program passed context-engineering analysis. Safe to run via fabric_exec.";

      return {
        content: [{ type: "text" as const, text: message }],
        details: {
          blocked: false,
          tier: decision.tier,
          hardBlock: decision.analysis.hardBlock,
          toolCalls: decision.analysis.metrics.toolCalls,
          rawReturn: decision.analysis.metrics.returnIsRawToolResult,
          returnTaint: decision.analysis.metrics.returnTaint,
          reductionRatio: decision.analysis.metrics.estimatedReductionRatio,
          boundedSelectionCalls: decision.analysis.metrics.boundedSelectionCalls,
          hasProcessing: decision.analysis.metrics.hasProcessingBetweenToolAndReturn,
          estimatedReturnTokens: decision.analysis.metrics.estimatedReturnTokens,
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
          `Internal provider work: ${summary.internalTokensProcessed.toLocaleString()} tokens`,
          `Main tokens prevented: ${summary.mainTokensPrevented.toLocaleString()}`,
          `Main tokens injected: ${summary.mainTokensInjected.toLocaleString()}`,
          `Store tokens written: ${summary.storeTokensWritten.toLocaleString()}`,
          `Main context reduction: ${summary.mainTokensPrevented.toLocaleString()} tokens (${reduction})`,
          `Events: ${summary.events}`,
          ...(strategyLines.length > 0 ? ["", "By strategy:", ...strategyLines] : []),
          ...(summary.largest ? ["", `Largest Main-context prevention: ${summary.largest.tool} — ${summary.largest.mainTokensPrevented.toLocaleString()} tokens`] : []),
        ].join("\n");
      } else if (command === "trace") {
        const events = telemetry.recent(ctx.cwd, 20, allSessions);
        message = events.length === 0
          ? "No Context Engineer events recorded."
          : events.map((event) => `${event.timestamp.slice(11, 19)} ${event.strategy.padEnd(8)} ${event.tool} internal=${event.internalTokensProcessed} prevented=${event.mainTokensPrevented} injected=${event.mainTokensInjected} store=${event.storeTokensWritten}${event.note ? ` — ${event.note}` : ""}`).join("\n");
      } else if (command === "settings") {
        const cfg = configFor(ctx.cwd);
        message = JSON.stringify({
          enabled: cfg.enabled !== false,
          strict: cfg.strict ?? false,
          blockUnboundedReturns: cfg.strict === true || cfg.blockUnboundedReturns === true,
          maxReturnTokens: cfg.maxReturnTokens ?? 4000,
          readOffloadThreshold: effectiveOffloadThreshold(cfg),
          warnings: configWarningsFor(ctx.cwd),
          nestedResultThreshold: null, // Deprecated: Fabric owns internal transport limits.
          resultPolicy: normalizeResultPolicy(cfg.resultPolicy),
          errorCompactionThreshold: boundedNumber(cfg.errorCompactionThreshold, ERROR_COMPACTION_THRESHOLD, 256),
          errorCompactionPreviewBytes: boundedNumber(cfg.errorCompactionPreviewBytes, ERROR_COMPACTION_PREVIEW_BYTES, 256, 64_000),
          runtimeAdvisoryThreshold: cfg.runtimeAdvisoryThreshold ?? 0,
          offloadPreviewBytes: boundedNumber(cfg.offloadPreviewBytes, PREVIEW_BYTES, 256, 4096),
          compactStaleResults: false, // Legacy field: historical context is never rewritten.
          compactEditResults: cfg.compactEditResults !== false,
          notifyOnStart: cfg.notifyOnStart === true,
          storeMaxBytes: Math.min(MAX_CONTEXT_STORE_BYTES, cfg.storeMaxBytes ?? MAX_CONTEXT_STORE_BYTES),
          storeTtlMs: cfg.storeTtlMs ?? DEFAULT_CONTEXT_STORE_TTL_MS,
        }, null, 2);
      } else if (command === "explain") {
        const cfg = configFor(ctx.cwd);
        const effectiveReadThreshold = effectiveOffloadThreshold(cfg);
        message = [
          "Context Engineer is the context governor above Fabric and Fovea.",
          `The default runtime guard executes statically uncertain programs, keeps small results, and offloads actual ${effectiveReadThreshold}-byte+ boundary payloads (~${Math.ceil(effectiveReadThreshold / 4)} tokens ASCII-biased); policy.maxBytes unifies static/runtime byte budgets; resultPolicy controls inline/offload/summarize overrides.`,
          "Set strict=true or blockUnboundedReturns=true for fail-closed preflight. Explicit scalar projections, bounded selections, summaries, and offloads pass silently.",
          "Results are compacted before first exposure; already-exposed offload and ctx_read messages stay unchanged to preserve cacheable prefixes. Use Pi session compaction for accumulated history.",
          "ctx_status reports runtime/session/lifetime savings; ce_exec pre-checks a program. At the model boundary use ctx_read; inside fabric_exec use extensions.ctx_read.",
          "Use /ce status, /ce trace, /ce settings, or /ce status --all.",
        ].join("\n");
      } else if (command === "clear") {
        telemetry.clear(ctx.cwd);
        message = "Context Engineer telemetry cleared for this workspace.";
      } else {
        message = "Usage: /ce [status|trace|explain|settings|clear] [--all]";
      }

      ctx.ui.notify(message, "info");
    },
  });

  // ================================================================
  // Session lifecycle logging
  // ================================================================

  pi.on("session_start", async (_event, ctx) => {
    failedChildUsage.clear();
    fabricExecutions.clear();
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
