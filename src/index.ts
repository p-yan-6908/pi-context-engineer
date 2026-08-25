/**
 * pi-context-engineer — main extension entry point.
 *
 * Three enforcement layers using the real Pi ExtensionAPI:
 *
 * 1. fabric_exec interception (Fix 2)
 *    Hook `tool_call` for fabric_exec. Run the analyzer before execution.
 *    Warn and execute uncertain returns by default; strict mode blocks them.
 *
 * 2. grep auto-repair (Fix 1 → auto-repair, not block)
 *    Hook `tool_call` for grep. Detect regex patterns that will fail
 *    (unescaped parens, {} quantifiers, etc.). Auto-repair by setting
 *    `literal: true` or escaping the pattern. Mutate event.input in place.
 *
 * 3. result auto-offload (Fix 4)
 *    Hook `tool_result` for MODEL-BOUNDARY text results. If a result exceeds
 *    a threshold, offload to disk and replace content with a handle + preview.
 *    Intermediate values produced inside a running program are left untouched —
 *    rewriting them would feed the program the placeholder instead of data.
 *
 * Plus the standalone CE tools (ctx_read, ctx_summarize, etc.) for
 * the model to use directly.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ContextStore, DEFAULT_CONTEXT_STORE_TTL_MS, MAX_CONTEXT_STORE_BYTES } from "./store.js";
import { ceTools, type ToolContext } from "./tools.js";
import { evaluateProgram, runtimeAdvisoryLine, type WrapperOptions } from "./wrapper.js";
import { runChildPi } from "./child.js";
import { ContextTelemetry } from "./telemetry.js";
import { FabricExecutionScopes } from "./execution-scope.js";
import { readFabricToolResultProxy } from "./compat/fabric.js";

// ---- Config ----

interface CeConfig extends WrapperOptions {
  enabled?: boolean;
  /** UTF-8 bytes before text results are auto-offloaded. Default: 8192. */
  readOffloadThreshold?: number;
  /** fabric_exec boundary results at or above this size get a one-line
   *  advisory instead of silence. Default: 0 (disabled). */
  runtimeAdvisoryThreshold?: number;
  /** Compact addressable offload/ctx_read previews after one model call. Default: true. */
  compactStaleResults?: boolean;
  /** Show an activation notification at each session start. Default: false. */
  notifyOnStart?: boolean;
  /** Nested Fabric provider threshold. Defaults to readOffloadThreshold. */
  nestedResultThreshold?: number;
  /** UTF-8 preview bytes retained in an offload handle message. Default: 1024. */
  offloadPreviewBytes?: number;
  /** Optional maximum bytes retained by the context store. */
  storeMaxBytes?: number;
  /** Optional age limit for stored payloads. */
  storeTtlMs?: number;
}

function loadConfig(cwd: string): CeConfig {
  const configPath = resolve(cwd, ".pi", "context-engineer.json");
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as CeConfig;
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function serializeResult(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? String(value); }
  catch { return String(value); }
}

/**
 * Slim an object for the tool-result `details` channel. The full payload is
 * already serialized into content[0].text; duplicating bulky strings (head,
 * tail, sample, preview, ...) into details triples what the model context
 * sees for the same information.
 */
const BULKY_KEY = /^(head|tail|preview|content|sample|facts|summary|text|value|imports|signatures)$/;
function slimForDetails(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > 240 ? `${value.slice(0, 120)}… [+${value.length - 120} chars]` : value;
  }
  if (Array.isArray(value)) {
    return depth >= 2 ? `[${value.length} items]` : value.slice(0, 5).map((item) => slimForDetails(item, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth >= 2) return `object(${Object.keys(value).length} keys)`;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = BULKY_KEY.test(key) && typeof entry === "string" && entry.length > 240
        ? `[${entry.length} chars — see content]`
        : slimForDetails(entry, depth + 1);
    }
    return out;
  }
  return value;
}

function isProviderBounded(toolName: string, input: Record<string, unknown>, details: Record<string, unknown>, textLength: number): boolean {
  if (toolName === "fabric_exec") {
    const artifactKeys = ["artifact", "artifactPath", "outputArtifact", "fabricTruncated", "omittedChars", "originalChars"];
    if (artifactKeys.some((key) => key in details)) return true;
  }
  if (/^(?:fovea_|extensions\.fovea_)/.test(toolName)) {
    const maxTokens = typeof input.maxTokens === "number" ? input.maxTokens : undefined;
    if (maxTokens !== undefined && textLength <= maxTokens * 4) return true;
  }
  return false;
}

