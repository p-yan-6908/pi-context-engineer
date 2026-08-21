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
- `PROJECTED` — scalar fields, counts, keys, and field projections
- `SELECTED` — slices, filters, matches, bounded Fovea results
- `AGGREGATED` — reductions and scalar summaries
- `COMPRESSED` — context summaries
- `OFFLOADED` — disk handles

Raw, encoded, and unknown tainted returns are blocked. Oversized static returns warn by default and block in strict mode. The number of internal calls is no longer the primary limit: a Fabric program may make many calls when it returns a small, meaningful result.

### Runtime boundary guard

The extension preserves ordinary intermediate `pi.*` results while Fabric code is running. It also consumes Fabric's documented nested provider-result proxy:

1. inspect the actual provider value before QuickJS receives it;
2. offload oversized provider values to `.pi/context-store/`;
3. patch the structured proxy value with a handle and preview;
4. leave already-bounded Fabric and Fovea results alone.

Large final text results are likewise offloaded, but existing Fabric artifact-backed results and budgeted Fovea results are not offloaded a second time.

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

### Addressable context store

Stored payloads include content hashes, provenance/source, content type, creation/access timestamps, estimated tokens, and optional expiry. Identical payloads deduplicate. `ctx_read` supports UTF-8 byte ranges and literal line queries. Optional TTL and disk budgets provide garbage collection.

### Telemetry

The extension records sizes and strategies—not prompts or payloads—in `.pi/context-store/context-events.jsonl`.

Interactive commands:

```text
/ce status          current-session observed savings
/ce status --all   all recorded workspace sessions
/ce trace          recent policy events
/ce explain        current architecture and policy
/ce settings       effective project configuration
/ce clear          clear telemetry
```

The numbers are approximate context-token estimates, useful for comparing policies rather than billing reconciliation.

## Fabric example

```ts
const result = await pi.grep({ pattern: "TODO", path: "src" });

return extensions.ctx_summarize({
  text: result,
  mode: "structural",
  maxTokens: 300,
});
```

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
- `ctx_summarize` — free structural compression or isolated no-tools model compression
- `ctx_remember` / `ctx_recall` — durable project facts with bounded recall
- `ctx_delegate` — isolated child Pi fallback for separable tasks
- `ctx_offload` — manual Write operation
- `ce_exec` — explicit static preflight (`PASS`, `WARN`, or `BLOCK`)

For Fabric-native orchestration and recursive decomposition, call Fabric's `agents.*` APIs directly when available.

## Configuration

Create `.pi/context-engineer.json` in a project when needed:

```json
{
  "enabled": true,
  "strict": false,
  "maxReturnTokens": 4000,
  "readOffloadThreshold": 8192,
  "nestedResultThreshold": 8192,
  "storeMaxBytes": 50000000,
  "storeTtlMs": 604800000
}
```

`maxUnprocessedToolCalls` remains accepted for compatibility with older configurations, but reduction and observed context cost are the primary policy signals.

`strict` turns soft warnings, such as oversized estimated returns, into blocks. Hard raw/encoded/unknown data-flow violations are blocked by default.

## Loading

The package manifest declares the extension and skill. It can also be loaded explicitly:

```sh
pi --extension /path/to/pi-context-engineer/src/index.ts
```

## Verification

```sh
npm ci
npm test
```

The test suite includes 32 static data-flow cases and live hook probes covering:

- aliases and destructuring
- `String`/`JSON.stringify` false reductions
- unknown helper arguments
- callback projections and identity maps
- `Promise.all`
- bounded and unbounded Fovea calls
- nested Fabric provider proxies
- intermediate-result preservation
- automatic offload and self-capping `ctx_read`
- content deduplication and UTF-8 ranges

## License

MIT
