/**
 * Execution-scoped tracking for Fabric programs.
 *
 * Pi exposes a stable toolCallId for each tool execution. Fabric prefixes the
 * host-side IDs it creates for nested tool calls with `fabric_`; use that
 * documented marker instead of treating every tool result as belonging to one
 * global depth counter.
 */

import { FABRIC_NESTED_TOOL_CALL_ID_PREFIX } from "./compat/fabric.js";
export { FABRIC_NESTED_TOOL_CALL_ID_PREFIX };

export interface FabricExecutionScope {
  toolCallId: string;
  workspaceRoot: string;
  startedAt: number;
}

export class FabricExecutionScopes {
  private readonly active = new Map<string, FabricExecutionScope>();

  start(scope: FabricExecutionScope): void {
    this.active.set(scope.toolCallId, scope);
  }

  finish(toolCallId: string): boolean {
    return this.active.delete(toolCallId);
  }

  /** True when at least one Fabric execution is still awaiting its result. */
  get size(): number {
    return this.active.size;
  }

  /**
   * Nested Fabric tool IDs are safe to preserve even when lifecycle events
   * arrive out of order or the parent has already finished. The documented
   * prefix is the durable boundary marker; non-prefixed IDs remain ordinary
   * model-boundary calls.
   */
  isNestedToolResult(toolCallId: string): boolean {
    return toolCallId.startsWith(FABRIC_NESTED_TOOL_CALL_ID_PREFIX);
  }

  clear(): void {
    this.active.clear();
  }
}
