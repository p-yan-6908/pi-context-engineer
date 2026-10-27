/*
 * Optional pi-fabric compatibility.
 *
 * Context Engineer can run without Fabric installed, so this module loads
 * Fabric's protocol constants opportunistically and falls back to their
 * documented values. All Fabric-specific knowledge stays here.
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";

interface FabricProtocolModule {
  FABRIC_NESTED_TOOL_CALL_ID_PREFIX?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

async function loadProtocolModule(): Promise<FabricProtocolModule | undefined> {
  for (const specifier of ["pi-fabric/protocol", "pi-fabric"]) {
    try {
      const loaded = await import(specifier) as unknown;
      return (asRecord(asRecord(loaded)?.default) ?? asRecord(loaded)) as FabricProtocolModule | undefined;
    } catch {
      // Fabric is an optional peer; continue to the fallback when absent or old.
    }
  }
  return undefined;
}

const protocol = await loadProtocolModule();
export const FABRIC_NESTED_TOOL_CALL_ID_PREFIX = typeof protocol?.FABRIC_NESTED_TOOL_CALL_ID_PREFIX === "string"
  ? protocol.FABRIC_NESTED_TOOL_CALL_ID_PREFIX
  : "fabric_";

// PI_FABRIC_DEPTH is part of Fabric's documented child environment contract;
// the allowlist variable is internal, so its use stays in this module.
const FABRIC_DEPTH_ENV = "PI_FABRIC_DEPTH";
const FABRIC_TOOL_ALLOWLIST_ENV = "PI_FABRIC_TOOL_ALLOWLIST";
const FABRIC_EXEC_TOOL = "fabric_exec";
export const FABRIC_CONTEXT_READ_TOOL = "ctx_read";

/** Fabric's allowlist matching: exact names, or `*` wildcards. */
function allowlistPermits(entries: readonly string[], name: string): boolean {
  return entries.some(entry => entry.includes("*")
    ? new RegExp(`^${entry.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s").test(name)
    : entry === name);
}

/**
 * Fabric's child allowlist is intentionally fail-closed. When CE is enabled,
 * however, an extension-enabled child must be able to recover an input that
 * CE offloaded at the model boundary. This is the narrow, read-only CE
 * exception; other optional CE/Fovea tools remain governed by Fabric. Fabric
 * creates its runtime lazily, so this runs during extension setup before the
 * child-side captured provider is constructed. The parent-side allowlist is
 * not changed. Every extension-enabled descendant that loads CE repeats this.
 *
 * The grant follows Fabric's own `agents.childQuestionTools` rule: it is
 * skipped for an explicit empty `tools` list and for `+name`/`-name` lists.
 * A malformed allowlist fails closed, as it does in Fabric.
 *
 * Returns whether nested `extensions.ctx_read` is permitted afterwards; CE
 * must not offload to a handle this process cannot read back.
 */
export function enableFabricContextReadForChild(enabled: boolean): boolean {
  if (!(Number(process.env[FABRIC_DEPTH_ENV]) > 0)) return true;

  const raw = process.env[FABRIC_TOOL_ALLOWLIST_ENV];
  if (raw === undefined) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || !parsed.every((name): name is string => typeof name === "string")) return false;
  if (allowlistPermits(parsed, FABRIC_CONTEXT_READ_TOOL)) return true;

  const requested = parsed.filter(name => name !== FABRIC_EXEC_TOOL);
  if (!enabled || requested.length === 0 || requested.some(name => name.startsWith("+") || name.startsWith("-"))) return false;

  process.env[FABRIC_TOOL_ALLOWLIST_ENV] = JSON.stringify([
    ...parsed,
    FABRIC_CONTEXT_READ_TOOL,
  ]);
  return true;
}

/** Fabric's notice after a final output it truncated: the artifact holds every character. */
const FABRIC_FULL_OUTPUT_NOTICE = /\n\n\[Full output \((\d+) chars\) saved to: ([^\n\]]+)\]$/;
const FABRIC_OUTPUT_SCRATCH_PREFIX = "pi-fabric-output-";
const MAX_FABRIC_FULL_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The visible Fabric result claims a complete output exists in a scratch artifact. */
export function hasFabricFullOutputNotice(text: string): boolean {
  return FABRIC_FULL_OUTPUT_NOTICE.test(text);
}

/**
 * The complete text behind a fabric_exec result that Fabric truncated, read
 * from its output artifact. Fabric marks that scratch directory for cleanup
 * as soon as it writes it, so this must run when the result arrives.
 *
 * The notice is program output, so only a regular file named output.txt in a
 * Fabric output scratch directory directly under the temp root, whose length
 * matches the notice, is accepted. Anything else returns undefined and the
 * visible text is stored as before.
 */
export function readFabricFullOutput(text: string, tempRoot = tmpdir()): string | undefined {
  const match = FABRIC_FULL_OUTPUT_NOTICE.exec(text);
  if (!match) return undefined;
  const [, chars, artifact] = match;
  const scratch = dirname(artifact);
  if (!isAbsolute(artifact) || resolve(artifact) !== artifact || basename(artifact) !== "output.txt" ||
    !basename(scratch).startsWith(FABRIC_OUTPUT_SCRATCH_PREFIX)) return undefined;
  try {
    if (dirname(scratch) !== tempRoot && dirname(scratch) !== realpathSync(tempRoot)) return undefined;
    const stat = lstatSync(artifact);
    if (!stat.isFile() || stat.size > MAX_FABRIC_FULL_OUTPUT_BYTES) return undefined;
    const full = readFileSync(artifact, "utf8");
    return full.length === Number(chars) ? full : undefined;
  } catch {
    return undefined;
  }
}
