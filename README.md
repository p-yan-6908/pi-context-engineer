# pi-context-engineer

A context governor for [Pi](https://github.com/badlogic/pi-mono), [Pi Fabric](https://github.com/monotykamary/pi-fabric), and optionally [Pi Fovea](https://github.com/monotykamary/pi-fovea).

The roles are deliberately separate:

- **Fabric** executes and orchestrates work without exposing intermediate values to Main.
- **Fovea** discovers the most relevant repository regions.
- **Context Engineer** decides what data is allowed to cross the boundary and records the cost.

## Features

### Static data-flow gate

With `strict` or `blockUnboundedReturns`, `fabric_exec` programs are analyzed before execution; `explainProgram` runs the same analysis on demand. TypeScript, which the analyzer parses with, loads on first analysis rather than at extension startup. Tool-originated values are tracked through aliases, destructuring, object/array construction, method chains, callbacks, local helper functions, `Promise.all`, and function arguments.

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

By default CE skips static preflight, because nothing acts on an advisory verdict: programs run and the runtime boundary guard keeps a small actual result or offloads a large one. Use `explainProgram` when you want the static diagnostic explicitly. This avoids blocking useful work because of a conservative static approximation. Set `strict: true` or `blockUnboundedReturns: true` for fail-closed preflight. With `blockUnboundedReturns` alone, only hard blocks (statically unbounded source returns) stop a program. Fabric retains authoritative syntax/execution validation; only explicit strict/blocking settings turn CE diagnostics into pre-execution blocks. The number of internal calls is not the primary limit: a Fabric program may make many calls when its boundary result is controlled.

### Runtime boundary guard

CE leaves **all** internal Fabric values intact: ordinary `pi.*` results, MCP results, captured Fovea/CE tools, and provider proxy `details.result`. Fabric owns its executor/transport limits. Explicit `ctx_offload` remains available when the program deliberately wants a handle.

At the model boundary CE budgets the **sum of all text blocks**, not just the first. Single-text handles store the exact text unchanged. Multi-text handles store `{ textBlocks: [{ index, text }, ...] }`, preserving every original content-array index; use `jsonPath: "$.textBlocks[0].text"` or byte ranges to recover text. Media retain their positions, short independent notes get a bounded inline allowance, and rewritten slots share one recovery handle. A storage failure leaves the original result visible rather than discarding evidence.

Large final text results are offloaded; budgeted Fovea results that meet their requested size are left alone in auto mode. Artifact metadata alone cannot exempt an oversized payload. JSON previews prioritize short nested status/path/count fields over bulky siblings. Fabric's sectioned-YAML results retain small sections and source-line-labeled outline excerpts; previews are selections, not complete return values. `summarize` uses deterministic structural compression with the full original stored behind a recovery handle. Oversized errors also retain exact originals, not just selected diagnostics.

CE never rewrites grep patterns or other tool arguments. Fabric's catalog repairs handle argument/action naming near-misses; its entropy compiler optimizes tool surfaces. Neither requires CE to guess regex intent.

Recognized successful edit envelopes containing verbose diff/patch strings are compacted from 2 KB onward, even below the ordinary offload threshold. The acknowledgment stays visible and the complete original diff/patch remains retrievable. This only changes model-boundary text, never ordinary intermediate Pi values. Set `compactEditResults: false` to disable the lower edit threshold, or `resultPolicy: "inline"` to bypass successful-result rewriting altogether.

Runtime size advisories are disabled by default because bounded 4–8 KB results are usually intentional; set `runtimeAdvisoryThreshold` to opt in.

### Fovea-aware selection

When Fovea is installed, use its captured tools inside Fabric:

```ts
const focus = await extensions.fovea_focus({
  query: "authentication",
  maxTokens: 500,
});

return (await extensions.ctx_summarize({
  text: focus.text,
  maxTokens: 300,
})).text;
```

A Fovea call with `maxTokens` is classified as a budgeted `SELECT` operation. Context Engineer does not reproduce Fovea's code graph.

### Fabric child agents

When CE is enabled, each extension-enabled Fabric Pi child that loads CE adds `ctx_read` to its own captured-tool allowlist before Fabric initializes, so the child can read back what CE offloaded in it without the caller listing the helper. This repeats at every depth. Like Fabric's own `agents.childQuestionTools` grant, it is skipped for an explicit empty `tools` list and for `+name`/`-name` lists; a malformed allowlist fails closed. Where no read path exists (a withheld allowlist, or a Pi `--tools` list without `ctx_read`), CE keeps the result inline rather than returning a handle that cannot be read. Other CE and Fovea extension tools remain opt-in; an explicit `extensions: false`/`--no-extensions` request and non-Pi runners are still intentional opt-outs.

### Context-effect registry (v0.5)

The analyzer consumes a small exported registry describing how calls affect context:

```ts
import { contextEffectFor } from "pi-context-engineer";

contextEffectFor("pi.read"); // { kind: "source" }
contextEffectFor("extensions.ctx_read"); // SELECT bounded by length bytes
contextEffectFor("extensions.ctx_summarize"); // COMPRESS bounded by maxTokens
contextEffectFor("extensions.ctx_offload"); // OFFLOAD
```

Unregistered calls under `mcp.*`, `agents.*`, `workflow.*`, `state.*`, `memory.*`, `schema.*`, `mesh.*`, `council.*`, `rlm.*`, `fabric.*`, and direct shell/web tools are conservatively classified as source effects; exact CE/Fovea entries override that fallback.

The registry remains descriptive, while the analyzer reports `metrics.returnBound`, `metrics.returnProvenance`, and an independent `metrics.quantitativeDecision`. Bounds distinguish exact values from proven upper bounds; the upper-bound algebra supports safe-integer `+`, `-`, `*`, `Math.min`, expression-level conditional joins, and `Math.max` when every operand is bounded. Conditional joins require both branches to be finite and use the larger branch bound; unsupported operations and control-flow assignment remain unknown. Quantitative policy defaults to 8192 bytes, 4000 tokens, and 8192 characters. Only bytes, tokens, and characters are directly comparable to those budgets; characters mean JavaScript UTF-16 code units (`String.length`), with no implicit byte/token conversion. Element and record bounds remain structural and are not used as context-size proofs. A within-budget proof additively clears only the legacy unbounded-return block; legacy-safe paths remain safe, while over-budget and not-comparable proofs remain blocked. Configure overrides in `.pi/context-engineer.json` with `policy.maxBytes`, `policy.maxTokens`, and `policy.maxCharacters`; each must be a non-negative safe integer no greater than 1,000,000,000. `explainProgram(source)` and `formatProgramExplanation(...)` expose the decision, budget, proven maximum, and result.

### Addressable context store

Stored payloads include content hashes, provenance/source, content type, creation/access timestamps, estimated tokens, and expiry. Identical payloads deduplicate. `ctx_read` supports UTF-8 byte ranges, literal line queries, named sections of Fabric sectioned results (`section`, paged with `offset`/`length` inside the section), and focused JSON-path lookups such as `$.results[0].name` (no wildcards or slices). Ranged results expose copyable `offset` / `nextOffset`; query mode formats at most 100 match windows by default (`maxMatches`, capped at 500), samples `matchedLines`, and preserves the exact `totalMatches`. The complete serialized result—not only its text field—is budgeted below the recursive-offload threshold. Handles expose structural previews (JSON keys/counts, or head/tail text/code) rather than dumping arbitrary payloads. The offload notice lists copyable `ctx_read` calls for only the modes that fit the payload (`section` with a real section name for sectioned results, `jsonPath` only for JSON) and tells the model to read the handle instead of re-running the call. When a `fabric_exec` program that reads handles overflows again, the notice adds a hint to narrow the selection. At the model boundary, use `ctx_read({ id, offset, length })`; inside Fabric code, use `extensions.ctx_read(...)`. Offload previews are compacted before their first model exposure. After exposure, CE leaves messages unchanged—including `ctx_read` output—so later calls preserve cacheable prefixes and the agent keeps its evidence. CE does not register a historical `context` rewrite hook. Pi's explicit or automatic session compaction remains responsible for shortening accumulated history; stored payloads remain re-readable subject to retention limits. By default, entries expire after one week and the store is capped at 500 MB; cleanup runs opportunistically during store activity.

### Telemetry

The extension records sizes and strategies—not prompts or payloads—in `.pi/context-store/context-events.jsonl`. Metrics separate `mainTokensPrevented`, `mainTokensInjected`, and `storeTokensWritten`; the legacy `savedTokens` field aliases Main-context prevention for compatibility. `/ce status` reports the current Pi session, and `--all` covers every session recorded in the workspace.

Interactive commands:

```text
/ce status          current-session observed savings
/ce status --all   all recorded workspace sessions
/ce trace          recent policy events
/ce explain        current architecture and policy
/ce settings       effective project configuration
/ce clear          clear telemetry
```

`offloadFollowUp` (also shown by `/ce status`) reports how many boundary-offloaded handles were later read with `ctx_read`/`ctx_summarize` and how many offloaded calls were repeated anyway. A repeat suggests the preview or notice did not make the handle usable, and the same output was paid for again.

The numbers are approximate context-token estimates, not billing reconciliation or proof of agent effectiveness. Internal helper calls do not count as Main exposure, and reading an existing handle does not count the same source as prevented again.

## Fabric example

```ts
const result = await pi.grep({ pattern: "TODO", path: "src" });

return (await extensions.ctx_summarize({
  text: result,
  mode: "code",
  maxTokens: 300,
})).text; // one model-facing copy; structured details stay exact internally
```

### Summarization modes
`ctx_summarize` accepts an inline `text` value or an offloaded `id`:

- `structural` (default) — free deterministic JSON/text extraction.
- `code` — free deterministic code-aware extraction of imports, signatures, and head/tail windows.

Unknown modes reject at the registered Pi tool boundary. `maxTokens` is an approximate UTF-8 return budget, clamped to 64–4000.

Offloaded results include a copyable `ctx_read({ id, offset, length })` example at the model boundary; inside Fabric code use `extensions.ctx_read(...)`. Use `query` for literal matches or `jsonPath` for focused JSON values.

For large data, write it off-window instead of returning it directly:

```ts
const text = await pi.read({ path: "large.json" });

return (await extensions.ctx_offload({
  key: "large-json",
  source: "read",
  data: text,
})).text;
```

Use the returned handle with `ctx_read` to retrieve a range, literal matches, or a focused JSON path later.

## Tools

The registered tools are callable directly by the model and inside Fabric through `extensions.*`:

- `ctx_read` — select a range, literal matches, or a JSON path from a stored handle
- `ctx_summarize` — free structural/code compression
- `ctx_offload` — manual Write operation

For Fabric-native orchestration and recursive decomposition, call Fabric's `agents.*` APIs directly when available.

Prefer compact discovery before requesting complete schemas. For example, select only matching tool names/refs inside Fabric rather than returning the entire catalog:

```ts
const catalog = await tools.list({});
return catalog.filter(t => /blender/i.test(t.name + " " + t.description))
  .slice(0, 10).map(t => ({ name: t.name, ref: t.ref }));
```

Then describe only the tools you will call. Context Engineer does not override Fabric's discovery API.

## Configuration

Create `.pi/context-engineer.json` in a project when needed:

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

### Config reference

All options live in `.pi/context-engineer.json` (field names are exact `CeConfig` keys). Byte budgets are UTF-8 bytes; token estimates are ~bytes/4 and ASCII-biased (see note below).

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Set `false` to disable enforcement hooks. |
| `strict` | boolean | `false` | Fail closed on statically unbounded source returns and soft warnings. |
| `blockUnboundedReturns` | boolean | `false` | Block statically unbounded source returns before execution; `strict: true` implies blocking. |
| `maxReturnTokens` | number | `4000` | Static advisory budget only; enforced by explicit strict/blocking modes. Maps to ~16 KB at ~4 chars/token (ASCII-biased). |
| `maxUnprocessedToolCalls` | number | legacy | Accepted for older configs; data-flow reduction and observed context cost are primary. |
| `quantitativePolicy` | object | `{maxBytes: 8192, maxTokens: 4000, maxCharacters: 8192}` | Single policy source for static preflight and runtime budgets. |
| `policy` | object | alias | User-facing alias for `quantitativePolicy`; when both are set they are unified with `policy` as source. |
| `quantitativePolicy.maxBytes` / `policy.maxBytes` | number (bytes) | `8192` | Static preflight budget; also unifies the runtime offload budget when `readOffloadThreshold` is unset (see `resolveRuntimeByteBudget`). Max 1,000,000,000. |
| `quantitativePolicy.maxTokens` / `policy.maxTokens` | number | `4000` | Token budget for token-unit bounds. Max 1,000,000,000. |
| `quantitativePolicy.maxCharacters` / `policy.maxCharacters` | number | `8192` | Character budget (UTF-16 code units). Max 1,000,000,000. |
| `readOffloadThreshold` | number (bytes) | `16384` | Runtime auto-offload budget; wins over `policy.maxBytes` when set. Clamped to 256–1,000,000,000; clamps surface via `/ce settings` warnings. |
| `resultPolicy` | `"auto" \| "inline" \| "offload" \| "summarize"` | `"auto"` | `auto` previews/offloads by threshold; `inline` preserves all results (including errors); `offload` forces handles for successful results; `summarize` uses threshold-based deterministic structural compression with exact recovery (no model call). |
| `errorCompactionThreshold` | number (bytes) | `4096` | Model-boundary errors at/above this size are compacted (min 256). |
| `errorCompactionPreviewBytes` | number (bytes) | `4096` | Visible budget retained by a compacted error, including the recovery recipe (256–64,000). |
| `offloadPreviewBytes` | number (bytes) | `2048` | Structural first-use handle preview budget (256–4,096). |
| `runtimeAdvisoryThreshold` | number (bytes) | `0` | Fabric boundary results at/above this size get a one-line advisory; `0` disables nudges. |
| `compactEditResults` | boolean | `true` | Compact recognized verbose 2 KB+ successful edit envelopes (diff/patch) into an acknowledgment + recovery handle. Set `false` to keep them inline. |
| `notifyOnStart` | boolean | `false` | Opt into the session-start toast. |
| `storeMaxBytes` | number (bytes) | `500000000` | Transient store cap; cannot exceed 500 MB. Newest write is never evicted; over-budget writes evict oldest first (LRU) after TTL sweep. |
| `storeTtlMs` | number (ms) | `604800000` | Transient entry TTL (1 week). |
| `compactStaleResults` | boolean | deprecated, ignored | Always effective `false`; already-exposed messages stay prefix-stable. Accepted so old configs still load. |
| `nestedResultThreshold` | number | deprecated, ignored | Always effective `null`; internal Fabric provider values are never rewritten. Accepted so old configs still load. |

Bad JSON in `.pi/context-engineer.json` does not throw: defaults load and a warning surfaces in `/ce settings`. Out-of-range numeric budgets are clamped (floored, min/max) with a `/ce settings` warning instead of failing startup.

### Bytes vs tokens

Prefer byte budgets. Static preflight defaults to 8 KB (`quantitativePolicy.maxBytes`) while the runtime auto-offload default is 16 KB (`readOffloadThreshold` / `DEFAULT_RUNTIME_OFFLOAD_BYTES`) because static estimates are conservative upper bounds and runtime measures actual UTF-8 bytes. Token equivalents are heuristic: ~4 chars/token, so 16 KB ≈ 4,000 tokens for ASCII. Multibyte UTF-8 inflates bytes faster than the heuristic implies, and boundary messages report bytes with the ASCII-biased token estimate in parentheses. Invalid `policy` objects are ignored with a `/ce settings` warning; per-budget maximum is 1,000,000,000.

### Selection and compression notes

- `ctx_read({ query })` is literal and case-sensitive by default. Set `regex: true` for a per-line JavaScript RegExp and/or `ignoreCase: true`. Invalid regex and storage failures reject at the Pi tool boundary with structured error diagnostics; internal handlers use `{ error, code, isError: true }`. Storage uses explicit `ok` status, so payloads beginning `Error:` remain valid evidence. Regex/ignore-case scans are bounded and report scan truncation.
- Structural/code summaries of a stored payload inspect a bounded 512 KB prefix and report truncation. Summaries are lossy navigation aids; recover original evidence when exact details matter.

Project configuration is re-read when the file's modification time changes, so tuning does not require an extension reload. `/ce settings` shows effective values, including defaults.

- `strict` or `blockUnboundedReturns` restores fail-closed static enforcement.
- `resultPolicy` is `auto` (threshold-based previews), `inline` (never rewrite boundary results, including errors), `offload` (force addressable handles for successful results), or `summarize` (threshold-based deterministic structural summaries with recovery handles; no child model call). `ctx_read` remains exempt from successful-result offloading to prevent recursive handles.
- `errorCompactionThreshold` and `errorCompactionPreviewBytes` bound oversized model-facing errors, including the recovery recipe in the visible budget. Full original diagnostics are stored first; nested Fabric errors remain untouched.
- `nestedResultThreshold` is deprecated and ignored (effective value `null`): Fabric owns its internal transport limits. CE never substitutes handles for internal provider values.
- `runtimeAdvisoryThreshold: 0` disables repetitive size nudges; use a positive byte threshold to opt in.
- `compactStaleResults` is deprecated and ignored (effective value `false`, even in older configs that set it to `true`). CE never shortens already-exposed messages; use Pi session compaction to reduce accumulated history.
- `compactEditResults` (default `true`) additionally offloads recognized successful 2 KB+ edit envelopes containing a verbose diff/patch. Set it to `false` to keep those results inline below the normal threshold. `resultPolicy: "inline"` still bypasses all successful-result rewriting.
- `notifyOnStart` controls the session-start toast, which is off by default.

Transient context-store entries default to one week (`604800000` ms) and 500 MB (`500000000` bytes). Configured transient storage budgets cannot exceed the 500 MB cap. Payloads use a metadata index plus content-addressed private blobs; writes are atomic and cleanup removes expired, dangling, and over-budget entries.

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
- intermediate-result preservation, including large MCP/Fovea/CE provider proxies under every result policy
- automatic final offload, prefix-stable previews across retries and branches, legacy config compatibility, serialized `ctx_read` envelope caps, and bounded query work
- runtime-first versus strict preflight and deterministic `ctx_summarize` modes
- content deduplication, UTF-8 ranges, unchanged grep inputs (including valid ripgrep-only regex syntax), and lossless multi-text/error recovery
- generated adversarial transformations for aliases, destructuring, callbacks, async wrappers, computed access, loops, and Promise aggregates
- the explicit `src/context-effects.ts` registry used by the analyzer for source/select/compress/offload policy metadata, including current providers and PowerShell/process tools
- JSON-path handle selection, structural previews, oversized error compaction, explicit result policies, and cross-runtime telemetry scopes

Run the generated adversarial suite directly with the normal `npm test` command. It fails closed when an unsafe transformation is classified as safe.

## Real Pi/Fabric smoke test

`npm test` is deterministic and offline. An opt-in smoke test launches the local `pi` CLI with CE and Fabric loaded into a throwaway workspace. It needs a configured model and can incur provider usage:

```sh
CE_RUN_E2E=1 PI_MODEL=<provider>/<model> npm run e2e
```

## License

MIT
