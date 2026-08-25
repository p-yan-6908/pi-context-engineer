/*
 * Optional pi-fabric compatibility.
 *
 * Context Engineer can run without Fabric installed, so this module loads the
 * protocol helpers opportunistically and keeps the documented v1 envelope as
 * a compatibility fallback. All Fabric-specific knowledge stays here.
 */

export interface FabricToolResultProxy {
  kind: "pi-fabric.tool-result-proxy.v1";
  ref: string;
  result: unknown;
}

interface FabricProtocolModule {
  FABRIC_NESTED_TOOL_CALL_ID_PREFIX?: unknown;
  readFabricToolResultProxyDetailsV1?: (details: unknown) => unknown;
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

/**
 * Normalize a nested Fabric result proxy before QuickJS sees it. The official
 * parser is preferred when available; the exact v1 envelope remains supported
 * for standalone Pi and older Fabric installations.
 */
export function readFabricToolResultProxy(
  toolCallId: string,
  toolName: string,
  details: unknown,
): FabricToolResultProxy | undefined {
  if (!toolCallId.startsWith(FABRIC_NESTED_TOOL_CALL_ID_PREFIX)) return undefined;

  let parsed: unknown;
  try {
    parsed = protocol?.readFabricToolResultProxyDetailsV1?.(details);
  } catch {
    parsed = undefined;
  }
  const officialRecord = asRecord(parsed);
  const record = officialRecord ?? asRecord(details);
  if (!record || record.ref !== toolName || !("result" in record)) return undefined;
  if (!officialRecord && record.kind !== "pi-fabric.tool-result-proxy.v1") return undefined;

  return {
    kind: "pi-fabric.tool-result-proxy.v1",
    ref: toolName,
    result: record.result,
  };
}
