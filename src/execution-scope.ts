/** Per-call execution lineage. No process-wide "a program is running" heuristic. */
import { FABRIC_NESTED_TOOL_CALL_ID_PREFIX } from "./compat/fabric.js";
export { FABRIC_NESTED_TOOL_CALL_ID_PREFIX };

export interface FabricExecutionScope {
  toolCallId: string;
  workspaceRoot: string;
  startedAt: number;
}

export class FabricExecutionScopes {
  private readonly active = new Map<string, FabricExecutionScope>();
  private readonly parents = new Map<string, string>();
  private readonly reads = new Map<string, Set<string>>();

  /** Pi's native executeTool assigns arbitrary IDs and supplies explicit parent metadata. */
  observeCall(toolCallId: string, parentToolCallId?: string): void {
    if (parentToolCallId && parentToolCallId !== toolCallId) this.parents.set(toolCallId, parentToolCallId);
  }

  start(scope: FabricExecutionScope): void {
    this.active.set(scope.toolCallId, scope);
  }

  finish(toolCallId: string): boolean {
    this.parents.delete(toolCallId);
    this.reads.delete(toolCallId);
    return this.active.delete(toolCallId);
  }

  get size(): number { return this.active.size; }

  isNestedToolResult(toolCallId: string, parentToolCallId?: string): boolean {
    return !!parentToolCallId || this.parents.has(toolCallId) ||
      toolCallId.startsWith(FABRIC_NESTED_TOOL_CALL_ID_PREFIX);
  }

  /** Associate a handle read with its outermost calling tool, across arbitrary nesting. */
  noteHandleRead(toolCallId: string, handle: string): void {
    const visited = new Set<string>();
    let root = toolCallId;
    while (this.parents.has(root) && !visited.has(root)) {
      visited.add(root);
      root = this.parents.get(root)!;
    }
    if (root === toolCallId) return;
    const handles = this.reads.get(root) ?? new Set<string>();
    // Bound metadata without guessing ownership of concurrent executions.
    if (handles.size < 64) handles.add(handle);
    this.reads.set(root, handles);
  }

  takeReadHandles(toolCallId: string): string[] {
    const handles = [...(this.reads.get(toolCallId) ?? [])];
    this.reads.delete(toolCallId);
    return handles;
  }

  clear(): void {
    this.active.clear();
    this.parents.clear();
    this.reads.clear();
  }
}
