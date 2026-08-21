---
name: context-engineer
description: "Enforces context engineering in Pi Fabric programs: blocks raw tool passthroughs, offloads large results, and provides select/compress/remember/delegate tools."
---

# 👁️ context-engineer

`pi-context-engineer` is a Pi extension that keeps large or unprocessed tool results out of the model context.

## Quick start

```bash
pi install /path/to/pi-context-engineer
```

The extension requires `pi-fabric` for `fabric_exec` interception. The standalone `ctx_*` tools work in ordinary Pi sessions too.

## What it enforces

The live `fabric_exec` tool is checked automatically before execution:

- **BLOCK:** raw or near-raw tool results are returned directly
- **BLOCK:** too many unprocessed tool calls
- **WARN:** oversized literal returns, unless strict mode is enabled
- **PASS:** projected, filtered, summarized, offloaded, or delegated results

Current Fabric programs use `pi.*` for Pi core tools:

```ts
const text = await pi.read({ path: "src/index.ts" });
return { lines: text.split("\n").length };
```

Older `tools.*` programs and `mcp.*` calls are also recognized.

## The four strategies

| Strategy | Purpose | Tools |
|---|---|---|
| **Write** | Store heavy data or durable facts | `ctx_offload`, `ctx_remember` |
| **Select** | Retrieve only a slice or matching lines | `ctx_read` |
| **Compress** | Produce a structural or model summary | `ctx_summarize` |
| **Isolate** | Delegate a separable task to a fresh Pi process | `ctx_delegate` |

Inside a Fabric program, call registered extension tools through `extensions.*`:

```ts
const result = await pi.grep({ pattern: "TODO", path: "src" });
return extensions.ctx_summarize({ text: result, mode: "structural" });
```

For manual offloading:

```ts
const text = await pi.read({ path: "large.json" });
return extensions.ctx_offload({
  key: "large-json",
  source: "read",
  data: text,
});
```

`ce_exec` is an explicit preflight validator. It does not execute the program; the `fabric_exec` hook performs the real enforcement automatically.

## Standalone tools

- `ctx_read`: read a 0-based byte range or search for a literal substring in a stored handle
- `ctx_summarize`: structural summarization is local and deterministic; model mode uses an isolated no-tools Pi call
- `ctx_remember` / `ctx_recall`: persist and retrieve project-scoped facts
- `ctx_delegate`: run a task in a fresh, isolated Pi process and return its final response
- `ctx_offload`: manually write a payload and return a handle plus preview

## Automatic protections

- Large text tool results (8 KB by default) are written to `<workspace>/.pi/context-store/` and replaced by a handle and preview.
- Grep patterns containing likely-unescaped code punctuation are changed to `literal: true` before execution.
- Set `enabled: false` to disable all protections.

## Configuration

Create `<repo>/.pi/context-engineer.json`:

```json
{
  "enabled": true,
  "strict": false,
  "maxUnprocessedToolCalls": 3,
  "maxReturnTokens": 4000,
  "readOffloadThreshold": 8192
}
```

- `strict`: turn warnings into blocks
- `maxUnprocessedToolCalls`: maximum unprocessed data calls
- `maxReturnTokens`: estimated literal-return threshold
- `readOffloadThreshold`: text-result offload threshold in bytes/characters

## Storage

Payloads are stored as self-describing JSON files under `<workspace>/.pi/context-store/`. Durable facts use `<workspace>/.pi/agent/context-store/`. Handles are deterministic and survive session restarts.
