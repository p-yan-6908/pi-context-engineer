# Changelog

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
