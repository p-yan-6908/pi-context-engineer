# Changelog

## Unreleased (v0.5.0)

### Context effects

- Added the exported `ContextEffect` vocabulary and registry for source, scalar, select, compress, offload, passthrough, and unknown calls.
- Moved `ctx_*`, `ce_*`, and Fovea bound-argument definitions into registry metadata; analyzer behavior remains compatible with v0.4.0.
- Added registry contract checks for byte/token bounds, aliases, source fallback, and conservative unknown-helper handling.
- Added unit-aware literal `returnBound` results and structured `returnProvenance` traces; identifier aliases and arithmetic remain unknown by design.
- Added a permanent 12-case v0.4 differential suite covering allow/reject, taint, reduction, boundedness, and retention classifications.
- Added deterministic structured explanations with classification, boundedness, final bounds, provenance reasons, optional source locations, and a human-readable formatter.
- Added explanation checks for raw, scalar, select, compress, offload, unknown-bound, chained, and multi-source flows.
- Added scope-aware immutable numeric `const` alias propagation with alias-chain reasons; mutable bindings, arithmetic, calls, conditionals, and cycles remain unknown.
- Added a 45-check constant-alias suite covering lexical shadowing and all conservative fallback cases.
- Split resolved bounds into `exact`, `upper`, and `unknown`; added safe-integer exact arithmetic and `Math.min` upper-bound derivation without changing policy decisions.
- Added a 72-check symbolic-bound suite covering arithmetic, caps, invalid numeric values, dynamic operands, and unsupported operations.

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
