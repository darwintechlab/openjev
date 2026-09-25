# Benchmark — OpenJev (mock vs hosted Jev) — 2026-09-24

Measured with `bench/bench.mjs` on ticket-router `Choice(billing/technical/sales/spam)` via `decide()` → `src/client.ts`.

|  | Mock (deterministic, no network) | Hosted Jev `jev-1.13.0` (`TYPESAFE_API_KEY`) |
|---|---|---|
| **1q latency** (15 runs) p50 / p95 / mean | 0.1 / 0.3 / 0.1 ms | **266.7 / 553.2 / 279.5 ms** |
| **27q parallel** (8 runs) p50 / mean / overhead vs 1q | 0.7 / 0.7 ms, +0.6 ms | **290.0 / 285.0 ms, +5.5 ms** |
| **Parallel vs sequential** (10 choices) | seq 409ms → par 0.2ms (1988×, but mock is ~0ms) | **seq 2946ms → par 219ms (13.4×)** |
| **Tokens / cost** (this task, ~400 in-tok) | 82 tok, $0 | **398 tok → $0.000017 / call ($0.0167 / 1k), output free** |

(Accuracy on the seed tickets is deliberately not shown here — it was a 10-case smoke test. The [decision-quality eval](#decision-quality-eval--2026-09-25-115-cases) below is the real measurement.)

JSON artifacts: `bench/results/bench-mock-*.json`, `bench/results/bench-hosted-*.json`.

## What this proves for the harness

1. **Jev is the right shape for typed harness decisions.** Same state, parallel `Choice/Noul/Score`, calibrated confidence, 0 typed-output errors on the full eval. Conf ≥0.95 aligns with correct (billing 0.98, spam 1.00).
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

## Decision-quality eval — 2026-09-25 (115 cases)

`bench/eval.mjs` over `bench/dataset.jsonl` (115 labeled cases) via `decide()`, backend `typesafe` / `jev-1.13.0`.

The `guardrail` family is **four atomic `noul` questions asked in one parallel call** (data_loss, security, resources, outside_workspace), then combined in code. That is why its `n` is 76 (19 commands × 4) in the per-question table: it measures whether the model answered each atomic question, not a conflated one.

| family | n | acc | 95% CI | macro-F1 | Brier | ECE |
|---|---|---|---|---|---|---|
| routing | 26 | 96.2% | 81–99% | 0.97 | 0.036 | 0.053 |
| tool | 18 | 83.3% | 74–99% | 0.85 | 0.208 | 0.077 |
| verdict | 18 | 94.4% | 74–99% | 0.91 | 0.119 | 0.107 |
| guardrail | 76 | 93.4% | 86–97% | 0.91 | 0.103 | 0.047 |
| urgency | 16 | 100.0% | 81–100% | 1.00 | 0.010 | 0.058 |
| severity | 18 | 61.1% | 39–80% | 0.55 | 0.367 | 0.185 |

**Per case (guardrail combined) 88.7% (102/115), 95% CI 81–93%; per atomic question 91.3%.** Easy 97.0%, medium/ambiguous 77.1%. Weighted Brier 0.124, ECE 0.073.

Guardrail atomic breakdown: security 100%, data_loss 94.7%, resources 94.7%, **outside_workspace 84.2%** — the one genuinely ambiguous flag (both systems miss it).

Selective accuracy at the default gates:

| type | gate | coverage | acc on covered |
|---|---|---|---|
| choice | 0.75 | 84% | 98.1% |
| noul | 0.75 | 87% | 97.5% |
| score | 0.70 | 67% | 83.3% |

Risk–coverage: keeping the top 70% by confidence gives **99%** accuracy, the top 50% gives **100%**; at full coverage 88.7% — confidence ranks errors, so gating works.

**Caveats (read these):** the dataset is curated by us and self-labeled (single annotator) → ceiling effect on easy cases and possible label bias; `severity` (ordinal, n=18) is the weakest family and is unstable run-to-run; `outside_workspace` is a genuinely fuzzy boundary. Replace with real held-out, multi-annotator cases before drawing conclusions.

### How to re-run the eval

```bash
JEV_BACKEND=mock node bench/eval.mjs                    # plumbing, no key
node bench/eval.mjs                                     # live (uses .env / env)
BASELINE_MODEL=gpt-4o-mini BASELINE_API_KEY=sk-... node bench/eval.mjs   # + LLM baseline
# endpoint needing an extra header (e.g. OpenCode Zen Go):
BASELINE_BASE_URL=https://opencode.ai/zen/go/v1 BASELINE_MODEL=deepseek-v4.1-flash \
  BASELINE_API_KEY=... BASELINE_HEADERS='{"x-opencode-session":"ses_bench01"}' node bench/eval.mjs
# self-consistency (stabilizes a noisy endpoint):
BASELINE_SAMPLES=3 node bench/eval.mjs
```

## Head-to-head vs a conventional LLM — measured 2026-09-25

`bench/eval.mjs` runs the same labeled cases through a conventional LLM
(`prompt -> JSON`) and compares it to Jev on the axes that matter for a gate:

| axis | how it's measured |
|---|---|
| Task quality | accuracy, macro-F1, Wilson 95% CI |
| **Significance** | **McNemar exact test + paired bootstrap CI** of the accuracy difference |
| **Calibration** | **Brier, ECE** — the LLM is asked for a probability distribution, so its confidence is comparable to Jev's |
| **Structural reliability** | **type-error rate** (reply not in the option space) and parse-error rate |
| Latency | p50 / p95 per decision |
| **Cost** | **$/1k decisions** from real token usage (`JEV_PRICE_IN`, `BASELINE_PRICE_IN/OUT`) |
| Gate value | **selective accuracy / coverage at 0.75** (what a gate actually ships) |

Self-consistency mode (`BASELINE_SAMPLES>1`) samples the LLM k times at
`BASELINE_TEMPERATURE` and uses the empirical label frequency as its confidence
distribution, instead of the model's self-reported `p`. Guardrail is asked as one
4-question call for both systems.

**Measured** on the 115-case set: hosted Jev (`jev-1.13.0`) vs
`deepseek-v4.1-flash` through the OpenCode Zen Go endpoint. Baseline uses
**self-consistency k=3, temperature 0.7** because the endpoint is nondeterministic
even at temperature 0 (see below):

| system | acc (per case) | acc (per atomic) | type-err | Brier | ECE | p50 | $/1k |
|---|---|---|---|---|---|---|---|
| Jev (`jev-1.13.0`) | 88.7% | 91.3% | 0.0% | 0.124 | 0.073 | **215 ms** | **$0.0161** |
| `deepseek-v4.1-flash` (k=3) | **93.9%** | **94.2%** | 0.0% | **0.106** | **0.050** | 7492 ms | $0.7656 |

Paired (n=115): McNemar a=0, b=8, exact **p=0.0078** — the LLM is significantly
more accurate, +7.0 pts (95% CI 2.6–12.2; bootstrap p≈0.001). **But excluding
`severity` it is not** (a=0, b=4, p=0.125): the result is driven by one family
(Jev 61% vs 83%). Jev wins ~35× latency and ~48× cost.

### What the redesign changed
- **Splitting the guardrail question fixed that family.** Asking four atomic
  questions instead of one conflated one moved Jev from 76.2% → **93.4%** (atomic);
  the LLM went 91.1% → 92.1%. Most of the old "guardrail gap" was the *question*,
  not the model.
- Relabeling `verdict-12` (`block`→`approve`; both models correctly called the
  missing-`await` a bug fix) and accepting `bash` for the rename/search tool cases
  removed three ambiguous/shared errors.

### The asymmetric gate is the point
`gateGuardrailFlags` auto-allows only when every flag's safe side is ≥0.95, else
it asks. On the 19 guardrail commands:

| system | policy | allow coverage | false-allows |
|---|---|---|---|
| Jev | symmetric 0.75 | 37% | 1 |
| Jev | **asymmetric 0.95** | 5% | **0** |
| `deepseek-v4.1-flash` | symmetric 0.75 | 37% | 1 |
| `deepseek-v4.1-flash` | asymmetric 0.95 | 37% | **1** |

Jev's calibrated confidence lets the asymmetric gate close the hole (the
`chmod -R 777` case that auto-ran at 0.90 becomes an ask). The LLM is
*confidently wrong* on a dangerous case, so raising the threshold does not help
it — **an asymmetric gate only works when confidence is calibrated.**

### Reproducibility caveat (important)
Both systems are nondeterministic. Across two single-shot runs, Jev flipped 2
answers (`tool-15`, `sev-18`) and the LLM flipped 3 (`sev-04`, `sev-15`, `sev-18`)
— at temperature 0. That alone moved the headline from "not significant" to
"significant." The table above uses k=3 self-consistency to damp it; treat any
`severity` conclusion as provisional.

Caveats: 115 cases is still underpowered (the difference CI spans ~10 pts); the
labels are ours and may favor either system; the baseline is a frontier-class
model while the hosted Jev checkpoint here may not be the newest. This is a
measured comparison, not a verdict. The full row-level artifact (including
per-sub-question guardrail results) is written to `bench/results/eval-*.json`
under `headToHead`.