function inputHint(input: Record<string, unknown>): string {
  return String(input.path ?? input.pattern ?? input.command ?? input.code ?? input.query ?? "result");
}

function strategyForTool(toolName: string): "WRITE" | "SELECT" | "COMPRESS" | "ISOLATE" | "PASS" {
  if (/offload/.test(toolName)) return "WRITE";
  if (/read|grep|fovea|select|recall/.test(toolName)) return "SELECT";
  if (/summar|compress/.test(toolName)) return "COMPRESS";
  if (/delegat|agent/.test(toolName)) return "ISOLATE";
  return "PASS";
}

function utf8Preview(text: string, maxBytes: number): string {
  const raw = Buffer.from(text, "utf8");
  let end = Math.max(0, Math.min(raw.length, Math.floor(maxBytes)));
  while (end > 0 && (raw[end] & 0xc0) === 0x80) end--;
  return raw.subarray(0, end).toString("utf8");
}

function formatHandleText(id: string, bytes: number, estimatedTokens: number, text: string, previewBytes: number): string {
  const raw = Buffer.from(text, "utf8");
  const preview = utf8Preview(text, previewBytes);
  const truncated = raw.length > previewBytes;
  const handle =
    `[offloaded to handle "${id}" — ${bytes} bytes, ~${estimatedTokens} tokens]\n` +
    `Preview (first ${previewBytes} bytes):\n${preview}` +
    (truncated ? `\n... [${raw.length - previewBytes} more bytes — use extensions.ctx_read({ id: "${id}", offset: 0, length: 2048 }) to inspect; use query for a literal match]` : "");
  return handle;
}

interface AddressableContextResult {
  identity: string;
  handle: string;
  toolName: string;
  readOffset: number;
}

function addressableContextResult(message: unknown): AddressableContextResult | undefined {
  const record = asRecord(message);
  if (record?.role !== "toolResult") return undefined;
  const details = asRecord(record.details);
  const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
  let handle = typeof details?.ce_handle === "string" ? details.ce_handle : undefined;
  let readOffset = 0;
  if (!handle && toolName === "ctx_read") {
    const result = asRecord(details?.result);
    if (typeof result?.id === "string") handle = result.id;
    if (typeof result?.offset === "number" && Number.isFinite(result.offset)) readOffset = Math.max(0, result.offset);
  }
  if (!handle) return undefined;
  const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : handle;
  return { identity: `${toolCallId}:${handle}`, handle, toolName, readOffset };
}

function compactAddressableContextMessage<T>(
  message: T,
  exposed: Set<string>,
): { message: T; changed: boolean } {
  const addressable = addressableContextResult(message);
  if (!addressable) return { message, changed: false };
  if (!exposed.has(addressable.identity)) {
    exposed.add(addressable.identity);
    return { message, changed: false };
  }

  const record = message as unknown as Record<string, unknown>;
  const originalContent = Array.isArray(record.content) ? record.content : [];
  const nonText = originalContent.filter((item) => asRecord(item)?.type !== "text");
  const text = addressable.toolName === "ctx_read"
    ? `[ctx_read output compacted after use — source handle "${addressable.handle}" remains available; call extensions.ctx_read({ id: "${addressable.handle}", offset: ${addressable.readOffset}, length: 2048 }) or use a literal query to inspect again.]`
    : `[offloaded preview compacted after use — handle "${addressable.handle}"; call extensions.ctx_read({ id: "${addressable.handle}", offset: 0, length: 2048 }) to inspect again.]`;
  const compacted = {
    ...record,
    content: [{ type: "text", text }, ...nonText],
  } as unknown as T;
  return { message: compacted, changed: true };
}

// ---- Regex auto-repair (Fix 1) ----

