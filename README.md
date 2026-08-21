# pi-context-engineer

Context-engineering enforcement for [Pi](https://github.com/badlogic/pi-mono) and Pi Fabric.

The extension helps keep large tool results out of the model context by enforcing **Write**, **Select**, **Compress**, and **Isolate** workflows.

## What it does

- Intercepts `fabric_exec` before execution and blocks raw or near-raw tool passthroughs.
- Warns about oversized estimated returns and supports strict blocking.
- Automatically repairs common literal-search mistakes in `grep` calls.
- Offloads large text results to `.pi/context-store/` and returns a handle plus preview.
- Provides `ctx_read`, `ctx_summarize`, `ctx_remember`, `ctx_recall`, `ctx_delegate`, `ctx_offload`, and `ce_exec`.
- Exposes the context helpers inside Fabric code mode through `extensions.ctx_*`.

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

## Configuration

Create `.pi/context-engineer.json` in a project when needed:

```json
{
  "enabled": true,
  "strict": false,
  "maxUnprocessedToolCalls": 3,
  "maxReturnTokens": 4000,
  "readOffloadThreshold": 8192
}
```

`strict` turns soft warnings, such as oversized estimated returns, into blocks. Hard raw-passthrough violations are blocked by default.

## Loading

The package manifest declares the extension and skill. It can also be loaded explicitly:

```sh
pi --extension /path/to/pi-context-engineer/src/index.ts
```

## Verification

```sh
npx tsc --noEmit --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --skipLibCheck src/*.ts

rm -rf .tmp/pi-ce-build
npx tsc --outDir .tmp/pi-ce-build --rootDir src \
  --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --skipLibCheck src/*.ts
node .tmp/pi-ce-build/verify.js
node .tmp/pi-ce-build/verify-hooks.js
rm -rf .tmp
```

## License

MIT
