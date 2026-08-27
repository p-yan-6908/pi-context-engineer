# pi-context-engineer

A context governor for [Pi](https://github.com/badlogic/pi-mono), [Pi Fabric](https://github.com/monotykamary/pi-fabric), and optionally [Pi Fovea](https://github.com/monotykamary/pi-fovea).

The roles are deliberately separate:

- **Fabric** executes and orchestrates work without exposing intermediate values to Main.
- **Fovea** discovers the most relevant repository regions.
- **Context Engineer** decides what data is allowed to cross the boundary and records the cost.

## Features

### Static data-flow gate

`fabric_exec` programs are analyzed before execution. Tool-originated values are tracked through aliases, destructuring, object/array construction, method chains, callbacks, local helper functions, `Promise.all`, and function arguments.

The analyzer distinguishes:

- `RAW` — direct or near-direct tool data
- `ENCODED` — `String(raw)`, `JSON.stringify(raw)`, templates, and similar representations that still contain the payload
- `UNKNOWN` — an untrusted helper received tainted data
- `PROJECTED` — scalar fields, counts, keys, and field projections (only scalar projections are inherently bounded)
- `SELECTED` — slices, filters, matches, and bounded Fovea results (only explicit bounds are safe)
- `AGGREGATED` — reductions and scalar summaries
- `COMPRESSED` — context summaries
- `OFFLOADED` — disk handles

Scalar projections, `some()`/`every()`/`includes()`, one-item selectors such as `find()`, explicit `slice(0, N)`, Fovea `maxTokens`, summaries, and offloads establish bounds. Numeric bounds survive aliases and local helper arguments, and common tool status fields such as `ok`, `exitCode`, and `truncated` are treated as scalars. `map()`, `filter()`, `reduce()`, `Object.entries()`/`values()`, `trim()`, and `replace()` can still retain the full source, so the analyzer marks them unbounded unless a later operation derives an explicit bound.

By default, an uncertain source-bearing return is classified as a warning but **executes silently**. The runtime boundary guard then keeps a small actual result or offloads a large one. Use `ce_exec` when you want the static diagnostic explicitly. This avoids blocking useful work because of a conservative static approximation. Set `strict: true` or `blockUnboundedReturns: true` for fail-closed preflight. Statically certain failures such as an empty program or oversized literal remain blocked in every mode. The number of internal calls is not the primary limit: a Fabric program may make many calls when its boundary result is controlled.

### Runtime boundary guard

The extension preserves ordinary intermediate `pi.*` results while Fabric code is running. It also consumes Fabric's documented nested provider-result proxy:

1. inspect the actual provider value before QuickJS receives it;
2. offload oversized provider values to `.pi/context-store/`;
3. patch the structured proxy value with a handle and preview;
4. leave already-bounded Fabric and Fovea results alone.

Large final text results are likewise offloaded, but existing Fabric artifact-backed results and budgeted Fovea results are not offloaded a second time. Runtime size advisories are disabled by default because bounded 4–8 KB results are usually intentional; set `runtimeAdvisoryThreshold` to opt in.

### Fovea-aware selection

When Fovea is installed, use its captured tools inside Fabric:

```ts
const focus = await extensions.fovea_focus({
  query: "authentication",
  maxTokens: 500,
});

return extensions.ctx_summarize({
  text: focus,
  maxTokens: 300,
});
```

A Fovea call with `maxTokens` is classified as a budgeted `SELECT` operation. Context Engineer does not reproduce Fovea's code graph.

### Context-effect registry (v0.5)

The analyzer consumes a small exported registry describing how calls affect context:

```ts
import { contextEffectFor } from "pi-context-engineer";

contextEffectFor("pi.read"); // { kind: "source" }
contextEffectFor("extensions.ctx_read"); // SELECT bounded by length bytes
contextEffectFor("extensions.ctx_summarize"); // COMPRESS bounded by maxTokens
contextEffectFor("extensions.ctx_offload"); // OFFLOAD
```

The registry remains descriptive, while the analyzer reports `metrics.returnBound`, `metrics.returnProvenance`, and an independent `metrics.quantitativeDecision`. Bounds distinguish exact values from proven upper bounds; the upper-bound algebra supports safe-integer `+`, `-`, `*`, `Math.min`, expression-level conditional joins, and `Math.max` when every operand is bounded. Conditional joins require both branches to be finite and use the larger branch bound; unsupported operations and control-flow assignment remain unknown. Quantitative policy defaults to 8192 bytes, 4000 tokens, and 8192 characters. Only bytes, tokens, and characters are directly comparable to those budgets; characters mean JavaScript UTF-16 code units (`String.length`), with no implicit byte/token conversion. Element and record bounds remain structural and are not used as context-size proofs. A within-budget proof additively clears only the legacy unbounded-return block; legacy-safe paths remain safe, while over-budget and not-comparable proofs remain blocked. Configure overrides in `.pi/context-engineer.json` with `policy.maxBytes`, `policy.maxTokens`, and `policy.maxCharacters`; each must be a non-negative safe integer no greater than 1,000,000,000. `explainProgram(source)` and `formatProgramExplanation(...)` expose the decision, budget, proven maximum, and result.

### Addressable context store

Stored payloads include content hashes, provenance/source, content type, creation/access timestamps, estimated tokens, and expiry. Identical payloads deduplicate. `ctx_read` supports UTF-8 byte ranges and literal line queries. Ranged results expose copyable `offset` / `nextOffset`; query mode formats at most 100 match windows by default (`maxMatches`, capped at 500), samples `matchedLines`, and preserves the exact `totalMatches`. The complete serialized result—not only its text field—is budgeted below the recursive-offload threshold. An offload or `ctx_read` preview remains intact for the first model call that needs it; on later calls, the non-destructive `context` hook replaces that repeated text with a one-line handle recipe. The full payload remains re-readable, and session history is never rewritten. By default, entries expire after one week and the store is capped at 500 MB; cleanup runs opportunistically during store activity.

### Telemetry

The extension records sizes and strategies—not prompts or payloads—in `.pi/context-store/context-events.jsonl`. Metrics separate `internalTokensProcessed`, `mainTokensPrevented`, `mainTokensInjected`, and `storeTokensWritten`; the legacy `savedTokens` field aliases Main-context prevention for compatibility.

Interactive commands:

```text
/ce status          current-session observed savings
/ce status --all   all recorded workspace sessions
/ce trace          recent policy events
/ce explain        current architecture and policy
/ce settings       effective project configuration
/ce clear          clear telemetry
```

The numbers are approximate context-token estimates, useful for comparing policies rather than billing reconciliation. Internal provider work is not counted as Main context saved unless CE actually prevents it from crossing the Main boundary.

## Fabric example

```ts
const result = await pi.grep({ pattern: "TODO", path: "src" });

return extensions.ctx_summarize({
  text: result,
  mode: "code",
  maxTokens: 300,
});
```

### Summarization modes
`ctx_summarize` accepts an inline `text` value or an offloaded `id`:

- `structural` (default) — free deterministic JSON/text extraction.
- `code` — free deterministic code-aware extraction of imports, signatures, and head/tail windows.
- `model` — isolated no-tools semantic summarization; large inputs are chunked and reduced hierarchically.

Unknown modes are rejected. `maxTokens` is an approximate UTF-8 budget and is clamped to a safe range. Model mode also accepts `maxInputTokens` (default 32000 per child-model call) and `strategy: "hierarchical" | "direct"`; hierarchical is the safe default. Prefer `code` or `structural` for source inspection because they avoid an extra model call.

Offloaded results include a copyable `extensions.ctx_read({ id, offset, length })` example. Use `query` when you know a literal symbol or phrase.

For large data, write it off-window instead of returning it directly:

```ts
const text = await pi.read({ path: "large.json" });

return extensions.ctx_offload({
  key: "large-json",
  source: "read",
  data: text,
});
```

Use the returned handle with `ctx_read` to retrieve a range or literal matches later.

## Tools

The registered tools are callable directly by the model and inside Fabric through `extensions.*`:

- `ctx_read` — select a range or literal matches from a stored handle
- `ctx_summarize` — free structural/code compression or isolated no-tools model compression
- `ctx_remember` / `ctx_recall` / `ctx_forget` — persistent project facts with bounded recall, named upserts, and deletion
- `ctx_delegate` — isolated child Pi fallback with bounded output and a nested-safe deadline
- `ctx_offload` — manual Write operation
- `ctx_status` — current policy thresholds and observed savings
- `ce_exec` — explicit static preflight (`PASS`, `WARN`, or `BLOCK`)

For Fabric-native orchestration and recursive decomposition, call Fabric's `agents.*` APIs directly when available.

## Configuration

Create `.pi/context-engineer.json` in a project when needed:

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

Project configuration is re-read when the file's modification time changes, so tuning does not require an extension reload. `/ce settings` shows effective values, including defaults.

- `strict` or `blockUnboundedReturns` restores fail-closed static enforcement.
- `runtimeAdvisoryThreshold: 0` disables repetitive size nudges; use a positive byte threshold to opt in.
- `compactStaleResults` controls automatic compaction of already-used, addressable previews.
- `notifyOnStart` controls the session-start toast, which is off by default.

Transient context-store entries default to one week (`604800000` ms) and 500 MB (`500000000` bytes). Remembered facts use a separate persistent store with no TTL and a 5 MB budget. Configured transient storage budgets cannot exceed the 500 MB cap. Payloads use a metadata index plus content-addressed private blobs; writes are atomic and cleanup removes expired, dangling, and over-budget entries.

## Install in Pi

After installing from npm, Pi loads the extension and skill from the package manifest:

```sh
pi install npm:pi-context-engineer
```

Try it for one run without saving it to settings:

```sh
pi -e npm:pi-context-engineer
```

The package can also be loaded from a checkout:

```sh
pi --extension /path/to/pi-context-engineer/src/index.ts
```

## Automated releases

Publishing is tag-driven through `.github/workflows/publish.yml` and uses npm trusted publishing (OIDC), so no npm token is stored in GitHub. Configure the repository once in the npm package settings under **Trusted Publishers**:

- Provider: GitHub Actions
- Owner: `p-yan-6908`
- Repository: `pi-context-engineer`
- Workflow: `publish.yml`

Then release a new version with:

```sh
npm version patch
git push origin main --follow-tags
```

The workflow verifies the `vX.Y.Z` tag matches `package.json`, runs the full test suite, and publishes to npm.

## Verification

```sh
npm ci
npm test
```

The test suite includes more than 50 static data-flow cases plus live hook probes covering:

- aliases, destructuring, scalar result fields, numeric bounds passed through local helpers, and paging metadata
- `String`/`JSON.stringify` false reductions
- unknown helper arguments
- callback projections and identity maps
- `Promise.all`
- bounded and unbounded Fovea calls
- nested Fabric provider proxies
- intermediate-result preservation
- automatic final offload, one-use addressable previews, stale-result context compaction, serialized `ctx_read` envelope caps, and bounded query work
- runtime-first versus strict preflight, bounded delegation, and deterministic `ctx_summarize` modes
- content deduplication, UTF-8 ranges, and ripgrep-only brace parse repair
- generated adversarial transformations for aliases, destructuring, callbacks, async wrappers, computed access, loops, and Promise aggregates
- the explicit `src/context-effects.ts` registry used by the analyzer for source/select/compress/offload policy metadata

Run the generated adversarial suite directly with the normal `npm test` command. It fails closed when an unsafe transformation is classified as safe.

## Benchmarking

The deterministic proof harness compares raw baseline results with CE addressable storage, bounded selection, and hierarchical summarization:

```sh
npm run bench
```

It covers huge grep/JSON/build-log payloads, repeated reads, parallel provider-like results, Fovea-like source selection, large summaries, and nested-agent handoffs. The default one-warmup/three-iteration run reports median and p95 wall time to `.tmp/context-benchmark.json`; `bench/result.schema.json` defines retained release results with sourceCommit/runtime provenance and per-iteration samples. The v0.5.0 retained workload result is `bench/results/v0.5.0.json`; the frozen v0.4.0 result remains `bench/results/v0.4.0.json` for comparable baseline evidence.

The separate v0.5 quantitative-policy result is `bench/results/v0.5.0-quantitative-policy.json`; it emphasizes maintained legacy parity plus intentional symbolic-cap acceptance, not a misleading performance comparison. Metrics include Main-context exposure (not total token usage), Main input/output/injected tokens, child-model tokens, wall time, disk bytes, selected bytes retrieved, task correctness, quality-adjusted savings, and context efficiency.

Opt-in real runtime smoke tests launch the local `pi` CLI with CE and Fabric extensions. They require a configured model and are intentionally separate from CI's deterministic suite:

```sh
CE_RUN_E2E=1 PI_MODEL=openai-codex/gpt-5.6-luna npm run bench:e2e
```

## License

MIT
