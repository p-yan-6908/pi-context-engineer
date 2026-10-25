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

When the Fabric `fabric_exec` tool is installed, the extension adds advisory preflight and model-boundary guarding; the standalone `ctx_*` tools also work in ordinary Pi sessions. Fabric is an optional peer and official protocol helpers are used when available.

## Automatic policy

The live `fabric_exec` call is checked before execution using local data-flow analysis. Source values from `pi.*`, `mcp.*`, captured `extensions.*`, current Fabric provider namespaces (`agents.*`, `workflow.*`, `state.*`, `memory.*`, `schema.*`, `mesh.*`, `council.*`, and `rlm.*`), and direct Pi/shell/web tools are tracked through aliases, destructuring, object/array values, callbacks, `Promise.all`, local functions, and arguments.

The analyzer classifies the value returned to Main:

- **RAW / ENCODED / UNKNOWN:** unbounded source-bearing output
- **PROJECTED:** fields, keys, lengths, counts, and scalar values
- **SELECTED:** filters, slices, matches, and bounded Fovea results
- **AGGREGATED:** reductions and scalar summaries
- **COMPRESSED:** `ctx_summarize`
- **OFFLOADED:** `ctx_offload`

Default policy is runtime-first: an uncertain source-bearing return is classified as a warning but executes silently; the boundary hook keeps a small actual result or offloads a large one. Call `ce_exec` when the explicit static diagnostic is useful. `strict: true` or `blockUnboundedReturns: true` restores fail-closed preflight. Zero-source projections and estimated oversized returns are advisory too; Fabric retains authoritative syntax/execution validation. Numeric limits passed through aliases/local helpers and common tool status fields are recognized as bounded. The number of internal Fabric calls is not the main budget: many calls are acceptable when the returned context is small and meaningful. `resultPolicy` can explicitly choose `auto`, `inline`, `offload`, or `summarize` for successful model-boundary returns; oversized model-facing errors are deterministically compacted while nested Fabric values remain exact.

## The four strategies

| Strategy | Purpose | Tools |
|---|---|---|
| **Write** | Keep heavy data addressable outside Main | `ctx_offload`, `ctx_remember` |
| **Select** | Return only a range, match, or relevant code window | `ctx_read`, Fovea |
| **Compress** | Produce a structural or semantic summary | `ctx_summarize` |
| **Isolate** | Move separable work to another context | `ctx_delegate`, Fabric `agents.*` |

## Fabric usage

Registered extension tools are available in Fabric code mode through `extensions.*`. When CE is enabled, extension-enabled Fabric Pi children at any depth automatically receive `ctx_read`, so their model-boundary offloads remain readable without repeating `tools: ["ctx_read"]`. The grant is skipped for an explicit empty `tools` list and for `+name`/`-name` lists; CE then keeps results inline instead of offloading. CE's isolated `ctx_delegate` fallback loads CE with `ctx_read` only. Other CE/Fovea extension tools remain opt-in; explicit `extensions: false` and non-Pi runners are intentional opt-outs. Keep full structured results internally; when returning a helper to Main, project its `.text` to avoid serializing the same payload in `content`, `text`, and `details` repeatedly:

```ts
const result = await pi.grep({ pattern: "TODO", path: "src" });
return (await extensions.ctx_summarize({ text: result, mode: "code", maxTokens: 300 })).text;
```

`ctx_summarize` supports `structural` (default deterministic extraction), `code` (deterministic code-aware extraction), and `model` (isolated semantic compression). Model mode defaults to `maxInputTokens: 32000`, `maxChunks: 16` (max 64), `maxCalls: 2 * maxChunks` (max 128), and `timeoutSeconds: 90` for the whole operation (10–110). Binary reduction guarantees progress. Inputs over `maxChunks` fail before any model calls and provide exact recovery; they never silently become prefix-only summaries. `strategy: "direct"` is an explicit prefix request, with coverage and continuation metadata. Model source data, including inline text, is preserved under a recovery handle. Unknown modes reject at the registered tool boundary. Prefer deterministic modes unless semantic compression is necessary.


For manual offloading:

```ts
const text = await pi.read({ path: "large.json" });
return (await extensions.ctx_offload({
  key: "large-json",
  source: "read",
  data: text,
})).text;
```

When Fovea is installed, prefer its graph-based Select tools rather than recreating repository retrieval:

```ts
const focus = await extensions.fovea_focus({
  query: "authentication",
  maxTokens: 500,
});
return (await extensions.ctx_summarize({ text: focus.text, mode: "code", maxTokens: 300 })).text;
```

A Fovea call with `maxTokens` is recognized as a budgeted selection. Context Engineer does not duplicate Fovea's graph.

`ce_exec` is an explicit preflight validator. It does not execute the program; the `fabric_exec` hook performs enforcement automatically.

## Standalone tools

