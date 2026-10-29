# Changelog

## Unreleased

Based on 62 recorded Pi sessions with Context Engineer active (12,476 model requests, 1.28 billion input tokens). Tool results make up about half of that input. An inline result is sent again with about 85 later requests before compaction, and each request carries about 103,000 tokens of context, so a needless request costs about as much as keeping 5 KB of result through those 85 requests.

- A `fabric_exec` result that fits the call's own `maxOutputTokens` (or `max_output_tokens`) stays inline, as a Fovea result within its `maxTokens` already did and as Fabric's Claude Code host already decides. 37 offloaded results fit the budget their call had set, and the next call read 23 of them back. A result Fabric truncated did not fit, so it is still offloaded with its full output; the turn budget still applies.
- A program that reads handles and overflows again is told the `maxOutputTokens` that keeps a result that size inline, when Fabric's 50,000-character cap allows it. Since 0.8.0 let a program read 512 KB at once, 16 of 67 offloads were such re-offloads, against about 6% before, and the notice said to filter without naming a size.
- Telemetry records whether the model's next call read an offloaded handle, by naming it or with `ctx_read`, and `/ce status` reports the rate. A lower threshold or a smaller preview pays only while that rate stays low. Since 0.8.0 the next call read 36 of 67 offloads, 32 of them through a section the preview listed.

### Claude Code

- The package ships its Claude Code host in `claude-code/`: the shim of Pi's extension API that runs this extension, the per-session daemon and its client, and the guide the model reads there. The `ce` Claude Code mod carried its own copies, so a change here reached Claude Code only once the mod was edited to match. It now loads them from the package it resolves, and `npm test` drives the host against the built extension.
- In Claude Code each model request starts a turn, as in Pi, rather than each prompt, so `turnBudgetBytes` counts the same in both hosts. Fabric there hands CE every result with the call's `maxOutputTokens` instead of keeping budgeted ones back, so the budget rule above decides in both hosts and every result reaches telemetry: 49 of the 89 results since the mod landed had set a budget and never reached CE.

## 0.9.0

- Admit automatic offloads before committing or evicting stored handles; rejected candidates leave the store unchanged.
- Resolve nested Fabric section headers using declared lengths and fall back to exact byte ranges when shortened boundaries are ambiguous.
- Fingerprint telemetry handle references, omit untrusted storage-error messages, and preserve cross-session accounting for legacy events. Existing telemetry is not deleted.
- Clarify the Pi TypeScript-loader requirement for the projection export, include the README cover in packages, and typecheck in the publish workflow.
- Preserve whitespace in Fabric section reads, and warn when Fabric's full-output artifact is unavailable instead of claiming a truncated fragment is complete.
- Document safe paged program reads and whole-payload literal query counts. Require complete per-request benchmark usage and report incomplete arm totals as unknown.

- Preserve native Pi `executeTool` intermediates using explicit parent-call lineage, with legacy Fabric IDs as a fallback. Native program reads keep their 512 KB budget and bare text without misclassifying concurrent model calls.
- Merge overlapping query context and return query-bound `nextCursor` continuations. Page matches, context and oversized UTF-8 lines without skipping text; expose regex prefix scan limits explicitly.
- Report `readbackTokens` and signed `netTokensSaved` alongside gross prevention. Attribute program-derived outputs and cross-session readbacks without crediting offload chains twice.
- Use one payload-specific recovery example, omit repeated previews, and require `minimumSavingsBytes` (default 256) before automatic replacement. Export the non-mutating, opt-in `projectToolResult` utility.
- Add optional soft `turnBudgetBytes` for cumulative new text without rewriting exposed history.
- Add real native-Pi faux-provider regressions and an opt-in task-level CE-on/off benchmark with quality, input/cache usage, calls, latency and cost estimates. Resolve current Fabric bootstrap paths for CLI probes.
- Test against Pi 1.4. Development resolution pins an available bowser tarball and patched undici; host-provided peer ranges remain unchanged.

