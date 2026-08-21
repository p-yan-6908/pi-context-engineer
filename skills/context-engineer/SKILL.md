---
name: context-engineer
description: "Governs what data crosses the Main-model boundary in Pi Fabric: taint analysis, budgeted selection, compression, offload, and isolation."
---

# 👁️ context-engineer

`pi-context-engineer` is the context governor above Pi Fabric and optional Pi Fovea.

- **Fabric** executes and orchestrates work inside a typed sandbox.
- **Fovea** discovers relevant repository regions.
- **Context Engineer** controls the size and provenance of data crossing into Main.

## Quick start

```bash
pi install /path/to/pi-context-engineer
```

The extension requires the Fabric `fabric_exec` tool for static interception, but the standalone `ctx_*` tools also work in ordinary Pi sessions.

## Automatic policy

The live `fabric_exec` call is checked before execution using local data-flow analysis. Source values from `pi.*`, `mcp.*`, captured `extensions.*`, and direct Pi tools are tracked through aliases, destructuring, object/array values, callbacks, `Promise.all`, local functions, and arguments.

The analyzer classifies the value returned to Main:

- **RAW / ENCODED / UNKNOWN:** block; the source payload still crosses the boundary
- **PROJECTED:** fields, keys, lengths, counts, and scalar values
- **SELECTED:** filters, slices, matches, and bounded Fovea results
- **AGGREGATED:** reductions and scalar summaries
- **COMPRESSED:** `ctx_summarize`
- **OFFLOADED:** `ctx_offload`

Oversized static returns warn by default and block in `strict` mode. The number of internal Fabric calls is not the main budget: many calls are acceptable when the returned context is small and meaningful.

## The four strategies

| Strategy | Purpose | Tools |
|---|---|---|
| **Write** | Keep heavy data addressable outside Main | `ctx_offload`, `ctx_remember` |
| **Select** | Return only a range, match, or relevant code window | `ctx_read`, Fovea |
| **Compress** | Produce a structural or semantic summary | `ctx_summarize` |
| **Isolate** | Move separable work to another context | `ctx_delegate`, Fabric `agents.*` |

## Fabric usage

Registered extension tools are available in Fabric code mode through `extensions.*`:

```ts
const result = await pi.grep({ pattern: "TODO", path: "src" });
return extensions.ctx_summarize({ text: result, mode: "code", maxTokens: 300 });
```

`ctx_summarize` supports three modes: `structural` (default deterministic extraction), `code` (deterministic code-aware extraction), and `model` (isolated semantic LLM compression). Unknown modes are rejected; use `code` or `structural` for source inspection to avoid an unnecessary model call.


For manual offloading:

```ts
const text = await pi.read({ path: "large.json" });
return extensions.ctx_offload({
  key: "large-json",
  source: "read",
  data: text,
});
```

When Fovea is installed, prefer its graph-based Select tools rather than recreating repository retrieval:

```ts
const focus = await extensions.fovea_focus({
  query: "authentication",
  maxTokens: 500,
});
return extensions.ctx_summarize({ text: focus, mode: "code", maxTokens: 300 });
```

A Fovea call with `maxTokens` is recognized as a budgeted selection. Context Engineer does not duplicate Fovea's graph.

`ce_exec` is an explicit preflight validator. It does not execute the program; the `fabric_exec` hook performs enforcement automatically.

## Standalone tools

- `ctx_read`: read a UTF-8 byte range or search literal matches in a stored handle
- `ctx_summarize`: deterministic structural/code compression or isolated no-tools model compression
- `ctx_remember` / `ctx_recall`: durable project facts; recall is bounded by `limit` and `maxTokens`
- `ctx_delegate`: isolated child-Pi fallback for separable work
- `ctx_offload`: manually write a payload and return a handle plus preview

For Fabric-native recursive agents and RLM-style decomposition, call Fabric's `agents.*` APIs directly when available.

## Runtime protections

- Ordinary large model-boundary text results (about 8 KB by default) are written to `<workspace>/.pi/context-store/` and replaced by a handle plus preview.
- Ordinary intermediate `pi.*` results consumed inside Fabric are left byte-for-byte intact.
- Fabric's documented nested provider-result proxy is inspected before QuickJS. Oversized provider values are replaced structurally with a CE handle; already-bounded Fabric artifact results are not offloaded again.
- Fovea results that honor `maxTokens` are treated as already budgeted and are not redundantly offloaded.
- Grep patterns that look like invalid literal regex searches are changed to `literal: true`; valid regexes are preserved.

## Configuration

Create `<repo>/.pi/context-engineer.json`:

```json
{
  "enabled": true,
  "strict": false,
  "maxReturnTokens": 4000,
  "readOffloadThreshold": 8192,
  "nestedResultThreshold": 8192,
  "offloadPreviewBytes": 1024,
  "storeMaxBytes": 50000000,
  "storeTtlMs": 604800000
}
```

- `enabled`: disable enforcement hooks when false
- `strict`: turn soft warnings into blocks
- `maxReturnTokens`: estimated static-return threshold
- `readOffloadThreshold`: ordinary text-result threshold
- `nestedResultThreshold`: Fabric provider-proxy threshold
- `offloadPreviewBytes`: handle preview size; smaller previews save tokens while `ctx_read` keeps full data addressable
- `storeMaxBytes` / `storeTtlMs`: optional addressable-store limits

`maxUnprocessedToolCalls` remains accepted for older configurations, but data-flow reduction and observed context cost are primary.

## Storage and observability

Payloads are stored as self-describing JSON files under `<workspace>/.pi/context-store/`; durable facts use `<workspace>/.pi/agent/context-store/`. Identical payloads deduplicate by content hash. Handles survive session restarts, subject to TTL or disk-budget cleanup.

Telemetry stores sizes and strategy names, never prompts or payloads, in `.pi/context-store/context-events.jsonl`.

Use:

```text
/ce status
/ce status --all
/ce trace
/ce explain
/ce settings
/ce clear
```
