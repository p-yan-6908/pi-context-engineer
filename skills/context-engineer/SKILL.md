---
name: context-engineer
description: >-
  Operational playbook for the context-engineer extension — the model boundary
  that auto-offloads oversized tool results into stored handles and serves
  slices back through ctx_read. Load when a tool result returns as a handle or
  a "see section" preview, when choosing a ctx_read access mode (query /
  offset+length / section / jsonPath), when a ctx_* call fails (not valid JSON
  for jsonPath, missing or expired handle, invalid bracket segment), when
  offloading or summarizing a large payload, or when deciding whether to
  aggregate in-guest instead of offloading. NOT for cross-session history
  (use the memory/session layer) or corpus-wide search (use grep).
---

# context-engineer — the model-boundary playbook

context-engineer (CE) keeps oversized data out of the model window. The main
event is **automatic**: a tool result above the offload threshold (16 KB by
default) never reaches you verbatim — you get a structural preview plus a
handle, and you pull back exactly the slice you need. Everything below is
about doing that well.

## Mental model

- **Auto-offload is the main path.** When a `fabric_exec` / `pi.*` / `mcp.*`
  return is huge, expect preview + handle. That is the tool working, not an
  error. The notice lists the `ctx_read` calls that fit that payload.
- **The preview is an index.** It names every part of headed output (files,
  headings, `--- name ---` markers, grep results by file) with its byte
  offset, every Fabric section with its first lines, or the byte ranges of
  the head and tail it shows. Start a range read at an offset it gives; the
  notice's suggested range starts where the preview stops, not at 0.
- **Read the handle; do not re-run the call.** The full result is stored,
  including the middle of a `fabric_exec` output that Fabric itself
  truncated. Re-running pays for the same output again and may repeat side
  effects.
- **Handles live in the workspace store** (`.pi/context-store/`, one week and
  500 MB by default). `no stored result with id` means the handle expired, was
  evicted, or belongs to another working directory; only then re-run the source.
- **Handles nest.** If a program that reads handles returns too much, its
  return is offloaded again and the notice says so. Narrow the selection
  instead of reading the new handle back whole.

## Decision tree: a big result came back as a handle

1. **Is the preview enough?** Often it is. Don't read handles you don't need.
2. **Need a field name or any text occurrence?** → `query` (literal line
   search; an array of terms matches lines with any of them; `regex: true`
   for a pattern, `ignoreCase: true` to fold case).
3. **Need a bounded window?** → `offset` + `length` from an offset in the
   preview; continue at `nextOffset`.
4. **Need a named part of a Fabric sectioned result?** → `section`, using a
   name from the preview's section list; `offset`/`length` page inside it.
