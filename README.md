# pi-context-engineer

A [Pi](https://github.com/badlogic/pi-mono) extension that keeps large tool results out of the model's context. When a result reaching the model is over 16 KB, Context Engineer (CE) stores the full text in a local store and shows the model a short preview and a handle instead. `ctx_read` reads any part of it back on demand.

It works with ordinary Pi tools and with [Pi Fabric](https://github.com/monotykamary/pi-fabric)'s `fabric_exec`, and leaves [Pi Fovea](https://github.com/monotykamary/pi-fovea) results alone when they fit the budget the call asked for.

## What it does

- **Offloads large results.** CE measures the sum of a result's text blocks. Over the threshold, the exact text is stored and replaced by a notice with copyable `ctx_read` calls and a structural preview: JSON keys and short fields, Fabric section names, or head and tail lines. Images keep their positions. If the store fails, the original result stays visible.
- **Compacts oversized errors.** An error result of 4 KB or more keeps its most useful diagnostic lines inline, plus a handle to the complete output.
- **Compacts verbose edit results.** A successful edit whose result carries a diff or patch of 2 KB or more keeps its acknowledgment inline; the full diff stays readable.
- **Completes Fabric-truncated output.** Fabric caps a `fabric_exec` result at 50,000 characters and saves the full text to a temporary file that it soon deletes. When a result arrives truncated like that, CE stores the full text from the file, so the handle also holds the part Fabric left out.
- **Leaves intermediate values alone.** Inside a Fabric program, tool results are program data. CE only rewrites what reaches the model.
- **Keeps exposed messages stable.** CE rewrites a result once, before the model first sees it, and never edits earlier messages, so provider prompt caches stay valid. Pi's session compaction handles accumulated history.
- **Records what it did.** Sizes and strategies, never payloads, go to `.pi/context-store/context-events.jsonl`.

## Reading a handle

At the model boundary call `ctx_read`; inside a Fabric program call `extensions.ctx_read`. Pick the mode that fits the payload:

| Mode | Parameters | Use for |
| --- | --- | --- |
| Byte range | `offset`, `length` | Paging through text. Results include `nextOffset`. |
| Line search | `query`, optional `regex`, `ignoreCase`, `contextLines`, `maxMatches` | Finding lines. Literal and case-sensitive by default. |
| Section | `section`, optional `offset`/`length` | One named part of a Fabric sectioned result. |
| JSON path | `jsonPath`, for example `$.results[0].name` | One value from a JSON payload. No wildcards or slices. |

The offload notice only offers the modes the payload supports. A `ctx_read` result is capped below the offload threshold so reading a handle never produces another handle. If a `fabric_exec` program that reads handles still returns too much, the notice says to narrow the read.

A multi-block result is stored as `{ "textBlocks": [{ "index": 0, "text": "..." }, ...] }`, keeping each block's original position; read one with `jsonPath: "$.textBlocks[0].text"`.

## Tools

All three are callable by the model directly and inside Fabric through `extensions.*`:

- `ctx_read` — read part of a stored payload (see above).
- `ctx_summarize` — deterministic summary of inline `text` or a stored `id`. `mode: "structural"` (default) extracts JSON shape or head and tail lines; `mode: "code"` extracts imports and signatures. `maxTokens` (64–4000) bounds the result. A stored payload is summarized from its first 512 KB.
- `ctx_offload` — store a payload on purpose and get a handle back: `{ key, source, data }`.

```ts
// Inside fabric_exec: keep a large file out of context, then read what you need.
const text = await pi.read({ path: "large.json" });
const handle = await extensions.ctx_offload({ key: "large-json", source: "read", data: text });
return await extensions.ctx_read({ id: handle.details.id, jsonPath: "$.items[0]" });
```

## Fabric child agents

When CE is enabled, each extension-enabled Fabric Pi child that loads CE adds `ctx_read` to its own tool allowlist before Fabric initializes, at every depth, so the child can read back what CE offloaded in it. Like Fabric's own `agents.childQuestionTools` grant, this is skipped for an explicit empty `tools` list and for `+name`/`-name` lists, and a malformed allowlist fails closed. Where no read path exists (a withheld allowlist, or a Pi `--tools` list without `ctx_read`), CE keeps the result inline rather than return a handle nothing can read.

## Telemetry and commands

```text
/ce status          savings in the current session
/ce status --all    savings across every recorded session in the workspace
/ce trace           recent events
/ce settings        effective configuration and warnings
/ce clear           clear telemetry
```

`/ce status` also reports offload follow-up: how many offloaded handles were later read with `ctx_read` or `ctx_summarize`, and how many offloaded calls were run again anyway. A repeat suggests the notice did not make the handle usable and the same output was paid for twice.

The figures are estimates at about 4 bytes per token, not billing data. Reading an existing handle does not count as a second saving.

## Configuration

Defaults fit most projects. To change them, create `.pi/context-engineer.json`:

```json
{
  "enabled": true,
  "readOffloadThreshold": 16384,
  "errorCompactionThreshold": 4096,
  "errorCompactionPreviewBytes": 4096,
  "offloadPreviewBytes": 2048,
  "compactEditResults": true,
  "notifyOnStart": false,
  "storeMaxBytes": 500000000,
  "storeTtlMs": 604800000
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` turns off result rewriting. |
| `readOffloadThreshold` | `16384` | UTF-8 bytes above which a result is offloaded (256–1,000,000,000). |
| `errorCompactionThreshold` | `4096` | UTF-8 bytes from which an error result is compacted (minimum 256). |
| `errorCompactionPreviewBytes` | `4096` | Visible budget of a compacted error, including its recovery call (256–64,000). |
| `offloadPreviewBytes` | `2048` | Preview budget in an offload notice (256–4,096). |
| `compactEditResults` | `true` | Compact verbose edit diffs from 2 KB. |
| `notifyOnStart` | `false` | Show a notification when a session starts. |
| `storeMaxBytes` | `500000000` | Store size cap; cannot exceed 500 MB. The oldest entries are evicted first, never the newest. |
| `storeTtlMs` | `604800000` | How long stored payloads live (one week). |

The file is re-read when it changes. Invalid JSON, out-of-range numbers and settings that earlier versions read (`strict`, `policy`, `resultPolicy` and others) never stop the extension: CE uses the defaults and lists a warning in `/ce settings`.

Budgets are UTF-8 bytes. Token figures assume about 4 bytes per token, which holds for ASCII; multibyte text uses more bytes per token.

## Store

Payloads live in `.pi/context-store` in the workspace: a metadata index plus private content-addressed blobs, written atomically. Identical payloads are stored once. Cleanup removes expired, dangling and over-budget entries as the store is used.

## Install in Pi

```sh
pi install npm:pi-context-engineer      # install
pi -e npm:pi-context-engineer           # try it for one run
pi --extension /path/to/pi-context-engineer/src/index.ts   # from a checkout
```

The package also ships a skill that teaches the model how to read handles.

## Verification

```sh
npm ci
npm test
```

`npm test` builds the extension and runs deterministic, offline hook probes: offload of single and multi-block results, prefix stability, intermediate Fabric values, every `ctx_read` mode and its cap, summaries, error and edit compaction, the Fabric child grant, Pi's native tool error contract, and telemetry.

An opt-in smoke test launches the local `pi` CLI with CE and Fabric in a throwaway workspace. It needs a configured model and can incur provider usage:

```sh
CE_RUN_E2E=1 PI_MODEL=<provider>/<model> npm run e2e
```

## Releases

Pushing a `vX.Y.Z` tag runs `.github/workflows/publish.yml`, which checks the tag against `package.json`, runs the tests, and publishes with npm trusted publishing (no stored npm token). The npm package's Trusted Publishers entry must name GitHub Actions, `p-yan-6908/pi-context-engineer`, and `publish.yml`.

```sh
npm version patch
git push origin main --follow-tags
```

## License

MIT