- `ctx_read`: read a UTF-8 byte range, search literal matches, or select a JSON path such as `$.results[0].name`; ranged results expose copyable `offset` / `nextOffset`, query mode defaults to 100 formatted windows (`maxMatches`, capped at 500) and reports sampled `matchedLines` plus exact `totalMatches`. Storage results carry explicit `ok` status; `Error:`-prefixed logs and remembered facts are not errors.
- `ctx_summarize`: deterministic structural/code compression or bounded isolated no-tools model compression
- `ctx_remember` / `ctx_recall` / `ctx_forget`: persistent project facts with bounded recall, named upserts, and deletion
- `ctx_delegate`: isolated child-Pi fallback with bounded output, `maxTurns` (default 8, max 32), a nested-safe timeout, and process-tree cancellation. Supported adapters get generation caps; Codex uses an approximate streamed-output guard because its API has no server cap. `generationBudget` labels the approximation; cancellation may leave billing unknown or above the estimate. `childOutputTruncated` flags provider-length truncation and oversized results retain recovery. Pure summarization uses a minimal no-tools/no-project-context child and a whole-operation deadline.
- `ctx_offload`: manually write a payload and return a handle plus preview

For Fabric-native recursive agents and RLM-style decomposition, call Fabric's `agents.*` APIs directly when available.

## Runtime protections

- Ordinary large model-boundary text results (16 KB by default) are written to `<workspace>/.pi/context-store/` and replaced by a structural handle preview. JSON previews prioritize short nested fields; Fabric sectioned-YAML previews retain small sections and source-line-labeled outline excerpts rather than wasting the budget on large schemas/diffs.
- Recognized successful 2 KB+ edit envelopes with verbose diff/patch data also become compact acknowledgments with a recovery handle. The full original text is stored unchanged. Disable this optimization with `compactEditResults: false`, or bypass successful-result rewriting with `resultPolicy: "inline"`.
- Offload previews are compacted before first model exposure. Already-exposed results, including `ctx_read` output, remain unchanged on later calls to preserve cacheable prefixes and evidence. Use Pi session compaction for accumulated history, `ctx_read(...)` at the model boundary, and `extensions.ctx_read(...)` inside Fabric.
- Oversized model-facing errors are compacted with representative diagnostics and a recovery recipe within the error budget. The exact original is stored first. Storage failure leaves the original result visible.
- Ordinary intermediate `pi.*` results consumed inside Fabric are left byte-for-byte intact.
- All internal Fabric provider values (including MCP, Fovea, CE helpers and proxy `details.result`) are untouched under every policy. Fabric owns its transport limits; internal offloading must be explicit.
- In auto mode, Fovea results that honor `maxTokens` are treated as already budgeted and are not redundantly offloaded.
- CE never repairs or mutates grep inputs. Fabric owns catalog-argument repairs; regex intent remains with the caller.
- All text blocks share the boundary budget. Single-text handles retain exact text; multi-text handles store `{ textBlocks: [{ index, text }, ...] }` with original content-array indices. Media positions and a bounded allowance of short sibling text are preserved.

## Configuration

Create `<repo>/.pi/context-engineer.json`:

```json
{
  "enabled": true,
  "strict": false,
  "blockUnboundedReturns": false,
  "maxReturnTokens": 4000,
  "readOffloadThreshold": 16384,
  "resultPolicy": "auto",
  "errorCompactionThreshold": 4096,
  "errorCompactionPreviewBytes": 4096,
  "offloadPreviewBytes": 2048,
  "runtimeAdvisoryThreshold": 0,
  "compactEditResults": true,
  "notifyOnStart": false,
  "storeMaxBytes": 500000000,
  "storeTtlMs": 604800000
}
```

- `enabled`: disable enforcement hooks when false
- `strict` / `blockUnboundedReturns`: fail closed on statically unbounded source returns
- `maxReturnTokens`: static advisory budget, enforced only by explicit strict/blocking modes
- `readOffloadThreshold`: ordinary text-result threshold (default 16 KB)
- `nestedResultThreshold`: deprecated and ignored (effective value `null`); internal values are never rewritten
- `resultPolicy`: `auto` previews, `inline` preserves all results (including errors), `offload` forces successful-result handles, and `summarize` applies threshold-based deterministic structural compression with exact recovery and no model call
- `errorCompactionThreshold` / `errorCompactionPreviewBytes`: deterministic model-facing error bounds
- `offloadPreviewBytes`: structural first-use handle preview budget
- `runtimeAdvisoryThreshold`: optional byte threshold for size nudges; `0` disables them
- `compactStaleResults`: deprecated compatibility key, ignored; effective value is always `false` to preserve already-exposed prefixes
- `compactEditResults`: compact recognized verbose successful edit envelopes at 2 KB (default `true`)
- `notifyOnStart`: opt into the session-start toast
- `storeMaxBytes` / `storeTtlMs`: transient addressable-store limits; defaults are 500 MB and one week, and the storage budget cannot exceed 500 MB

### Config reference (all `CeConfig` keys)

Byte budgets are UTF-8 bytes; token estimates are ~bytes/4 ASCII-biased (multibyte UTF-8 inflates bytes faster; prefer bytes).

