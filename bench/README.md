# Context Engineer benchmark harness

This directory measures whether CE reduces data entering Main while preserving a deterministic task result.

## Run

```bash
npm run bench
```

For the real Pi/Fabric smoke tests, pass any configured model explicitly:

```bash
CE_RUN_E2E=1 PI_MODEL=openai-codex/gpt-5.6-luna npm run bench:e2e
```

The runner disables auto-discovered extensions and loads the local CE/Fabric builds exactly once. The command runs every descriptor in `bench/cases/` twice:

- **baseline**: the complete simulated Pi/Fabric tool result is returned to Main.
- **CE**: the result is written to the addressable store, then only a handle, bounded preview, and task-specific selection/summary are returned.

The runner writes `.tmp/context-benchmark.json`. It performs one warmup and three measured iterations by default, reports median and p95 wall time, and retains every sample in the JSON result. Override these with `CE_BENCHMARK_WARMUP` and `CE_BENCHMARK_ITERATIONS`.

For the retained v0.5.0 release artifact (the v0.4.0 artifact remains frozen):

```bash
PI_MODEL=openai-codex/gpt-5.6-luna CE_BENCHMARK_WARMUP=1 CE_BENCHMARK_ITERATIONS=30 CE_BENCHMARK_OUT=bench/results/v0.5.0.json npm run bench
```

The machine-readable contract is `bench/result.schema.json`. Retained workload evidence is `bench/results/v0.5.0.json`; `bench/results/v0.4.0.json` is the byte-identical comparison baseline. Results record sourceCommit/dirty state, Node/Pi/Fabric versions, model/provider, Main input/output/injected tokens, internal model tokens, logical offload bytes, selected bytes retrieved, wall time, correctness, and all per-iteration samples.

The v0.5 static policy benchmark is separate from the frozen workload benchmark:

```bash
POLICY_BENCHMARK_OUT=bench/results/v0.5.0-quantitative-policy.json npm run bench:policy
```

It runs symbolic `Math.min`, alias, conditional, and `Math.max` caps plus unknown, over-budget, and legacy-safe parity cases. Its report records sourceCommit, dirty state, runtime/model provenance, correctness, decisions, bounds, and analysis timing; `bench/policy-result.schema.json` defines its retained contract. It does not replace or mutate the retained v0.4 workload artifact.

## Metrics

Each row captures Main context tokens, tool-result tokens, child-model tokens, wall time, disk bytes, task correctness, and completion. Derived metrics are:

```text
mainTokensPrevented = baseline Main tokens - CE Main tokens
contextEfficiency = mainTokensPrevented / (extraInternalTokens + mainTokensInjected)
qualityAdjustedSavings = mainTokensPrevented when the CE task succeeds, otherwise 0
```

The cases use deterministic local workloads and a deterministic model stub for the hierarchical-summary case. They are suitable for regression and relative comparisons, not claims about a particular provider/model's answer quality. Provider-backed Pi/Fabric runs should be added as opt-in integration jobs with the same report schema.

Add a workload by placing a JSON descriptor in `bench/cases/` and extending `makePayload`/`ceMetrics` only when the workload needs a new execution shape.