## 0.8.1

### Packaging

- Follows the Pi package conventions for the [pi.dev](https://pi.dev/packages) gallery: a cover image through `pi.image`, the `pi-extension` keyword, and `"*"` ranges for the host-provided peers `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`, as the package docs ask.
- Drops the `types` and `pi.providesTools` fields. Neither Pi, Fabric nor the gallery reads them, and `types` is TypeScript's declaration-entry field.

## 0.8.0

Changes below are based on 1,456 offloads across 56 of 295 recorded Pi sessions, all from before 0.7.0.

### Previews work as an index

- Headed output gets an outline: file separators such as `===== path =====`, markdown headings, `--- name ---` markers, `diff --git` headers, and grep output grouped by file. Each part is listed with its byte offset and size, followed by its first lines, filled in turn while the budget lasts. Earlier previews showed the first and last files and left the ones in between unnamed.
- Fabric sectioned results show each section's first lines instead of the outline's `"<multi-line string, see section: …>"` pointer rows plus only the smallest section in full.
- Head and tail previews state the byte ranges they show (`bytes 0-1214 and 30362-31105 of 31105`) and cut at line ends.
- The suggested range read starts at the first byte the preview leaves out. Earlier notices suggested `offset: 0`, and about 60% of range reads started there, re-reading the head the preview had already shown. Sectioned notices suggest a section read instead of a payload range.

### ctx_read

- Inside a Fabric program a read is program data, so it is no longer held under the boundary offload threshold: one read returns up to 512 KB. Programs had looped over 15 KB windows to rebuild payloads before filtering them.
- In a program, `.text` is the selected text, without the paging note, and `.details.result` holds the metadata without a second copy of it. Fabric's envelope previously carried the slice three times: twice as escaped JSON and once raw. Of 207 programs that returned a read directly, 36 were offloaded again.
- At the model boundary a read shows the selected text under a one-line header such as `[ctx_read "id": bytes 4096-8192 of 20090]`, instead of a pretty-printed JSON envelope with escaped newlines. `details.result` is unchanged.
- `query` accepts an array of terms and matches lines containing any of them, with per-term counts in `termMatches`. Ten of the 26 real query misses were keyword lists such as `"returnFlow metrics returnOperation"` matched as one literal string.
- A query that matches nothing still says so first. It then reports any lines that match ignoring case, regex syntax in a literal query, and how many lines each word of a phrase matches, naming the call that would find them.
- Queries run in one place in the store. Literal queries, including `ignoreCase` ones, scan the whole payload; regex queries still scan the first 512 KB and say so.

### Telemetry

- `ctx_read` events record their mode, the start of a range read and the match count of a query, never the query text. `/ce status` and `offloadFollowUp.reads` report reads by mode, range reads from offset 0, queries without matches, and reads inside programs.

## 0.7.0

### Removed

- `resultPolicy` (`inline`, `offload`, `summarize`) and the deprecated `compactStaleResults` and `nestedResultThreshold` keys. No recorded configuration set them, and `enabled: false` covers the inline case. The `/ce explain` command, which restated the README, is gone too.
- The static preflight analyzer: `strict`, `blockUnboundedReturns`, `explainProgram`, and the context-effect registry and quantitative-policy exports. It could only block a program before it ran, 0.6.0 had already made it advisory by default, and no recorded configuration enabled it; the runtime boundary bounds every actual result. The opt-in runtime size advisory goes with it. CE no longer depends on TypeScript at runtime, and `/ce settings` warns about a config that still sets a removed key.
- `ctx_remember`, `ctx_recall` and `ctx_forget`, with their persistent memory store. None was called in 295 recorded Pi sessions; Fabric's `memory` provider already recalls session history.
- `ctx_delegate`, `ctx_summarize` `mode: "model"`, and the child Pi runner, generation-budget extension and Usage accounting they shared. Each tool was called five times across those sessions, mostly as probes, and Fabric's `agents.run` delegates with a fresh context.
- The `ctx_status` and `ce_exec` tools. `/ce status` and `/ce settings` report the same telemetry and policy to the user, and models called `ctx_status` mostly to inspect CE itself. Telemetry drops its per-runtime scope and child-usage fields.
- The benchmark harnesses: the deterministic plumbing benchmark (its known-marker checks duplicated `npm test` and measured CE against a baseline that shows every byte), the static-policy benchmark, and the paid paired-effectiveness harness, which was never run. The opt-in real Pi/Fabric smoke test remains as `npm run e2e`.

### Fixes

- When Fabric truncates a `fabric_exec` result over its 50,000-character cap, CE stores the full output from Fabric's artifact instead of the truncated view. Fabric marks that scratch file for cleanup as soon as it writes it, so earlier handles kept only the visible head and tail while the notice claimed the full result was stored. Only a regular `output.txt` in a Fabric output scratch directory under the temp root, with the length the notice states, is read.
- The store deletes entry files left from the pre-0.4 `<id>.json` layout on first open. Versions 0.4 to 0.6 copied them into blobs but never removed the originals, which then sat outside the TTL, the size cap and cleanup (360 such files across three local stores, all from before 0.4.0). A store still in that layout is no longer migrated; its entries predate 0.4.0 and are dropped. Only files that parse as a legacy entry named after its own id are removed.

### Offload notices and ctx_read

- The offload notice leads with copyable `ctx_read` calls, offers only the modes the payload supports (`section` with a real section name, `jsonPath` only for JSON), and tells the model to read the handle rather than re-run the call (based on #3 by @e4779).
- A `fabric_exec` program that reads handles and still overflows gets a narrowing hint, detected from the program source (idea from #4 by @e4779).
- `ctx_read` gained `section` mode for Fabric sectioned results; `offset`/`length` page within the section.
- Rewrote the skill as an operational playbook (#1 by @e4779), correcting handle lifetime (workspace store, not session-scoped), the jsonPath dialect (no wildcards or slices), and where `ctx_offload` returns its handle (`details.id`).

### Offload follow-up telemetry

- `ctx_read` and `ctx_summarize` events record the handle they read, and repeating a call whose result was offloaded is recorded. Summaries and `/ce status` report `offloadFollowUp`: offloaded handles, handles read back, and repeated calls.

### Fabric child integration

- Extension-enabled Fabric Pi children that load CE grant themselves `ctx_read` before Fabric's lazy provider initialization, at every depth. Like Fabric's `agents.childQuestionTools`, the grant is skipped for an explicit empty `tools` list and for `+name`/`-name` lists; a malformed allowlist fails closed.
- CE no longer offloads to a handle the current process cannot read (a withheld Fabric allowlist, or a Pi `--tools` list without `ctx_read`); the result stays inline and telemetry records why.

## 0.6.0

### Capability-preserving remediation

- Added machine-readable child execution with observed Usage aggregation, completeness flags, supported-provider generation caps, turn/buffer limits, and minimal no-tools summarizer prompts. Codex uses an explicitly approximate streaming fallback rather than unsupported request fields; generation-limit truncation remains visible to Main.
- Declared `@earendil-works/pi-ai` as a matching peer so clean npm installs and the release CI typecheck resolve the Usage types.
- Added 200+ deterministic remediation checks, including the actual Pi host error wrapper and a hung-callback deadline probe, plus an opt-in paired hidden-answer effectiveness harness. Kept legacy known-marker benchmarks explicitly labeled as plumbing checks, not proof of unchanged agent quality.

- Made model-summary reduction strictly convergent with a binary tree, bounded input reads, a total model-call budget, and a whole-operation deadline. Insufficient input/call budgets fail before model work instead of substituting a first-chunk summary. Explicit direct summaries report coverage and continuation; model inputs and oversized delegated outputs retain exact recovery handles.
- Added explicit storage success status so valid `Error:`-prefixed logs and remembered facts remain readable, searchable, summarizable, and recallable.
- Corrected registered helper failures to reject through Pi's native error contract. Kept `ce_exec` BLOCK as an explicit successful validation diagnostic. Preserved full structured results and native rendering/state details rather than destructively slimming them.
- Separated actual child-model Usage from estimated Main-context prevention. Recovery reads and internal helpers no longer double-count source savings; actual child usage remains independently visible when Fabric capture omits it from native totals.

### Nonrestrictive runtime safety

- Removed grep auto-repair and its exported repair helpers. CE never changes search semantics; Fabric remains responsible for catalog-argument repair.
- Preserved all nested Fabric values under every result policy, including large provider proxies. Deprecated `nestedResultThreshold` (ignored, effective `null`).
- Made default preflight advisory for all return estimates, including zero-source projections and oversized literals; explicit strict/blocking modes remain available.
- Budgeted all model-facing text blocks together, preserving media order, bounded short notes, and indexed lossless multi-text recovery. Artifact metadata no longer bypasses the size guard.
- Stored full errors before compaction, including recovery recipes in their byte budgets. Storage failures leave original results visible.
- Implemented a distinct deterministic structural `summarize` boundary policy with recovery handles and no extra model call.
- Propagated parent cancellation through delegation and hierarchical summarization; child timeout/abort terminates process trees, escalating to SIGKILL on POSIX. Added real local-process cancellation tests and runtime safety regressions to `npm test`.

### Prefix-cache stability

- Removed one-use preview compaction from the `context` hook: already-exposed offload and `ctx_read` results now stay byte-stable across repeated calls, retries, and branch changes. Initial tool-result offloading and edit acknowledgment compaction remain enabled.
- Deprecated `compactStaleResults`; old configs remain accepted, but the setting is ignored and status/settings report `false`. Accumulated history is left to Pi session compaction.
- Added regressions for stable model prefixes, mixed media, manual offloads, bounded reads, and legacy settings.

### Model-boundary UX

- Made `ctx_status` compact by default: one selected scope, no repeated sibling scopes or event/strategy breakdowns, and only the requested summary is computed. `detail: "full"` restores the previous all-scope diagnostic fields.
- Prioritized useful nested JSON fields and small Fabric sectioned-YAML sections in bounded offload previews; excerpts retain provenance and never replace ordinary nested Pi values.
- Added default compaction of recognized verbose successful edit envelopes from 2 KB, keeping the acknowledgment visible and the exact original diff/patch addressable. Added `compactEditResults` opt-out; inline policy and error handling remain unchanged.
- Added regression coverage for mixed results, UTF-8 budgets, media preservation, exact read-back, compact/full status, and optional compaction.

### Docs UX

- Added a full `CeConfig` reference table (README + skill): every knob including `quantitativePolicy`/`policy` (`maxBytes`/`maxTokens`/`maxCharacters`), thresholds, `resultPolicy`, `compactEditResults`, `runtimeAdvisoryThreshold`, `notifyOnStart`, and deprecated ignored keys.
- Documented byte-vs-token ASCII bias: budgets are UTF-8 bytes, token equivalents are ~bytes/4 heuristic; 8 KB static vs 16 KB runtime defaults explained; multibyte UTF-8 and 1B/64K/4K clamps noted with `ctx_status` warnings.
- Documented `ctx_read` `regex`/`ignoreCase` (literal case-sensitive default; invalid regex rejects at the registered tool boundary with structured error diagnostics) and bounded `ctx_summarize` operation/input/call budgets with exact recovery and no implicit first-chunk fallback.

## 0.5.1

### Compatibility and boundary safety

- Classified current Pi/Fabric provider namespaces (including `components` and `compact`), Fovea/web helpers, and PowerShell/process tools as source effects for raw-return analysis.
- Kept documented Fabric nested results byte-for-byte intact even when lifecycle events arrive out of order.
- Raised the default model-boundary offload/read budget to 16 KB and added deterministic oversized-error compaction.
- Added structural JSON/text previews, stable model/Fabric `ctx_read` recipes, and JSON-path selection for stored payloads.
- Added explicit `resultPolicy` controls (`auto`, `inline`, `offload`, `summarize`) and runtime/session/lifetime telemetry scopes.

## 0.5.0

### Context effects

- Added the exported `ContextEffect` vocabulary and registry for source, scalar, select, compress, offload, passthrough, and unknown calls.
- Moved `ctx_*`, `ce_*`, and Fovea bound-argument definitions into registry metadata; analyzer behavior remains compatible with v0.4.0.
- Added registry contract checks for byte/token bounds, aliases, source fallback, and conservative unknown-helper handling.
- Added unit-aware literal `returnBound` results and structured `returnProvenance` traces.
- Added a permanent 12-case v0.4 differential suite covering allow/reject, taint, reduction, boundedness, and retention classifications.
- Added deterministic structured explanations with classification, boundedness, final bounds, provenance reasons, optional source locations, and a human-readable formatter.
- Added explanation checks for raw, scalar, select, compress, offload, unknown-bound, chained, and multi-source flows.
- Added scope-aware immutable numeric `const` alias propagation with alias-chain reasons; mutable bindings, calls, and cycles remain unknown.
- Added a 45-check constant-alias suite covering lexical shadowing and all conservative fallback cases.
- Split resolved bounds into `exact`, `upper`, and `unknown`; added safe-integer exact arithmetic and `Math.min` upper-bound derivation without changing policy decisions.
- Added expression-level conditional joins with structured branch provenance and bounded `Math.max` evaluation; both require conservative finite inputs.
- Expanded the symbolic-bound suite to 117 checks covering arithmetic, caps, joins, invalid numeric values, dynamic operands, and unsupported operations.
- Added an explicit quantitative policy with byte, token, and character budgets; element and record bounds are deliberately not comparable to context size.
- Made within-budget proofs an additive policy override for legacy unbounded returns only; over-budget and unknown proofs remain blocked and legacy-safe paths remain unchanged.
- Added policy-aware explanations and an auditable v0.4/v0.5 suite: 3 intentional changes, 5 parity cases, and 0 unexpected policy-case differences.
- Added 62 policy-boundary checks for exact/upper edges, zero, invalid values, unsupported units, derived aliases/joins/caps, and strict configuration validation.
- Added configurable `.pi/context-engineer.json` policy budgets with UTF-16-code-unit character semantics and a 1,000,000,000 maximum per budget.
- Expanded Pi/Fabric E2E coverage to 4/4, including within-budget symbolic execution and over-budget blocking.

## 0.4.0

### Correctness

- Fixed persistent memory expiry semantics, named-key upserts, and `ctx_forget`.
- Made arbitrary UTF-8 range reads boundary-safe with accurate pagination offsets.
- Added bounded hierarchical summarization with per-child input budgets.

### Robustness

- Rebuilt addressable storage around metadata indexes and content-addressed blobs.
- Added atomic writes, locking, private permissions, legacy migration, and dangling/corrupt payload recovery.
- Added official optional Fabric protocol compatibility and runtime boundary hardening.

### Evidence

- Added an 8-workload baseline-versus-CE benchmark with retained machine-readable results, provenance, one warmup, 30 measured samples, median aggregation, and p95 wall-time reporting.
- Added 26 generated adversarial analyzer cases.
- Verified real Pi/Fabric boundary offload, `ctx_read` recovery, and hierarchical summarization through `openai-codex/gpt-5.6-luna`.
- Current retained result: 8/8 benchmark tasks correct with 98.0% lower Main-context exposure.
