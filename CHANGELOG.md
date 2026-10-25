# Changelog

## Unreleased

### Removed

- The benchmark harnesses: the deterministic plumbing benchmark (its known-marker checks duplicated `npm test` and measured CE against a baseline that shows every byte), the static-policy benchmark, and the paid paired-effectiveness harness, which was never run. The opt-in real Pi/Fabric smoke test remains as `npm run e2e`.

### Offload notices and ctx_read

- The offload notice leads with copyable `ctx_read` calls, offers only the modes the payload supports (`section` with a real section name, `jsonPath` only for JSON), and tells the model to read the handle rather than re-run the call (based on #3 by @e4779).
- A `fabric_exec` program that reads handles and still overflows gets a narrowing hint, detected from the program source (idea from #4 by @e4779).
- `ctx_read` gained `section` mode for Fabric sectioned results; `offset`/`length` page within the section.
- Rewrote the skill as an operational playbook (#1 by @e4779), correcting handle lifetime (workspace store, not session-scoped) and the jsonPath dialect (no wildcards or slices).

### Startup and preflight cost

- Default mode no longer runs static analysis on every `fabric_exec`; its advisory verdict was discarded. Analysis runs with `strict`/`blockUnboundedReturns`, `ce_exec`, and `explainProgram`.
- The analyzer loads TypeScript on first use, cutting CE import time from roughly 300 ms to 90 ms on a local machine; every Pi session and Fabric child that loads CE pays this.

### Offload follow-up telemetry

- `ctx_read` and `ctx_summarize` events record the handle they read, and repeating a call whose result was offloaded is recorded. Summaries and `/ce status` report `offloadFollowUp`: offloaded handles, handles read back, and repeated calls.

### Fabric child integration

- Extension-enabled Fabric Pi children that load CE grant themselves `ctx_read` before Fabric's lazy provider initialization, at every depth. Like Fabric's `agents.childQuestionTools`, the grant is skipped for an explicit empty `tools` list and for `+name`/`-name` lists; a malformed allowlist fails closed.
- CE no longer offloads to a handle the current process cannot read (a withheld Fabric allowlist, or a Pi `--tools` list without `ctx_read`); the result stays inline and telemetry records why.
- The isolated `ctx_delegate` fallback loads CE restricted to `ctx_read`, so a delegated child cannot delegate again or write memory. Explicit extension-disabled and non-Pi runners remain opt-outs.

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
