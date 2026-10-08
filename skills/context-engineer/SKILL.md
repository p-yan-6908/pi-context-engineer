---
name: context-engineer
description: >-
  Operational playbook for the context-engineer extension — the model boundary
  that auto-offloads oversized tool results into session-scoped handles and
  serves slices back through ctx_read. Load when a tool result returns as a
  handle or "see section" preview, when choosing a ctx_read access mode
  (query / offset / length / jsonPath / section), when a ctx_* call fails
  (invalid JSON for jsonPath, stale handle, invalid bracket segment), when
  offloading or summarizing a large payload, or when deciding whether to
  aggregate in-guest instead of offloading. NOT for cross-session history
  (use the memory/session layer) or corpus-wide search (use grep).
---

# context-engineer — the model-boundary playbook

context-engineer (CE) keeps oversized data out of the model window. The main
event is **automatic**: a tool result above the offload threshold (~16 KB)
never reaches you verbatim — you get a short structural preview plus a
handle, and you pull back exactly the slice you need. Everything below is
about doing that well.

Field stats that shape this playbook: `ctx_read` is ~91% of all CE traffic;
auto-offload outnumbers manual `ctx_offload` 55:1; ~10% of calls fail — almost
all on one mistake: wrong access mode for the handle type (§ Rule #1).

## Mental model

- **Auto-offload is the main path.** When a `fabric_exec` / `pi.*` / `mcp.*`
  return is huge, expect preview + handle. That is the tool working, not an error.
- **Handles are session-scoped.** The store does not survive a restart. A stale
  handle fails with `no stored result with id` — re-offload the source.
- **Handles nest.** A `ctx_read` return can itself come back sectioned. Read raw
  slices with `offset`/`length`; never fight the handle by re-reading the raw
  source or hand-chunking data into mesh.

## Decision tree: a big result came back as a handle

1. **Is the preview enough?** Often it is. Don't read handles you don't need.
2. **Need one field name or any text occurrence?** → `query` (text search over
   the handle; good for field names, error strings, per-tool counters).
3. **Need a bounded window?** → `offset` + `length` (e.g. the first 4 KB).
4. **Need a named part?** → `section` (sectioned previews expose named parts).
5. **Need precise JSON nodes?** → `jsonPath` — but only if the handle content
   is JSON (§ Rule #1 below).
6. **Need a digest rather than a slice?** → `ctx_summarize`
   (`structural` / `code`).

## Rule #1: handle type decides the access mode

| Handle origin | Content shape | Works | Breaks |
|---|---|---|---|
| Auto-offloaded tool result | sectioned text / YAML preview | `query`, `section`, `offset`+`length` | `jsonPath` |
| `ctx_offload` of a JSON payload | JSON | `jsonPath`, `query`, `offset`+`length` | — |
| `ctx_offload` of text | text | `query`, `offset`+`length` | `jsonPath` |

`jsonPath` against a text handle is the dominant field error:
`stored result is not valid JSON; jsonPath cannot be selected`. There is no
type probe — read the preview first: if it reads like YAML or prose, don't
reach for `jsonPath`.

## ctx_read — the workhorse

```ts
// search: a field name or any occurrence inside the handle
await extensions.ctx_read({ id, query: "perTool" });

// byte-range: bounded windows
await extensions.ctx_read({ id, offset: 0, length: 4000 });

// named section of a sectioned preview
await extensions.ctx_read({ id, section: "proposal" });

// JSON node access (JSON handles only)
await extensions.ctx_read({ id, jsonPath: "$.details.result.text" });
```

jsonPath dialect: `$.a.b`, `$.a[0].b`, `$.a[*].b`. **No slices** —
`$.hits[0:5].text` fails with `invalid bracket segment "0:5"`. Iterate indices
or use `query`.

## Field recipes

**R0 — aggregate in-guest before offloading.** The cheapest byte is the one
you never store: project large structured input to a compact representation
(tree, counts, filtered rows) inside the guest and return it. Offload is the
fallback, not step one.

**R1 — auto-offloaded result → slice reads** (≈half of all CE traffic). The
preview is already in context; pull the rest on demand:

```ts
const slice = await extensions.ctx_read({ id, offset: 0, length: 4000 });
const field = await extensions.ctx_read({ id, query: "perTool" });
```

If a `ctx_read` result itself comes back as a handle — your slice was too big: narrow the window (`length`), tighten the `query`, or aggregate in-guest and return a digest.

**R2 — heavy external JSON → `ctx_offload` + `jsonPath`:**

```ts
const h = await extensions.ctx_offload({ key: "pixso-dsl", source: "pixso-remote", data: txt });
const nodes = await extensions.ctx_read({ id: h.id, jsonPath: "$.dsl.pixDslNodes[*].name" });
```

**R3 — `ctx_summarize` with deterministic modes.** `structural` and `code` are
deterministic (no model call); `model` spends an isolated model call — use it
only when semantics demand it:

```ts
const s = await extensions.ctx_summarize({ text: raw, mode: "structural", maxTokens: 2000 });
return s.text; // project to .text — don't re-serialize the envelope
```

**R4 — `ctx_remember` for cross-session lessons only** (e.g. prompting quirks
of a vision subagent), not for facts derivable from code.

Always call from guest code with the `extensions.` prefix:
`extensions.ctx_read(...)`.

## Failures → recovery

| Error | Root cause | Fix |
|---|---|---|
| `stored result is not valid JSON; jsonPath cannot be selected` | `jsonPath` on a text/YAML handle | switch to `query` / `section` / `offset`+`length` |
| `JSON path was not found in stored result` | structure differs from expectation | read a small window first, then re-path |
| `invalid bracket segment "0:5"` | slice syntax unsupported | `$.a[0].b` per index, or `query` |
| `no stored result with id` | stale handle from an earlier session | re-offload the source |
| result isn't a string (`.slice is not a function`) | mode returned an object | take the field you need, or use `offset`/`length` |

## Boundaries

- **Not cross-session memory.** Handles die with the session; history lives in
  the session/memory layer, not here.
- **Not a search engine.** `query` is a text search over one handle;
  corpus-wide search belongs to grep/memory.
- **Not a gate to fight.** The boundary is advisory by default; results small
  enough pass through untouched.
- `ce_exec` runs the static boundary diagnostic on demand — rarely needed;
  preflight is automatic.

## Tools

| Tool | Purpose |
|---|---|
| `ctx_read` | pull slices/fields from a handle (the workhorse) |
| `ctx_offload` | manually park a large payload → handle |
| `ctx_summarize` | deterministic (`structural`/`code`) or semantic (`model`) compression |
| `ctx_remember` / `ctx_recall` | persistent lesson store across sessions |
| `ctx_status` | store size/entries at a glance |
| `ctx_forget` | drop a stored entry |
| `ctx_delegate` | move separable work to an isolated context |
| `ce_exec` | explicit static boundary diagnostic |

## Configuration

Defaults fit almost every workload (field data: zero config changes in five
months of heavy use). `strict`, `blockUnboundedReturns` and `resultPolicy`
exist for fail-closed preflight and explicit policy — see the package README.
