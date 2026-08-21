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
 *    Hook `tool_result` for text results. If a result exceeds a threshold,
 *    offload to disk and replace content with a handle + preview.
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
import { evaluateProgram, type WrapperOptions } from "./wrapper.js";
import { runChildPi } from "./child.js";

// ---- Config ----

interface CeConfig extends WrapperOptions {
  enabled?: boolean;
  /** Max bytes before text results are auto-offloaded. Default: 8192. */
  readOffloadThreshold?: number;
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
 * Strategy: if the pattern contains regex special chars that are likely
 * meant as literals (parens, braces, etc. in non-regex contexts), set
 * literal: true instead of trying to escape each char. This is safer and
 * matches what the model was trying to do — search for literal text.
 */
export function repairGrepInput(input: Record<string, unknown>): { repaired: boolean; reason: string } {
  const pattern = input.pattern as string | undefined;
  if (!pattern || typeof pattern !== "string") return { repaired: false, reason: "" };

  // If literal mode is already set, nothing to do.
  if (input.literal === true) return { repaired: false, reason: "" };

  // Detect patterns that are likely to cause regex parse errors.
  // These are patterns where the model is searching for code snippets
  // (function names with parens, object assignments with braces, etc.)
  // but forgot to escape the regex special chars.
  const dangerousPatterns = [
    // Unescaped ( not followed by ?: or a valid group — e.g. "foo(" or "foo(bar"
    // Also matches ( at end of string or start of string.
    /(^|[^\\])\((?:[^?]|$)/,
    // Unescaped ) at end or before | — e.g. "foo)" or "foo)|bar"
    /(^|[^\\])\)(?:\||$)/,
    // Unescaped { not part of a quantifier — e.g. "{}" or "= {};"
    /(^|[^\\])\{[^0-9]/,
    // Unescaped [ that doesn't start a character class properly
    /(^|[^\\])\[[^\]\^]/,
  ];

  const isDangerous = dangerousPatterns.some((p) => p.test(pattern));
  if (!isDangerous) return { repaired: false, reason: "" };

  // Auto-repair: set literal: true. This tells rg to treat the pattern as
  // a literal string, which is what the model intended when searching for
  // "clearCustomerSession(" or "state.cart = {};".
  input.literal = true;
  return {
    repaired: true,
    reason: `Pattern "${pattern.slice(0, 60)}" contains unescaped regex special chars. ` +
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
      return {
        block: true,
        reason: decision.guidance,
      };
    }

    if (decision.tier === "WARN") {
      pendingWarnings.set(event.toolCallId, decision.guidance);
    }

    // PASS and WARN both execute; WARN is annotated in the tool_result hook.
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
  const PREVIEW_BYTES = 2048;

  pi.on("tool_result", async (event, ctx) => {
    const warning = pendingWarnings.get(event.toolCallId);
    if (warning) pendingWarnings.delete(event.toolCallId);

    const cfg = configFor(ctx.cwd);
    if (cfg.enabled === false) return undefined;

    const threshold = cfg.readOffloadThreshold ?? READ_OFFLOAD_THRESHOLD;
    const existingDetails = (event.details ?? {}) as Record<string, unknown>;
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

    // Errors, small results, and already-offloaded results are not rewritten;
    // they may still receive a pending analyzer warning.
    if (event.isError || alreadyOffloaded || text.length < threshold) {
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
    const input = event.input as Record<string, unknown>;
    const pathHint = (input.path as string) || (input.pattern as string) || (input.command as string) || (input.code as string) || "result";
    const key = `${event.toolName}-${pathHint}`.replace(/[^a-z0-9-]/gi, "-").slice(0, 48);

    const store = new ContextStore(ctx.cwd);
    const offloaded = store.write(key, event.toolName, text);
    const preview = text.slice(0, PREVIEW_BYTES);
    const truncated = text.length > PREVIEW_BYTES;
    const handleText =
      `[offloaded to handle "${offloaded.id}" — ${offloaded.bytes} bytes, ~${offloaded.estimatedTokens} tokens]\n` +
      `Preview (first ${PREVIEW_BYTES} bytes):\n${preview}` +
      (truncated ? `\n... [${text.length - PREVIEW_BYTES} more bytes — use ctx_read with id "${offloaded.id}" to inspect]` : "");
    const replacementText = warning ? `${warning}\n\n${handleText}` : handleText;
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
        const toolCtx: ToolContext = {
          store: new ContextStore(execCtx.cwd),
          workspaceRoot: execCtx.cwd,
          callTool: async () => {
            throw new Error("callTool is only available inside a Fabric program; use pi.* or extensions.* there.");
          },
          spawnAgent: (prompt, opts) => runChildPi(prompt, {
            cwd: execCtx.cwd,
            model: opts?.model ?? currentModel,
            timeoutMs: 180_000,
          }),
          modelCall: (prompt) => runChildPi(prompt, {
            cwd: execCtx.cwd,
            model: currentModel,
            noTools: true,
            timeoutMs: 120_000,
          }),
        };

        try {
          const result = await def.handler(params, toolCtx);
          return {
            content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
            details: { tool: def.name, result: typeof result === "string" ? undefined : result },
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
      "The data stays out of context. Use ctx_read to inspect slices later.",
    parameters: Type.Object({
      key: Type.String({ description: "Human-readable label for the data." }),
      source: Type.String({ description: "What produced this data (e.g. 'grep', 'read', 'bash')." }),
      data: Type.String({ description: "The full payload to offload." }),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const store = new ContextStore(execCtx.cwd);
      const result = store.write(
        params.key as string,
        params.source as string,
        params.data as string
      );
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
            toolCalls: decision.analysis.metrics.toolCalls,
            rawReturn: decision.analysis.metrics.returnIsRawToolResult,
            hasProcessing: decision.analysis.metrics.hasProcessingBetweenToolAndReturn,
          },
        };
      }

      const message = decision.tier === "WARN"
        ? `⚠️ Program passed analysis with a warning:\n${decision.guidance}\n\n✅ Safe to run via fabric_exec.`
        : "✅ Program passed context-engineering analysis. Safe to run via fabric_exec.";

      return {
        content: [{ type: "text" as const, text: message }],
        details: {
          blocked: false,
          tier: decision.tier,
          toolCalls: decision.analysis.metrics.toolCalls,
          rawReturn: decision.analysis.metrics.returnIsRawToolResult,
          hasProcessing: decision.analysis.metrics.hasProcessingBetweenToolAndReturn,
          estimatedReturnTokens: decision.analysis.metrics.estimatedReturnTokens,
        },
      };
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
        "context-engineer: active — fabric_exec interception, grep auto-repair, read auto-offload",
        "info"
      );
    }
  });
}