/**
 * Detects and repairs regex patterns that will cause rg to fail.
 * Returns the repaired pattern and whether a repair was made.
 *
 * Common failures from the session:
 *   - Unescaped ( in alternation: hydrateCart( → hydrateCart\(
 *   - Unescaped ) at end: loadLocalCart( → loadLocalCart\(
 *   - {} interpreted as quantifier: state.cart = {}; → state\.cart\s*=\s*\{\};
 *
 * Strategy: repair only patterns that cannot compile as regular expressions.
 * JavaScript accepts some lone opening braces as literals while ripgrep treats
 * them as malformed quantifiers, so check rg-compatible brace forms too. Valid
 * regexes are left untouched: a wrongly literalized search fails silently with
 * plausible-looking zero-match results.
 */
function hasInvalidRipgrepBrace(pattern: string): boolean {
  let inCharacterClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "\\") {
      // Rust regex uses braces in Unicode/codepoint escapes such as \p{L} and
      // \x{41}; skip their complete escaped body as well as ordinary escapes.
      const escaped = pattern[index + 1];
      if ((escaped === "p" || escaped === "P" || escaped === "x") && pattern[index + 2] === "{") {
        const close = pattern.indexOf("}", index + 3);
        if (close >= 0) {
          index = close;
          continue;
        }
      }
      index++;
      continue;
    }
    if (char === "[" && !inCharacterClass) {
      inCharacterClass = true;
      continue;
    }
    if (char === "]" && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (char !== "{" || inCharacterClass) continue;

    const quantifier = pattern.slice(index).match(/^\{\d+(?:,\d*)?\}/)?.[0];
    if (!quantifier) return true;
    index += quantifier.length - 1;
  }
  return false;
}

export function isLikelyRegexParseError(pattern: string): boolean {
  try {
    new RegExp(pattern);
  } catch {
    return true;
  }
  return hasInvalidRipgrepBrace(pattern);
}

export function repairGrepInput(input: Record<string, unknown>): { repaired: boolean; reason: string } {
  const pattern = input.pattern as string | undefined;
  if (!pattern || typeof pattern !== "string") return { repaired: false, reason: "" };

  // If literal mode is already set, nothing to do.
  if (input.literal === true) return { repaired: false, reason: "" };

  if (!isLikelyRegexParseError(pattern)) return { repaired: false, reason: "" };

  // Auto-repair: set literal: true. This tells rg to treat the pattern as
  // a literal string, which is what the model intended when searching for
  // "clearCustomerSession(" or "state.cart = {};".
  input.literal = true;
  return {
    repaired: true,
    reason: `Pattern "${pattern.slice(0, 60)}" does not compile as a regular expression ` +
      "(unescaped special chars or malformed ripgrep quantifier braces). " +
      "Set literal=true to search for the literal text instead of a regex. " +
      "If you need regex, escape special chars: \\( \\) \\{ \\} \\[ \\].",
  };
}

// ---- Extension setup ----

