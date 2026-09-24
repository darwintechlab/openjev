# Benchmark — OpenJev (mock vs hosted Jev) — 2026-09-24

Measured with `bench/bench.mjs` on ticket-router `Choice(billing/technical/sales/spam)` via `decide()` → `src/client.ts`.

|  | Mock (deterministic, no network) | Hosted Jev `jev-1.13.0` (`TYPESAFE_API_KEY`) |
|---|---|---|
| **1q latency** (15 runs) p50 / p95 / mean | 0.1 / 0.3 / 0.1 ms | **266.7 / 553.2 / 279.5 ms** |
| **27q parallel** (8 runs) p50 / mean / overhead vs 1q | 0.7 / 0.7 ms, +0.6 ms | **290.0 / 285.0 ms, +5.5 ms** |
| **Parallel vs sequential** (10 choices) | seq 409ms → par 0.2ms (1988×, but mock is ~0ms) | **seq 2946ms → par 219ms (13.4×)** |
| **Accuracy** 10 tickets | 2/10 (20%), conf mean 0.39 — random | **10/10 (100%), conf mean 0.96 p50 1.00 — calibrated** |
| **Tokens / cost** (this task, ~400 in-tok) | 82 tok, $0 | **398 tok → $0.000017 / call ($0.0167 / 1k), output free** |

JSON artifacts: `bench/results/bench-mock-*.json`, `bench/results/bench-hosted-*.json`.

## What this proves for the harness

1. **Jev is the right shape for typed harness decisions.** Same state, parallel `Choice/Noul/Score`, calibrated confidence, 0 typed taul errors on this set (hosted 100% on 10 cases vs mock 20%). Conf ≥0.95 aligns with correct (billing 0.98, spam 1.00).
2. **Parallel sampling is real.** 1q → 27q adds only ~5ms hosted (vendor claim 70–500ms). Sequential 10×1q would be ~3s; one parallel 1×10q is ~0.22s — 13× on hosted, ~2000× on mock.
3. **Harness acceleration matches TypeSafe reports** without needing to vendor-claim: DataCamp/TypeSafe 4-workflow report (Terra 10.1s, Sol 23.3s, Opus 37.8s vs Jev 0.4s at 67-68% acc, $0.0004/case vs Terra $0.0304 1/76). Our 27q harness row-filter would be ~2.9s sequential LLM → ~0.29s Jev.
4. **Cost is noise.** $0.042/M input ($42/B), output free → this routing decision $0.0167/1k. At 1M harness decisions/day ≈ $17 vs ~$1.2k on Terra. Mock is $0 for CI.

## How to re-run

```bash
JEV_BACKEND=mock node bench/bench.mjs              # no key
TYPESAFE_API_KEY=ts_... node bench/bench.mjs       # hosted
# also:
node examples/demo.mjs
# in Opencode TUI:
jev_doctor
```

Keep irreversible actions behind `if (confidence < 0.75) escalateToLLM/human` — Jev gives the number, you own the threshold.

---

## Decision-quality eval — 2026-09-24

`bench/eval.mjs` over `bench/dataset.jsonl` (52 labeled cases: 35 easy, 17 medium/ambiguous) via `decide()`, backend `typesafe` / `jev-1.13.0`.

| family | n | acc | 95% CI | macro-F1 | Brier | ECE |
|---|---|---|---|---|---|---|
| routing | 14 | 92.9% | 69–99% | 0.94 | 0.057 | 0.071 |
| tool | 8 | 87.5% | 53–98% | 0.90 | 0.215 | 0.125 |
| verdict | 8 | 100% | 68–100% | 1.00 | 0.032 | 0.130 |
| guardrail | 10 | 80.0% | 49–94% | 0.80 | 0.212 | 0.189 |
| urgency | 6 | 100% | 61–100% | 1.00 | 0.004 | 0.040 |
| severity | 6 | 66.7% | 30–90% | 0.53 | 0.259 | 0.235 |

**Overall 88.5% (46/52), 95% CI 77–95%.** Easy 97.1%, medium/ambiguous 70.6%. Weighted Brier 0.124, ECE 0.126.

Selective accuracy at the default gates (the number that matters in the harness):

| type | gate | coverage | acc on covered |
|---|---|---|---|
| choice | 0.75 | 80% | 95.8% |
| noul | 0.75 | 94% | 93.3% |
| score | 0.65 | 83% | 80.0% |

Risk–coverage: keeping the top 69% by confidence gives **100%** accuracy; at full coverage 88.5% — confidence ranks errors, so gating works.

**Caveats (read these):** dataset is a synthetic, self-authored seed → ceiling effect on easy cases; `severity` is ordinal with n=6 and is the weakest family; no LLM baseline yet (set `BASELINE_MODEL` + `BASELINE_API_KEY` for a head-to-head). Replace the seed with real held-out cases before drawing conclusions.

### How to re-run the eval

```bash
JEV_BACKEND=mock node bench/eval.mjs                    # plumbing, no key
node bench/eval.mjs                                     # live (uses .env / env)
BASELINE_MODEL=gpt-4o-mini BASELINE_API_KEY=... node bench/eval.mjs   # + LLM baseline
```

