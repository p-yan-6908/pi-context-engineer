# pi-context-engineer

A context governor for [Pi](https://github.com/badlogic/pi-mono), [Pi Fabric](https://github.com/monotykamary/pi-fabric), and optionally [Pi Fovea](https://github.com/monotykamary/pi-fovea).

The roles are deliberately separate:

- **Fabric** executes and orchestrates work without exposing intermediate values to Main.
- **Fovea** discovers the most relevant repository regions.
- **Context Engineer** decides what data is allowed to cross the boundary and records the cost.

## Features

### Runtime boundary guard

CE leaves **all** internal Fabric values intact: ordinary `pi.*` results, MCP results, captured Fovea/CE tools, and provider proxy `details.result`. Fabric owns its executor/transport limits. Explicit `ctx_offload` remains available when the program deliberately wants a handle.

At the model boundary CE budgets the **sum of all text blocks**, not just the first. Single-text handles store the exact text unchanged. Multi-text handles store `{ textBlocks: [{ index, text }, ...] }`, preserving every original content-array index; use `jsonPath: "$.textBlocks[0].text"` or byte ranges to recover text. Media retain their positions, short independent notes get a bounded inline allowance, and rewritten slots share one recovery handle. A storage failure leaves the original result visible rather than discarding evidence.

Large final text results are offloaded; budgeted Fovea results that meet their requested size are left alone in auto mode. Artifact metadata alone cannot exempt an oversized payload. JSON previews prioritize short nested status/path/count fields over bulky siblings. Fabric's sectioned-YAML results retain small sections and source-line-labeled outline excerpts; previews are selections, not complete return values. `summarize` uses deterministic structural compression with the full original stored behind a recovery handle. Oversized errors also retain exact originals, not just selected diagnostics.

CE never rewrites grep patterns or other tool arguments. Fabric's catalog repairs handle argument/action naming near-misses; its entropy compiler optimizes tool surfaces. Neither requires CE to guess regex intent.

Recognized successful edit envelopes containing verbose diff/patch strings are compacted from 2 KB onward, even below the ordinary offload threshold. The acknowledgment stays visible and the complete original diff/patch remains retrievable. This only changes model-boundary text, never ordinary intermediate Pi values. Set `compactEditResults: false` to disable the lower edit threshold, or `resultPolicy: "inline"` to bypass successful-result rewriting altogether.

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

CE leaves a Fovea result alone when it fits the `maxTokens` budget the call requested. Context Engineer does not reproduce Fovea's code graph.

### Fabric child agents

When CE is enabled, each extension-enabled Fabric Pi child that loads CE adds `ctx_read` to its own captured-tool allowlist before Fabric initializes, so the child can read back what CE offloaded in it without the caller listing the helper. This repeats at every depth. Like Fabric's own `agents.childQuestionTools` grant, it is skipped for an explicit empty `tools` list and for `+name`/`-name` lists; a malformed allowlist fails closed. Where no read path exists (a withheld allowlist, or a Pi `--tools` list without `ctx_read`), CE keeps the result inline rather than returning a handle that cannot be read. Other CE and Fovea extension tools remain opt-in; an explicit `extensions: false`/`--no-extensions` request and non-Pi runners are still intentional opt-outs.

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
  "readOffloadThreshold": 16384,
  "resultPolicy": "auto",
  "errorCompactionThreshold": 4096,
  "errorCompactionPreviewBytes": 4096,
  "offloadPreviewBytes": 2048,
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
| `readOffloadThreshold` | number (bytes) | `16384` | Offload budget for boundary text results. Clamped to 256–1,000,000,000; clamps surface via `/ce settings` warnings. |
| `resultPolicy` | `"auto" \| "inline" \| "offload" \| "summarize"` | `"auto"` | `auto` previews/offloads by threshold; `inline` preserves all results (including errors); `offload` forces handles for successful results; `summarize` uses threshold-based deterministic structural compression with exact recovery (no model call). |
| `errorCompactionThreshold` | number (bytes) | `4096` | Model-boundary errors at/above this size are compacted (min 256). |
| `errorCompactionPreviewBytes` | number (bytes) | `4096` | Visible budget retained by a compacted error, including the recovery recipe (256–64,000). |
| `offloadPreviewBytes` | number (bytes) | `2048` | Structural first-use handle preview budget (256–4,096). |
| `compactEditResults` | boolean | `true` | Compact recognized verbose 2 KB+ successful edit envelopes (diff/patch) into an acknowledgment + recovery handle. Set `false` to keep them inline. |
| `notifyOnStart` | boolean | `false` | Opt into the session-start toast. |
| `storeMaxBytes` | number (bytes) | `500000000` | Transient store cap; cannot exceed 500 MB. Newest write is never evicted; over-budget writes evict oldest first (LRU) after TTL sweep. |
| `storeTtlMs` | number (ms) | `604800000` | Transient entry TTL (1 week). |
| `compactStaleResults` | boolean | deprecated, ignored | Always effective `false`; already-exposed messages stay prefix-stable. Accepted so old configs still load. |
| `nestedResultThreshold` | number | deprecated, ignored | Always effective `null`; internal Fabric provider values are never rewritten. Accepted so old configs still load. |

Bad JSON in `.pi/context-engineer.json` does not throw: defaults load and a warning surfaces in `/ce settings`. Out-of-range numeric budgets are clamped (floored, min/max) with a `/ce settings` warning instead of failing startup.

### Bytes vs tokens

Prefer byte budgets. The offload default is 16 KB of actual UTF-8 bytes. Token equivalents are heuristic: ~4 chars/token, so 16 KB ≈ 4,000 tokens for ASCII. Multibyte UTF-8 inflates bytes faster than the heuristic implies, and boundary messages report bytes with the ASCII-biased token estimate in parentheses.

### Selection and compression notes

- `ctx_read({ query })` is literal and case-sensitive by default. Set `regex: true` for a per-line JavaScript RegExp and/or `ignoreCase: true`. Invalid regex and storage failures reject at the Pi tool boundary with structured error diagnostics; internal handlers use `{ error, code, isError: true }`. Storage uses explicit `ok` status, so payloads beginning `Error:` remain valid evidence. Regex/ignore-case scans are bounded and report scan truncation.
- Structural/code summaries of a stored payload inspect a bounded 512 KB prefix and report truncation. Summaries are lossy navigation aids; recover original evidence when exact details matter.

Project configuration is re-read when the file's modification time changes, so tuning does not require an extension reload. `/ce settings` shows effective values, including defaults.

- `resultPolicy` is `auto` (threshold-based previews), `inline` (never rewrite boundary results, including errors), `offload` (force addressable handles for successful results), or `summarize` (threshold-based deterministic structural summaries with recovery handles; no child model call). `ctx_read` remains exempt from successful-result offloading to prevent recursive handles.
- `errorCompactionThreshold` and `errorCompactionPreviewBytes` bound oversized model-facing errors, including the recovery recipe in the visible budget. Full original diagnostics are stored first; nested Fabric errors remain untouched.
- `nestedResultThreshold` is deprecated and ignored (effective value `null`): Fabric owns its internal transport limits. CE never substitutes handles for internal provider values.
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

`npm test` builds the extension and runs live hook probes covering:

- boundary offload of single and multi-block text, media positions, storage failure, and prefix-stable previews across retries and branches
- intermediate Fabric results, including large provider proxies, left byte-for-byte intact
- `ctx_read` ranges, queries, sections, JSON paths, UTF-8 boundaries, and its serialized-envelope cap
- deterministic `ctx_summarize` modes, error compaction, edit-diff compaction, and result policies
- the Fabric child `ctx_read` grant, inline fallback without a read path, and Pi's native tool error contract
- telemetry scopes, legacy event files, and offload follow-up accounting

## Real Pi/Fabric smoke test

`npm test` is deterministic and offline. An opt-in smoke test launches the local `pi` CLI with CE and Fabric loaded into a throwaway workspace. It needs a configured model and can incur provider usage:

```sh
CE_RUN_E2E=1 PI_MODEL=<provider>/<model> npm run e2e
```

## License

MIT
