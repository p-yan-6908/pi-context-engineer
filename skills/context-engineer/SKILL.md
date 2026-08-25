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
pi install npm:pi-context-engineer
```

For local development, install a checkout instead:

```bash
pi install /path/to/pi-context-engineer
```

When the Fabric `fabric_exec` tool is installed, the extension adds static interception and nested-result guarding; the standalone `ctx_*` tools also work in ordinary Pi sessions. Fabric is an optional peer and official protocol helpers are used when available.

## Automatic policy

The live `fabric_exec` call is checked before execution using local data-flow analysis. Source values from `pi.*`, `mcp.*`, captured `extensions.*`, and direct Pi tools are tracked through aliases, destructuring, object/array values, callbacks, `Promise.all`, local functions, and arguments.

The analyzer classifies the value returned to Main:

- **RAW / ENCODED / UNKNOWN:** unbounded source-bearing output
- **PROJECTED:** fields, keys, lengths, counts, and scalar values
- **SELECTED:** filters, slices, matches, and bounded Fovea results
- **AGGREGATED:** reductions and scalar summaries
- **COMPRESSED:** `ctx_summarize`
- **OFFLOADED:** `ctx_offload`

Default policy is runtime-first: an uncertain source-bearing return is classified as a warning but executes silently; the boundary hook keeps a small actual result or offloads a large one. Call `ce_exec` when the explicit static diagnostic is useful. `strict: true` or `blockUnboundedReturns: true` restores fail-closed preflight. Certain static failures remain blocked. Numeric limits passed through aliases/local helpers and common tool status fields are recognized as bounded. The number of internal Fabric calls is not the main budget: many calls are acceptable when the returned context is small and meaningful.

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

`ctx_summarize` supports three modes: `structural` (default deterministic extraction), `code` (deterministic code-aware extraction), and `model` (isolated semantic LLM compression). Model mode accepts `maxInputTokens` (default 32000 per child call) and uses hierarchical chunk/reduce summarization by default, so payload size does not become prompt size. Unknown modes are rejected; use `code` or `structural` for source inspection to avoid an unnecessary model call.


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

- `ctx_read`: read a UTF-8 byte range or search literal matches; ranged results expose copyable `offset` / `nextOffset`, query mode defaults to 100 formatted windows (`maxMatches`, capped at 500) and reports sampled `matchedLines` plus exact `totalMatches`
- `ctx_summarize`: deterministic structural/code compression or bounded isolated no-tools model compression
- `ctx_remember` / `ctx_recall` / `ctx_forget`: persistent project facts with bounded recall, named upserts, and deletion
- `ctx_delegate`: isolated child-Pi fallback with `maxTokens` and a nested-safe timeout
- `ctx_offload`: manually write a payload and return a handle plus preview

For Fabric-native recursive agents and RLM-style decomposition, call Fabric's `agents.*` APIs directly when available.

## Runtime protections

- Ordinary large model-boundary text results (about 8 KB by default) are written to `<workspace>/.pi/context-store/` and replaced by a handle plus preview.
- Addressable offload and `ctx_read` previews remain for their first model call, then repeated context copies compact to a one-line `ctx_read` recipe; stored data and session history remain intact.
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
  "blockUnboundedReturns": false,
  "maxReturnTokens": 4000,
  "readOffloadThreshold": 8192,
  "nestedResultThreshold": 8192,
  "offloadPreviewBytes": 1024,
  "runtimeAdvisoryThreshold": 0,
  "compactStaleResults": true,
  "notifyOnStart": false,
  "storeMaxBytes": 500000000,
  "storeTtlMs": 604800000
}
```

- `enabled`: disable enforcement hooks when false
- `strict` / `blockUnboundedReturns`: fail closed on statically unbounded source returns
- `maxReturnTokens`: certain static-return threshold
- `readOffloadThreshold`: ordinary text-result threshold
- `nestedResultThreshold`: Fabric provider-proxy threshold
- `offloadPreviewBytes`: first-use handle preview size
- `runtimeAdvisoryThreshold`: optional byte threshold for size nudges; `0` disables them
- `compactStaleResults`: compact already-used addressable previews in later model contexts
- `notifyOnStart`: opt into the session-start toast
- `storeMaxBytes` / `storeTtlMs`: transient addressable-store limits; defaults are 500 MB and one week, and the storage budget cannot exceed 500 MB

Project configuration is re-read when its modification time changes. Transient entries expire after one week by default; remembered facts use a separate persistent namespace with no TTL and a 5 MB budget. Cleanup is opportunistic during later store activity rather than a background daemon; list/read paths prune expired or dangling records and writes enforce the disk budget. `maxUnprocessedToolCalls` remains accepted for older configurations, but data-flow reduction and observed context cost are primary.

## Storage and observability

Transient payload metadata is stored in `<workspace>/.pi/context-store/index.json` and content-addressed blobs live under `blobs/`; durable facts use `<workspace>/.pi/agent/context-store/` with the same private metadata/blob layout. Directories use 0700, files use 0600, writes are atomic, and identical payloads deduplicate by hash. Handles survive session restarts, subject to transient TTL or disk-budget cleanup; remembered facts are persistent until forgotten or evicted by their 5 MB budget.

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

## Evaluation and analyzer policy

The repository includes a deterministic proof harness at `bench/`. Run `npm run bench` to compare raw baseline results with CE addressable storage, bounded selection, and hierarchical compression. Reports include Main/tool-result tokens, child-model tokens, wall time, disk bytes, task correctness, quality-adjusted savings, and context efficiency.

Static tool knowledge is expressed as data in `src/context-effects.ts`: source, scalar, select, compress, offload, and unknown effects. Generated adversarial transformations run as part of `npm test`; opt-in real Pi/Fabric smoke tests use `CE_RUN_E2E=1 npm run bench:e2e`.