5. **Need precise JSON values?** → `jsonPath`, only when the payload is JSON
   (Rule #1).
6. **Need a digest rather than a slice?** → `ctx_summarize`
   (`structural` / `code`).
7. **Need to filter, count or join across the whole payload?** → inside
   `fabric_exec`, `(await extensions.ctx_read({ id })).text` returns up to
   512 KB. Filter with code and return only the result.

## Rule #1: payload type decides the access mode

| Payload | Works | Breaks |
|---|---|---|
| Fabric sectioned result (preview lists `Section "…"` entries) | `section`, `query`, `offset`+`length` | `jsonPath` |
| JSON, including multi-block handles stored as `{ textBlocks }` | `jsonPath`, `query`, `offset`+`length` | `section` |
| Plain text, logs, code | `query`, `offset`+`length` | `jsonPath`, `section` |

`jsonPath` on a non-JSON handle fails with `stored result ... is not valid
JSON`. Automatic offload notices offer `jsonPath` only for JSON payloads and
`section` only for sectioned ones. For a manual `ctx_offload` handle, read the
preview first.

## ctx_read — the workhorse

Inside `fabric_exec`, call `extensions.ctx_read(...)`; at the model boundary,
call `ctx_read` directly. At the boundary a result shows the selected text
under a header such as `[ctx_read "id": bytes 4096-8192 of 20090]` and stays
under the offload threshold. In a program the cap is 512 KB: `.text` is the
selected text and `.details.result` holds `totalBytes`, `nextOffset`,
`totalMatches` and the rest.

```ts
// search: a field name or any occurrence inside the handle
await extensions.ctx_read({ id, query: "perTool" });

// any of several terms, with per-term counts in termMatches
await extensions.ctx_read({ id, query: ["perTool", "returnFlow"] });

// byte range: start at an offset from the preview; continue at nextOffset
await extensions.ctx_read({ id, offset: 4351, length: 4000 });

// whole payload, filtered in the program
const lines = (await extensions.ctx_read({ id })).text.split("\n");
return lines.filter((line) => line.includes("FAIL")).length;

// one section of a Fabric sectioned result, paged inside the section
await extensions.ctx_read({ id, section: "details.diff", offset: 0, length: 4000 });

// JSON value access (JSON handles only)
await extensions.ctx_read({ id, jsonPath: "$.details.result.text" });
```

jsonPath dialect: `$.a.b`, `$.a[0].b`, `$.a["odd key"]`. **No wildcards or
slices** — `$.hits[*].text` and `$.hits[0:5].text` fail with
`invalid bracket segment`. Read indices one at a time, or use `query`.

## Field recipes

**R0 — aggregate in-guest before offloading.** The cheapest byte is the one
you never store: project large structured input to a compact representation
(counts, filtered rows, the fields you need) inside the guest and return it.
Offload is the fallback, not step one.

**R1 — auto-offloaded result → targeted reads.** The preview is already in
context; read what it leaves out, or filter the whole payload in a program:

```ts
const part = (await extensions.ctx_read({ id, offset: 4351, length: 4000 })).text;
const hits = (await extensions.ctx_read({ id, query: ["perTool", "returnFlow"] })).text;
const all = (await extensions.ctx_read({ id })).text;
return all.split("\n").filter((line) => line.startsWith("ERROR")).slice(0, 20);
```

Return `.text` or a digest, never the whole read object: its envelope repeats
the text. If a program that reads handles comes back as a handle itself, it
returned too much: filter or aggregate in the program first.

**R2 — heavy external JSON → `ctx_offload` + `jsonPath`:**

```ts
const h = await extensions.ctx_offload({ key: "api-response", source: "mcp", data: txt });
const first = await extensions.ctx_read({ id: h.details.id, jsonPath: "$.items[0].name" });
```

**R3 — `ctx_summarize` with deterministic modes.** `structural` and `code` are
deterministic and make no model call:

```ts
const s = await extensions.ctx_summarize({ text: raw, mode: "structural", maxTokens: 2000 });
return s.text; // project to .text — don't re-serialize the envelope
```

## Failures → recovery

| Error | Root cause | Fix |
|---|---|---|
| `stored result ... is not valid JSON` | `jsonPath` on a text or sectioned handle | switch to `section` / `query` / `offset`+`length` |
| `JSON path ... was not found` | structure differs from expectation | read a small window first, then re-path |
| `invalid bracket segment "0:5"` or `"*"` | slices and wildcards are unsupported | `$.a[0].b` per index, or `query` |
| `has no section "…"; available: …` | wrong section name | use a name from the error or the preview |
| `is not a Fabric sectioned result` | `section` on a plain or JSON handle | `query` / `offset`+`length` / `jsonPath` |
| `no stored result with id` / `has expired` | expired, evicted, or another working directory | re-run the source call |
| `No matches for "a b c"` with per-word counts | a phrase is one literal string | pass the suggested array, e.g. `query: ["a", "c"]` |
| `No matches` with `match ignoring case` | case differs | add `ignoreCase: true` |
| result isn't a string (`.slice is not a function`) | `extensions.ctx_read` returned its envelope | take `.text`; metadata is in `.details.result` |

## Fabric child agents

When CE is enabled, extension-enabled Fabric Pi children at any depth
automatically receive `ctx_read`, so their offload handles stay readable
without `tools: ["ctx_read"]`. The grant is skipped for an explicit empty
`tools` list and for `+name`/`-name` lists; CE then keeps results inline
instead of offloading. Other CE/Fovea extension tools remain opt-in; explicit
`extensions: false` and non-Pi runners are intentional opt-outs.

## Boundaries

- **Not cross-session memory.** Handles expire with the store's retention
  limits; history lives in the session/memory layer.
- **Not a search engine.** `query` searches one handle; corpus-wide search
  belongs to grep/Fovea.
- **Not a gate to fight.** Nothing is blocked: small results pass through
  untouched and large ones are offloaded after they run.

## Tools

| Tool | Purpose |
|---|---|
| `ctx_read` | pull slices, sections, or JSON values from a handle (the workhorse) |
| `ctx_offload` | manually park a large payload → handle |
| `ctx_summarize` | deterministic (`structural`/`code`) compression |

## Configuration

Defaults fit most workloads; the package README lists the thresholds.