| Option | Default | Notes |
| --- | --- | --- |
| `enabled` | `true` | `false` disables hooks. |
| `strict` / `blockUnboundedReturns` | `false` | Fail closed on unbounded source returns; `strict` also blocks soft warnings. |
| `maxReturnTokens` | `4000` | Static advisory budget only (~16 KB ASCII). |
| `maxUnprocessedToolCalls` | legacy | Accepted for old configs; reduction/cost is primary. |
| `quantitativePolicy` / `policy` (alias) | `{maxBytes: 8192, maxTokens: 4000, maxCharacters: 8192}` | Single policy source; `policy.maxBytes` unifies runtime offload when `readOffloadThreshold` is unset. Per-budget max 1,000,000,000. |
| `readOffloadThreshold` | `16384` | Runtime auto-offload bytes; wins over policy bytes. Clamped 256–1,000,000,000 with `ctx_status` warning. |
| `resultPolicy` | `"auto"` | `"auto" \| "inline" \| "offload" \| "summarize"`; `inline` preserves everything, `summarize` is deterministic structural (no model call). |
| `errorCompactionThreshold` / `errorCompactionPreviewBytes` | `4096` / `4096` | Oversized error compaction bounds (256 min; preview max 64,000). |
| `offloadPreviewBytes` | `2048` | First-use handle preview (256–4,096). |
| `runtimeAdvisoryThreshold` | `0` | `0` disables size nudges; positive byte threshold opts in. |
| `compactEditResults` | `true` | Compact 2 KB+ verbose edit envelopes; `false` keeps inline. |
| `notifyOnStart` | `false` | Session-start toast opt-in. |
| `storeMaxBytes` / `storeTtlMs` | `500000000` / `604800000` | Transient cap (≤500 MB, newest never evicted, LRU) / TTL (1 week; remembered facts separate, no TTL, 5 MB). |
| `compactStaleResults` | deprecated, ignored (`false`) | Old configs still load; already-exposed output stays stable. |
| `nestedResultThreshold` | deprecated, ignored (`null`) | Internal provider values never rewritten. |

Bad JSON or invalid `policy` loads defaults with a `ctx_status` warning (never throws on startup).

### Selection and compression notes

- `ctx_read({ query })` stays literal and case-sensitive by default. `regex: true` treats `query` as a per-line JavaScript RegExp; `ignoreCase: true` enables case-insensitive matching. Invalid regex produces internal `{ error, code: "invalid_regex", isError: true }` diagnostics and rejects at the registered Pi tool boundary, as do other helper failures.
- `ctx_summarize` model mode preserves exact source recovery and reports coverage. Overflow returns `summary_input_budget_exceeded` with zero model calls; explicitly raise a budget or use `ctx_read` to select input. Direct mode reports unread bytes/nextOffset. Stored model reads are chunk-count bounded; structural/code stored reads use a 512 KB prefix with pagination notice.

Project configuration is re-read when its modification time changes. Transient entries expire after one week by default; remembered facts use a separate persistent namespace with no TTL and a 5 MB budget. Cleanup is opportunistic during later store activity rather than a background daemon; list/read paths prune expired or dangling records and writes enforce the disk budget. `maxUnprocessedToolCalls` remains accepted for older configurations, but data-flow reduction and observed context cost are primary.

## Storage and observability

Transient payload metadata is stored in `<workspace>/.pi/context-store/index.json` and content-addressed blobs live under `blobs/`; durable facts use `<workspace>/.pi/agent/context-store/` with the same private metadata/blob layout. Directories use 0700, files use 0600, writes are atomic, and identical payloads deduplicate by hash. Handles survive session restarts, subject to transient TTL or disk-budget cleanup; remembered facts are persistent until forgotten or evicted by their 5 MB budget.

Telemetry stores sizes, strategy names, and actual observed child Usage, never prompts or payloads, in `.pi/context-store/context-events.jsonl`. `childUsageComplete: false` means unknown/partial usage, not free work. Native standalone calls attach observed Usage automatically; current Fabric capture drops nested Usage, so add only `childUsageOutsideParent` to native totals, not all child Usage a second time. `ctx_status` reports one compact selected scope by default; use `ctx_status({ scope: "lifetime", detail: "full" })` for all runtime/current-host-session/workspace-lifetime scopes and diagnostics; `/ce status --all` selects the lifetime view, which remains useful across fresh extension runtimes.

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

The repository includes a deterministic plumbing harness at `bench/`. `npm run bench` measures raw-versus-selected payload exposure with known-marker validators and mocked summaries; these are not proof of agent effectiveness or actual billed savings. Use paired CE-on/off real-model evaluation for task quality, aggregate model usage (including child/cache/cost), latency, retries and recovery. Do not interpret proxy quality-adjusted savings as non-inferiority evidence.

Static tool knowledge is expressed as data in `src/context-effects.ts`: source, scalar, select, compress, offload, and unknown effects. Generated adversarial transformations run as part of `npm test`; opt-in real Pi/Fabric smoke tests use `CE_RUN_E2E=1 npm run bench:e2e`.
