/**
 * pi-context-engineer — main extension entry point.
 *
 * Three enforcement layers using the real Pi ExtensionAPI:
 *
 * 1. fabric_exec interception (Fix 2)
 *    Hook `tool_call` for fabric_exec. Run the analyzer before execution.
 *    Block passthroughs; let clean programs through.
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

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ContextStore } from "./store.js";
import { ceTools, type ToolContext } from "./tools.js";
import { evaluateProgram, runtimeAdvisoryLine, type WrapperOptions } from "./wrapper.js";
import { runChildPi } from "./child.js";
import { ContextTelemetry } from "./telemetry.js";

// ---- Config ----

interface CeConfig extends WrapperOptions {
  enabled?: boolean;
  /** UTF-8 bytes before text results are auto-offloaded. Default: 8192. */
  readOffloadThreshold?: number;
  /** fabric_exec boundary results at or above this size get a one-line
   *  advisory instead of silence. Default: 4096. Set to 0 to disable. */
  runtimeAdvisoryThreshold?: number;
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

interface FabricProxyResult {
  kind: "pi-fabric.tool-result-proxy.v1";
  ref: string;
  result: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

/** Avoid a hard dependency while still consuming Fabric's documented proxy envelope. */
function readFabricProxy(toolCallId: string, toolName: string, details: unknown): FabricProxyResult | undefined {
  if (!toolCallId.startsWith("fabric_")) return undefined;
  const record = asRecord(details);
  if (record?.kind !== "pi-fabric.tool-result-proxy.v1" || record.ref !== toolName || !("result" in record)) return undefined;
  return record as unknown as FabricProxyResult;
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

function formatHandleText(id: string, bytes: number, estimatedTokens: number, text: string, previewBytes: number, warning?: string): string {
  const raw = Buffer.from(text, "utf8");
  const preview = raw.subarray(0, previewBytes).toString("utf8");
  const truncated = raw.length > previewBytes;
  const handle =
    `[offloaded to handle "${id}" — ${bytes} bytes, ~${estimatedTokens} tokens]\n` +
    `Preview (first ${previewBytes} bytes):\n${preview}` +
    (truncated ? `\n... [${raw.length - previewBytes} more bytes — use extensions.ctx_read({ id: "${id}", offset: 0, length: 2048 }) to inspect; use query for a literal match]` : "");
  return warning ? `${warning}\n\n${handle}` : handle;
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
 * Strategy: repair only patterns that cannot compile as regular expressions
 * (plus the {} edge case, which JS accepts as a literal but rg rejects as a
 * quantifier). Valid regexes are left untouched: a failed rg parse is loud
 * feedback the model can act on, while a wrongly literalized search fails
 * silently with plausible-looking zero-match results.
 */
export function isLikelyRegexParseError(pattern: string): boolean {
  try {
    new RegExp(pattern);
  } catch {
    return true;
  }
  return /(^|[^\\])\{\}/.test(pattern);
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
      "(unescaped special chars or empty {} quantifier braces). " +
      "Set literal=true to search for the literal text instead of a regex. " +
      "If you need regex, escape special chars: \\( \\) \\{ \\} \\[ \\].",
  };
}

// ---- Extension setup ----

export default function contextEngineer(pi: ExtensionAPI): void {
  const configCache = new Map<string, CeConfig>();

  const configFor = (cwd: string): CeConfig => {
    const hit = configCache.get(cwd);
    if (hit) return hit;
    const cfg = loadConfig(cwd);
    configCache.set(cwd, cfg);
    return cfg;
  };

  // WARN decisions are attached to the corresponding tool result.
  const pendingWarnings = new Map<string, string>();

  // Number of fabric_exec programs currently executing. A tool_result that
  // arrives while this is > 0 (and is not the fabric_exec result itself) is an
  // INTERMEDIATE value consumed by program code — never rewritten, because the
  // program would receive the placeholder/handle text instead of real data.
  let fabricExecDepth = 0;
  const telemetry = new ContextTelemetry();

  const storeFor = (cwd: string, cfg: CeConfig): ContextStore => new ContextStore(
    cwd,
    ".pi/context-store",
    { maxBytes: cfg.storeMaxBytes, ttlMs: cfg.storeTtlMs },
  );

  // ================================================================
  // Fix 2: Intercept fabric_exec via tool_call hook
  // ================================================================
  //
  // This is the primary enforcement. When the model calls fabric_exec,
  // we intercept the program BEFORE it runs. If the analyzer detects a
  // passthrough (raw tool result returned with no processing), we block
  // execution and return guidance.

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
        note: decision.analysis.reasons[0] ?? "static policy block",
      });
      return {
        block: true,
        reason: decision.guidance,
      };
    }

    if (decision.tier === "WARN") {
      pendingWarnings.set(event.toolCallId, decision.guidance);
    }

    // PASS and WARN both execute; track the execution so tool_result can tell
    // model-boundary results apart from intermediate ones. BLOCK does not
    // execute, so it must not increment.
    fabricExecDepth++;

    // WARN is annotated in the tool_result hook.
    return undefined;
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
    // Classify first: the fabric_exec result itself closes a program execution;
    // anything else arriving while one is running is an intermediate value.
    const isFabricExecResult = event.toolName === "fabric_exec";
    if (isFabricExecResult) fabricExecDepth = Math.max(0, fabricExecDepth - 1);
    const fabricProxy = readFabricProxy(event.toolCallId, event.toolName, event.details);
    const isIntermediate = !isFabricExecResult && fabricExecDepth > 0;

    const warning = pendingWarnings.get(event.toolCallId);
    if (warning) pendingWarnings.delete(event.toolCallId);

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
        preview: Buffer.from(serialized, "utf8").subarray(0, previewBytes).toString("utf8"),
      };
      const nestedText = formatHandleText(offloaded.id, offloaded.bytes, offloaded.estimatedTokens, serialized, previewBytes, warning);
      telemetry.record(ctx.cwd, {
        strategy: "WRITE",
        tool: event.toolName,
        sourceBytes: Buffer.byteLength(serialized, "utf8"),
        visibleBytes: Buffer.byteLength(nestedText, "utf8"),
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

    if (!textContent) {
      return warning ? { details: { ...existingDetails, ce_warning: warning } } : undefined;
    }

    const text = textContent.text;
    const alreadyOffloaded =
      existingDetails.ce_offloaded === true ||
      /^\[offloaded to handle "[^\"]+"/.test(text);
    const textBytes = Buffer.byteLength(text, "utf8");
    const providerBounded = isProviderBounded(event.toolName, input, existingDetails, textBytes);

    // Errors, small results, already-offloaded results, and provider-bounded
    // results are not rewritten; CE should not stack a second budget/artifact.

    // they may still receive a pending analyzer warning.
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
          note: providerBounded ? "provider-bounded final result" : "final result below CE threshold",
        });
      }
      // Runtime feedback loop: sub-threshold fabric_exec returns that are
      // still large get a one-line advisory instead of silence. The static
      // gate only blocks direct passthroughs; this catches "reduced but
      // still heavy" returns so the model can adjust on its next program.
      if (
        !warning &&
        event.toolName === "fabric_exec" &&
        textBytes >= (cfg.runtimeAdvisoryThreshold ?? 4096)
      ) {
        const advisory = runtimeAdvisoryLine(textBytes);
        const content = event.content.map((item) =>
          item.type === "text" ? { ...item, text: item === textContent ? `${text}\n${advisory}` : item.text } : item
        );
        return { content, details: { ...existingDetails, ce_advisory: advisory } };
      }
      if (!warning) return undefined;
      const replacementText = `${warning}\n\n${text}`;
      const content = event.content.map((item) =>
        item.type === "text" ? { ...item, text: item === textContent ? replacementText : item.text } : item
      );
      return {
        content,
        details: { ...existingDetails, ce_warning: warning },
      };
    }

    // Build a descriptive key from the tool + input.
    const key = `${event.toolName}-${inputHint(input)}`.replace(/[^a-z0-9-]/gi, "-").slice(0, 48);

    const store = storeFor(ctx.cwd, cfg);
    const offloaded = store.write(key, event.toolName, text);
    const previewBytes = Math.max(256, Math.min(4096, cfg.offloadPreviewBytes ?? PREVIEW_BYTES));
    const replacementText = formatHandleText(offloaded.id, offloaded.bytes, offloaded.estimatedTokens, text, previewBytes, warning);
    telemetry.record(ctx.cwd, {
      strategy: "WRITE",
      tool: event.toolName,
      sourceBytes: Buffer.byteLength(text, "utf8"),
      visibleBytes: Buffer.byteLength(replacementText, "utf8"),
      handle: offloaded.id,
      note: "large final text result offloaded",
    });
    const content = event.content.map((item) =>
      item.type === "text" ? { ...item, text: item === textContent ? replacementText : item.text } : item
    );

    return {
      content,
      details: {
        ...(warning ? { ce_warning: warning } : {}),
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
            timeoutMs: 180_000,
          }),
          modelCall: (prompt, _maxTokens) => runChildPi(prompt, {
            cwd: execCtx.cwd,
            model: currentModel,
            noTools: true,
            timeoutMs: 120_000,
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
      telemetry.record(execCtx.cwd, {
        strategy: "WRITE",
        tool: "ctx_offload",
        sourceBytes: result.bytes,
        visibleBytes: Buffer.byteLength(result.preview, "utf8"),
        handle: result.id,
        note: "manual context offload",
      });
      return {
        content: [{
          type: "text" as const,
          text: `Offloaded ${result.bytes} bytes (~${result.estimatedTokens} tokens) to handle "${result.id}".\nPreview:\n${result.preview}`,
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
      const body = {
        enabled: cfg.enabled !== false,
        strict: cfg.strict ?? false,
        readOffloadThreshold: cfg.readOffloadThreshold ?? READ_OFFLOAD_THRESHOLD,
        runtimeAdvisoryThreshold: cfg.runtimeAdvisoryThreshold ?? 4096,
        offloadPreviewBytes: Math.max(256, Math.min(4096, cfg.offloadPreviewBytes ?? PREVIEW_BYTES)),
        maxReturnTokens: cfg.maxReturnTokens ?? 4000,
        policy: "blocks direct raw-tool passthroughs; reduced returns warn; 4KB+ advisory; 8KB+ auto-offload; previews are independently bounded",
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
          .sort(([, left], [, right]) => right.savedTokens - left.savedTokens)
          .map(([name, bucket]) => `  ${name.padEnd(8)} ${bucket.savedTokens.toLocaleString()} saved tokens (${bucket.events} event${bucket.events === 1 ? "" : "s"})`);
        message = [
          `Context Engineer${allSessions ? " (all sessions)" : " (current session)"}`,
          `Observed source: ${summary.sourceTokens.toLocaleString()} tokens`,
          `Visible to model: ${summary.visibleTokens.toLocaleString()} tokens`,
          `Main context saved: ${summary.savedTokens.toLocaleString()} tokens (${reduction})`,
          `Events: ${summary.events}`,
          ...(strategyLines.length > 0 ? ["", "By strategy:", ...strategyLines] : []),
          ...(summary.largest ? ["", `Largest saving: ${summary.largest.tool} — ${summary.largest.savedTokens.toLocaleString()} tokens`] : []),
        ].join("\n");
      } else if (command === "trace") {
        const events = telemetry.recent(ctx.cwd, 20, allSessions);
        message = events.length === 0
          ? "No Context Engineer events recorded."
          : events.map((event) => `${event.timestamp.slice(11, 19)} ${event.strategy.padEnd(8)} ${event.tool} source=${event.sourceTokens} visible=${event.visibleTokens} saved=${event.savedTokens}${event.note ? ` — ${event.note}` : ""}`).join("\n");
      } else if (command === "settings") {
        message = JSON.stringify(configFor(ctx.cwd), null, 2);
      } else if (command === "explain") {
        message = [
          "Context Engineer is the context governor above Fabric and Fovea.",
          "The gate hard-blocks only DIRECT raw-tool passthroughs (zero transformation).",
          "Tainted-but-reduced returns run with an advisory; results of 4KB+ get a one-line nudge, 8KB+ are auto-offloaded.",
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
    const cfg = configFor(ctx.cwd);
    if (cfg.enabled === false) return;
    if (ctx.hasUI) {
      ctx.ui.notify(
        "context-engineer: active — taint gate, nested Fabric guard, Fovea-aware budgets, /ce status",
        "info"
      );
    }
  });
}