export default function contextEngineer(pi: ExtensionAPI): void {
  const configCache = new Map<string, { mtimeMs: number; config: CeConfig }>();

  const configFor = (cwd: string): CeConfig => {
    const configPath = resolve(cwd, ".pi", "context-engineer.json");
    let mtimeMs = -1;
    try { mtimeMs = statSync(configPath).mtimeMs; } catch { /* no project config */ }
    const hit = configCache.get(cwd);
    if (hit?.mtimeMs === mtimeMs) return hit.config;
    const config = loadConfig(cwd);
    configCache.set(cwd, { mtimeMs, config });
    return config;
  };

  // Track parent executions by their stable toolCallId. Fabric-generated
  // nested IDs carry the documented `fabric_` prefix, so overlapping programs
  // can finish out of order without a shared depth counter misclassifying an
  // unrelated result.
  const fabricExecutions = new FabricExecutionScopes();
  const telemetry = new ContextTelemetry();
  const exposedAddressableResults = new Set<string>();

  const storeFor = (cwd: string, cfg: CeConfig): ContextStore => new ContextStore(
    cwd,
    ".pi/context-store",
    { maxBytes: cfg.storeMaxBytes, ttlMs: cfg.storeTtlMs },
  );

  // Addressable previews are useful on the first model call, but paying for
  // them on every later call wastes context. Context events receive a deep
  // copy, so this never rewrites session history or loses the stored payload.
  pi.on("context", async (event, ctx) => {
    const cfg = configFor(ctx.cwd);
    if (cfg.enabled === false || cfg.compactStaleResults === false) return undefined;

    let changed = false;
    const messages = event.messages.map((message) => {
      const compacted = compactAddressableContextMessage(message, exposedAddressableResults);
      changed ||= compacted.changed;
      return compacted.message;
    });
    return changed ? { messages } : undefined;
  });

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
  // Fix 1 (auto-repair): Intercept grep via tool_call hook
  // ================================================================
  //
  // Detect regex patterns that will cause rg parse errors and auto-repair
  // by setting literal: true. This prevents the "unclosed group" and
  // "repetition quantifier" errors seen in the session.

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "grep") return undefined;
    if (configFor(ctx.cwd).enabled === false) return undefined;

    const input = event.input as Record<string, unknown>;
    const repair = repairGrepInput(input);
    if (repair.repaired) {
      // We mutated event.input in place — Pi will use the repaired input.
      // No need to return anything; the mutation takes effect.
    }

    return undefined;
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

  const READ_OFFLOAD_THRESHOLD = 8192; // ~2K tokens
  const PREVIEW_BYTES = 1024;

  pi.on("tool_result", async (event, ctx) => {
    // Classify first: the fabric_exec result itself closes its own scope.
    // Nested Fabric IDs remain intermediate even when sibling executions are
    // active; ordinary non-prefixed calls stay model-boundary results.
    const isFabricExecResult = event.toolName === "fabric_exec";
    if (isFabricExecResult) fabricExecutions.finish(event.toolCallId);
    const fabricProxy = readFabricToolResultProxy(event.toolCallId, event.toolName, event.details);
    const isIntermediate = !isFabricExecResult && (
      fabricProxy !== undefined || fabricExecutions.isNestedToolResult(event.toolCallId)
    );

    if (isIntermediate && !fabricProxy) {
      // Leave ordinary intermediate Pi results byte-for-byte untouched: an
      // offload placeholder would corrupt the Fabric program's data. The
      // documented Fabric provider proxy is the exception; it is middleware
      // specifically intended to be replaced before QuickJS sees it.
      return undefined;
    }

    const cfg = configFor(ctx.cwd);
    if (cfg.enabled === false) return undefined;

    const threshold = cfg.readOffloadThreshold ?? READ_OFFLOAD_THRESHOLD;
    const existingDetails = (event.details ?? {}) as Record<string, unknown>;
    const input = (event.input ?? {}) as Record<string, unknown>;

    // Fabric exposes provider results through a documented proxy before its
    // QuickJS nested-result limit. Patch the structured proxy value itself so
    // the guest receives a handle, not merely a shortened display string.
    if (fabricProxy) {
      const serialized = serializeResult(fabricProxy.result);
      const nestedThreshold = cfg.nestedResultThreshold ?? threshold;
      const serializedBytes = Buffer.byteLength(serialized, "utf8");
      const providerBounded = isProviderBounded(event.toolName, input, existingDetails, serializedBytes);
      if (event.isError || providerBounded || serializedBytes < nestedThreshold) {
        if (serializedBytes >= 1024) {
          telemetry.record(ctx.cwd, {
            strategy: providerBounded ? strategyForTool(event.toolName) : "PASS",
            tool: event.toolName,
            sourceBytes: Buffer.byteLength(serialized, "utf8"),
            visibleBytes: Buffer.byteLength(serialized, "utf8"),
            internalTokensProcessed: Math.ceil(serializedBytes / 4),
            mainTokensPrevented: 0,
            mainTokensInjected: 0,
            provider: event.toolName.split(".")[0],
            note: providerBounded ? "provider-bounded nested result" : "nested result below CE threshold",
          });
        }
        return undefined;
      }

      const store = storeFor(ctx.cwd, cfg);
      const key = `fabric-${event.toolName}-${inputHint(input)}`.replace(/[^a-z0-9-]/gi, "-").slice(0, 64);
      const offloaded = store.write(key, event.toolName, serialized);
      const previewBytes = Math.max(256, Math.min(4096, cfg.offloadPreviewBytes ?? PREVIEW_BYTES));
      const replacement = {
        contextEngineerTruncated: true,
        handle: offloaded.id,
        originalBytes: offloaded.bytes,
        originalTokens: offloaded.estimatedTokens,
        preview: utf8Preview(serialized, previewBytes),
      };
      const nestedText = formatHandleText(offloaded.id, offloaded.bytes, offloaded.estimatedTokens, serialized, previewBytes);
      telemetry.record(ctx.cwd, {
        strategy: "WRITE",
        tool: event.toolName,
        sourceBytes: Buffer.byteLength(serialized, "utf8"),
        visibleBytes: Buffer.byteLength(nestedText, "utf8"),
        internalTokensProcessed: offloaded.estimatedTokens,
        mainTokensPrevented: 0,
        mainTokensInjected: 0,
        storeTokensWritten: offloaded.estimatedTokens,
        provider: event.toolName.split(".")[0],
        handle: offloaded.id,
        note: "nested Fabric provider result offloaded before QuickJS",
      });
      const content = event.content.some((item) => item.type === "text")
        ? event.content.map((item) => item.type === "text" ? { ...item, text: nestedText } : item)
        : [...event.content, { type: "text" as const, text: nestedText }];
      return {
        content,
        details: { ...existingDetails, result: replacement, ce_offloaded: true, ce_handle: offloaded.id },
      };
    }

    const textContent = event.content.find(
      (c): c is { type: "text"; text: string } => c.type === "text" && typeof (c as { text?: string }).text === "string"
    );

    if (!textContent) return undefined;

    const text = textContent.text;
    const alreadyOffloaded =
      existingDetails.ce_offloaded === true ||
      /^\[offloaded to handle "[^\"]+"/.test(text);
    const textBytes = Buffer.byteLength(text, "utf8");
    const providerBounded = isProviderBounded(event.toolName, input, existingDetails, textBytes);

    // Errors, small results, already-offloaded results, and provider-bounded
    // results are not rewritten; CE should not stack a second budget/artifact.

    // ctx_read caps its own output below the threshold (see tools.ts); letting
    // the hook rewrite it would chain handles recursively and make stored
    // payloads effectively unreachable.
    if (event.isError || alreadyOffloaded || providerBounded || event.toolName === "ctx_read" || textBytes < threshold) {
      if (textBytes >= 1024 && (providerBounded || event.toolName === "fabric_exec")) {
        telemetry.record(ctx.cwd, {
          strategy: providerBounded ? strategyForTool(event.toolName) : "PASS",
          tool: event.toolName,
          sourceBytes: Buffer.byteLength(text, "utf8"),
          visibleBytes: Buffer.byteLength(text, "utf8"),
          mainTokensPrevented: 0,
          mainTokensInjected: Math.ceil(textBytes / 4),
          note: providerBounded ? "provider-bounded final result" : "final result below CE threshold",
        });
      }
      // Runtime feedback loop: sub-threshold fabric_exec returns that are
      // still large can get an opt-in one-line advisory. This catches
      // "reduced but still heavy" returns without adding default noise.
      const advisoryThreshold = cfg.runtimeAdvisoryThreshold ?? 0;
      if (
        event.toolName === "fabric_exec" &&
        advisoryThreshold > 0 &&
        textBytes >= advisoryThreshold
      ) {
        const advisory = runtimeAdvisoryLine(textBytes);
        const content = event.content.map((item) =>
          item.type === "text" ? { ...item, text: item === textContent ? `${text}\n${advisory}` : item.text } : item
        );
        return { content, details: { ...existingDetails, ce_advisory: advisory } };
      }
      return undefined;
    }

    // Build a descriptive key from the tool + input.
    const key = `${event.toolName}-${inputHint(input)}`.replace(/[^a-z0-9-]/gi, "-").slice(0, 48);

    const store = storeFor(ctx.cwd, cfg);
    const offloaded = store.write(key, event.toolName, text);
    const previewBytes = Math.max(256, Math.min(4096, cfg.offloadPreviewBytes ?? PREVIEW_BYTES));
    const replacementText = formatHandleText(offloaded.id, offloaded.bytes, offloaded.estimatedTokens, text, previewBytes);
    telemetry.record(ctx.cwd, {
      strategy: "WRITE",
      tool: event.toolName,
      sourceBytes: Buffer.byteLength(text, "utf8"),
      visibleBytes: Buffer.byteLength(replacementText, "utf8"),
      mainTokensPrevented: Math.max(0, offloaded.estimatedTokens - Math.ceil(Buffer.byteLength(replacementText, "utf8") / 4)),
      mainTokensInjected: Math.ceil(Buffer.byteLength(replacementText, "utf8") / 4),
      storeTokensWritten: offloaded.estimatedTokens,
      handle: offloaded.id,
      note: "large final text result offloaded",
    });
    const content = event.content.map((item) =>
      item.type === "text" ? { ...item, text: item === textContent ? replacementText : item.text } : item
    );

    return {
      content,
      details: {
        ce_offloaded: true,
        ce_handle: offloaded.id,
        ce_original_bytes: offloaded.bytes,
        ce_original_tokens: offloaded.estimatedTokens,
        ce_saved_tokens: Math.max(0, offloaded.estimatedTokens - Math.ceil(replacementText.length / 4)),
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
                ? Type.Number({ description: schema.description })
                : Type.Any({ description: schema.description });
            const required = (def.inputSchema.required as string[] | undefined)?.includes(k) ?? false;
            return [k, required ? property : Type.Optional(property)];
          })
        )
      ),
      async execute(_id, params, _signal, _onUpdate, execCtx) {
        const currentModel = execCtx.model
          ? `${execCtx.model.provider}/${execCtx.model.id}`
          : undefined;
        const toolConfig = configFor(execCtx.cwd);
        const toolCtx: ToolContext = {
          store: storeFor(execCtx.cwd, toolConfig),
          workspaceRoot: execCtx.cwd,
          maxReturnBytes: toolConfig.readOffloadThreshold ?? READ_OFFLOAD_THRESHOLD,
          callTool: async () => {
            throw new Error("callTool is only available inside a Fabric program; use pi.* or extensions.* there.");
          },
          spawnAgent: (prompt, opts) => runChildPi(prompt, {
            cwd: execCtx.cwd,
            model: opts?.model ?? currentModel,
            timeoutMs: opts?.timeoutMs ?? 90_000,
          }),
          modelCall: (prompt, _maxTokens) => runChildPi(prompt, {
            cwd: execCtx.cwd,
            model: currentModel,
            noTools: true,
            timeoutMs: 90_000,
          }),
        };

        try {
          const result = await def.handler(params, toolCtx);
          const serialized = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          const resultRecord = result && typeof result === "object" ? result as Record<string, unknown> : undefined;
          const sourceTokens = [resultRecord?.originalTokens, resultRecord?.totalTokens, resultRecord?.resultTokens]
            .find((value): value is number => typeof value === "number" && Number.isFinite(value));
          telemetry.record(execCtx.cwd, {
            strategy: strategyForTool(def.name),
            tool: def.name,
            sourceTokens: sourceTokens ?? Math.ceil(serialized.length / 4),
            visibleBytes: Buffer.byteLength(serialized, "utf8"),
            note: "CE helper result",
          });
          return {
            content: [{ type: "text" as const, text: serialized }],
            details: { tool: def.name, result: typeof result === "string" ? undefined : slimForDetails(result) },
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Tool ${def.name} failed: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
            details: { tool: def.name, error: true },
          };
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
      if (!payload) {
        return {
          content: [{ type: "text" as const, text: "ctx_offload requires a payload: extensions.ctx_offload({ key, source, data }) — data accepts text/content aliases." }],
          isError: true,
          details: { tool: "ctx_offload", error: true },
        };
      }
      const store = storeFor(execCtx.cwd, configFor(execCtx.cwd));
      const result = store.write(
        params.key as string,
        ((params.source as string) ?? "manual"),
        payload
      );
      const visibleText = `Offloaded ${result.bytes} bytes (~${result.estimatedTokens} tokens) to handle "${result.id}".\nPreview:\n${result.preview}`;
      const visibleBytes = Buffer.byteLength(visibleText, "utf8");
      telemetry.record(execCtx.cwd, {
        strategy: "WRITE",
        tool: "ctx_offload",
        sourceBytes: result.bytes,
        visibleBytes,
        mainTokensPrevented: Math.max(0, result.estimatedTokens - Math.ceil(visibleBytes / 4)),
        mainTokensInjected: Math.ceil(visibleBytes / 4),
        storeTokensWritten: result.estimatedTokens,
        handle: result.id,
        note: "manual context offload",
      });
      return {
        content: [{
          type: "text" as const,
          text: visibleText,
        }],
        details: { id: result.id, bytes: result.bytes, estimatedTokens: result.estimatedTokens },
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
      "Report context-engineer policy state: enabled, strict mode, offload/advisory thresholds, " +
      "and token savings so far. Call this instead of guessing why a program was blocked.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, execCtx) {
      const cfg = configFor(execCtx.cwd);
      const summary = telemetry.summary(execCtx.cwd, false);
      const effectiveReadThreshold = cfg.readOffloadThreshold ?? READ_OFFLOAD_THRESHOLD;
      const body = {
        enabled: cfg.enabled !== false,
        strict: cfg.strict ?? false,
        readOffloadThreshold: effectiveReadThreshold,
        runtimeAdvisoryThreshold: cfg.runtimeAdvisoryThreshold ?? 0,
        blockUnboundedReturns: cfg.strict === true || cfg.blockUnboundedReturns === true,
        compactStaleResults: cfg.compactStaleResults !== false,
        notifyOnStart: cfg.notifyOnStart === true,
        offloadPreviewBytes: Math.max(256, Math.min(4096, cfg.offloadPreviewBytes ?? PREVIEW_BYTES)),
        storeTtlMs: cfg.storeTtlMs ?? DEFAULT_CONTEXT_STORE_TTL_MS,
        storeMaxBytes: Math.min(MAX_CONTEXT_STORE_BYTES, cfg.storeMaxBytes ?? MAX_CONTEXT_STORE_BYTES),
        maxReturnTokens: cfg.maxReturnTokens ?? 4000,
        policy: `runtime guard executes uncertain programs and auto-offloads actual ${effectiveReadThreshold}-byte+ boundary results; strict/blockUnboundedReturns restores fail-closed preflight; stale addressable previews compact after first use`,
        session: summary,
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
        return {
          content: [{ type: "text" as const, text: "context-engineer is disabled by config." }],
          isError: true,
          details: { disabled: true },
        };
      }

      const decision = evaluateProgram(program, cfg);

      if (decision.tier === "BLOCK") {
        return {
          content: [{ type: "text" as const, text: decision.guidance }],
          isError: true,
          details: {
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
          readOffloadThreshold: cfg.readOffloadThreshold ?? READ_OFFLOAD_THRESHOLD,
          nestedResultThreshold: cfg.nestedResultThreshold ?? cfg.readOffloadThreshold ?? READ_OFFLOAD_THRESHOLD,
          runtimeAdvisoryThreshold: cfg.runtimeAdvisoryThreshold ?? 0,
          offloadPreviewBytes: Math.max(256, Math.min(4096, cfg.offloadPreviewBytes ?? PREVIEW_BYTES)),
          compactStaleResults: cfg.compactStaleResults !== false,
          notifyOnStart: cfg.notifyOnStart === true,
          storeMaxBytes: Math.min(MAX_CONTEXT_STORE_BYTES, cfg.storeMaxBytes ?? MAX_CONTEXT_STORE_BYTES),
          storeTtlMs: cfg.storeTtlMs ?? DEFAULT_CONTEXT_STORE_TTL_MS,
        }, null, 2);
      } else if (command === "explain") {
        const cfg = configFor(ctx.cwd);
        const effectiveReadThreshold = cfg.readOffloadThreshold ?? READ_OFFLOAD_THRESHOLD;
        message = [
          "Context Engineer is the context governor above Fabric and Fovea.",
          `The default runtime guard executes statically uncertain programs, keeps small results, and offloads actual ${effectiveReadThreshold}-byte+ boundary payloads.`,
          "Set strict=true or blockUnboundedReturns=true for fail-closed preflight. Explicit scalar projections, bounded selections, summaries, and offloads pass silently.",
          "Addressable offload and ctx_read previews stay visible for one model call, then compact to a re-readable handle reference.",
          "extensions.ctx_status reports thresholds and savings; extensions.ce_exec pre-checks a program.",
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
    fabricExecutions.clear();
    exposedAddressableResults.clear();
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
