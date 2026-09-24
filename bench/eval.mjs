#!/usr/bin/env node
/**
 * Decision-quality eval for OpenJev typed decisions.
 *
 * Runs the labeled dataset through `decide()` (Choice/Noul/Score) and reports
 * accuracy, macro-F1, calibration (Brier/ECE), risk-coverage, and threshold
 * sweeps. Optionally runs a measured LLM `prompt -> JSON` baseline on the same
 * cases for a head-to-head (accuracy + type-error rate + latency).
 *
 * Usage:
 *   node bench/eval.mjs                      # Jev only (uses .env / env vars)
 *   JEV_BACKEND=mock node bench/eval.mjs     # plumbing check, no key
 *   BASELINE_MODEL=gpt-4o-mini BASELINE_API_KEY=... node bench/eval.mjs   # + LLM baseline
 *
 * Baseline is OpenAI-compatible: BASELINE_BASE_URL (default api.openai.com/v1),
 * BASELINE_API_KEY (falls back to OPENAI_API_KEY), BASELINE_MODEL (enables it).
 */

import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decide, resolveBackend } from "../dist/src/client.js";
import { FAMILIES } from "./families.mjs";
import * as M from "./metrics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATASET = join(HERE, "dataset.jsonl");
const RESULTS = join(HERE, "results");

const BASELINE = {
  key: process.env.BASELINE_API_KEY || process.env.OPENAI_API_KEY,
  base: (process.env.BASELINE_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
  model: process.env.BASELINE_MODEL,
};
const baselineEnabled = () => Boolean(BASELINE.key && BASELINE.model);

function loadDataset() {
  return readFileSync(DATASET, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => ({ ...JSON.parse(l), _line: i + 1 }));
}

// ---- Jev ----
function normalizeJev(family, ans) {
  const f = FAMILIES[family];
  if (f.type === "choice") return { pred: ans.choice, conf: ans.confidence, probs: ans.probabilities };
  if (f.type === "noul") {
    const p = ans.noul;
    return { pred: p > 0.5, conf: Math.max(p, 1 - p), probs: { true: p, false: 1 - p } };
  }
  const keys = Object.keys(ans.probabilities);
  let best = keys[0];
  for (const k of keys) if (ans.probabilities[k] > ans.probabilities[best]) best = k;
  const probs = {};
  for (const k of keys) probs[f.criteria[Number(k)] ?? k] = ans.probabilities[k];
  return { pred: f.criteria[Number(best)] ?? best, conf: ans.confidence, probs };
}

async function runJev(cases) {
  const rows = [];
  for (const c of cases) {
    const f = FAMILIES[c.family];
    const t0 = performance.now();
    try {
      const res = await decide(c.state, { q: { type: f.type, instructions: f.instructions, criteria: f.criteria } });
      const n = normalizeJev(c.family, res.answers.q);
      rows.push({ ...c, pred: n.pred, conf: n.conf, probs: n.probs, correct: n.pred === c.label, ms: performance.now() - t0, usage: res.usage, model: res.model, error: null });
    } catch (e) {
      rows.push({ ...c, pred: null, conf: 0, probs: null, correct: false, ms: performance.now() - t0, error: e.message });
    }
  }
  return rows;
}

// ---- optional LLM baseline ----
function normalizeBaselineAnswer(family, answer) {
  const f = FAMILIES[family];
  if (f.type === "noul") {
    if (answer === true || answer === "true" || answer === "yes") return true;
    if (answer === false || answer === "false" || answer === "no") return false;
    return null;
  }
  const s = String(answer);
  return f.classes.includes(s) ? s : null;
}

async function callLLM(family, state) {
  const f = FAMILIES[family];
  const optionSpec =
    f.type === "noul"
      ? 'Return {"answer": true} or {"answer": false}.'
      : `Return {"answer": "<one of: ${f.classes.join(", ")}>"}.`;
  const prompt =
    "You are a strict classifier. Read STATE and answer QUESTION with exactly one option.\n" +
    `QUESTION: ${f.instructions}\nOPTIONS: ${JSON.stringify(f.criteria)}\n${optionSpec}\n` +
    "Respond with ONLY minified JSON, no prose.\nSTATE:\n" +
    (typeof state === "string" ? state : JSON.stringify(state));
  const res = await fetch(`${BASELINE.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${BASELINE.key}` },
    body: JSON.stringify({ model: BASELINE.model, temperature: 0, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`baseline ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content ?? "";
  const usage = json.usage ? { input_tokens: json.usage.prompt_tokens, output_tokens: json.usage.completion_tokens } : undefined;
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return { pred: null, parseError: true, raw: text, usage };
  }
  return { pred: normalizeBaselineAnswer(family, parsed.answer), parseError: false, raw: text, usage };
}

async function runBaseline(cases) {
  if (!baselineEnabled()) return null;
  const rows = [];
  for (const c of cases) {
    const t0 = performance.now();
    try {
      const r = await callLLM(c.family, c.state);
      rows.push({ ...c, pred: r.pred, correct: r.pred === c.label, ms: performance.now() - t0, typeError: r.pred === null, parseError: r.parseError, raw: r.raw, usage: r.usage, error: null });
    } catch (e) {
      rows.push({ ...c, pred: null, correct: false, ms: performance.now() - t0, typeError: true, parseError: false, error: e.message });
    }
  }
  return rows;
}

// ---- aggregation ----
function familyStats(rows, family) {
  const f = FAMILIES[family];
  const rs = rows.filter((r) => r.family === family && !r.error);
  const preds = rs.map((r) => r.pred);
  const labels = rs.map((r) => r.label);
  const confs = rs.map((r) => r.conf);
  const corrects = rs.map((r) => r.correct);
  const probs = rs.map((r) => r.probs).filter(Boolean);
  const ok = corrects.filter(Boolean).length;
  return {
    family,
    n: rs.length,
    errors: rows.filter((r) => r.family === family && r.error).length,
    accuracy: M.accuracy(preds, labels),
    macroF1: M.macroF1(preds, labels, f.classes),
    brier: M.brier(probs, labels, f.classes),
    ece: M.ece(confs, corrects).ece,
    confMean: M.mean(confs),
    ci: M.wilson(ok, rs.length),
    p50: M.percentile(rs.map((r) => r.ms), 50),
    p95: M.percentile(rs.map((r) => r.ms), 95),
    tokensIn: rs.reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0),
  };
}

function pooledAccuracy(rows, filter) {
  const rs = rows.filter((r) => !r.error && (!filter || filter(r)));
  const ok = rs.filter((r) => r.correct).length;
  return { ok, n: rs.length, acc: rs.length ? ok / rs.length : 0, ci: M.wilson(ok, rs.length) };
}

function printTable(title, rows, cols) {
  console.log(`\n${title}`);
  const head = cols.map((c) => c.h.padEnd(c.w)).join(" ");
  console.log(head);
  console.log("-".repeat(head.length));
  for (const r of rows) console.log(cols.map((c) => String(c.f(r)).padEnd(c.w)).join(" "));
}

function pct(x, d = 1) {
  return x === null || x === undefined ? "-" : `${(x * 100).toFixed(d)}%`;
}

async function main() {
  const cases = loadDataset();
  const backend = resolveBackend().backend;
  console.log(`\n=== OpenJev decision-quality eval — backend: ${backend} (${new Date().toISOString()}) ===`);
  console.log(`Dataset: ${cases.length} cases from ${DATASET}`);

  const jev = await runJev(cases);

  const families = [...new Set(cases.map((c) => c.family))];
  const famRows = families.map((f) => familyStats(jev, f));
  printTable("Jev — per family", famRows, [
    { h: "family", w: 10, f: (r) => r.family },
    { h: "n", w: 3, f: (r) => r.n },
    { h: "acc", w: 7, f: (r) => pct(r.accuracy) },
    { h: "95% CI", w: 15, f: (r) => `${pct(r.ci.lo, 0)}-${pct(r.ci.hi, 0)}` },
    { h: "macroF1", w: 8, f: (r) => r.macroF1.toFixed(2) },
    { h: "Brier", w: 7, f: (r) => r.brier.toFixed(3) },
    { h: "ECE", w: 6, f: (r) => r.ece.toFixed(3) },
    { h: "conf", w: 6, f: (r) => r.confMean.toFixed(2) },
    { h: "p50ms", w: 7, f: (r) => r.p50.toFixed(0) },
    { h: "err", w: 4, f: (r) => r.errors },
  ]);

  const overall = pooledAccuracy(jev);
  const easy = pooledAccuracy(jev, (r) => r.difficulty === "easy");
  const hard = pooledAccuracy(jev, (r) => r.difficulty !== "easy");
  const wBrier = famRows.reduce((a, r) => a + r.brier * r.n, 0) / famRows.reduce((a, r) => a + r.n, 0);
  const wEce = famRows.reduce((a, r) => a + r.ece * r.n, 0) / famRows.reduce((a, r) => a + r.n, 0);
  console.log(`\nOverall accuracy ${overall.ok}/${overall.n} = ${pct(overall.acc)} (95% CI ${pct(overall.ci.lo, 0)}-${pct(overall.ci.hi, 0)})`);
  console.log(`  easy ${pct(easy.acc)} (n=${easy.n})  |  medium/ambiguous ${pct(hard.acc)} (n=${hard.n})`);
  console.log(`  weighted Brier ${wBrier.toFixed(3)}  weighted ECE ${wEce.toFixed(3)}  (lower is better; ECE ~0 = calibrated)`);

  // threshold sweeps (defaults: choice/noul 0.75, score 0.65)
  const groups = {
    "choice (default 0.75)": jev.filter((r) => !r.error && FAMILIES[r.family].type === "choice"),
    "noul (default 0.75)": jev.filter((r) => !r.error && FAMILIES[r.family].type === "noul"),
    "score (default 0.65)": jev.filter((r) => !r.error && FAMILIES[r.family].type === "score"),
  };
  for (const [label, rs] of Object.entries(groups)) {
    const confs = rs.map((r) => r.conf);
    const corrects = rs.map((r) => r.correct);
    const sweep = M.thresholdSweep(confs, corrects, [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 0.95]);
    printTable(`Threshold sweep — ${label} (selective accuracy vs coverage)`, sweep, [
      { h: "thr", w: 5, f: (r) => r.threshold.toFixed(2) },
      { h: "coverage", w: 9, f: (r) => pct(r.coverage, 0) },
      { h: "n", w: 3, f: (r) => r.n },
      { h: "acc|covered", w: 12, f: (r) => pct(r.accuracy) },
    ]);
  }

  const allConfs = jev.filter((r) => !r.error).map((r) => r.conf);
  const allCorrect = jev.filter((r) => !r.error).map((r) => r.correct);
  const rc = M.riskCoverage(allConfs, allCorrect);
  printTable("Risk-coverage (keep top-confidence fraction)", rc, [
    { h: "coverage", w: 9, f: (r) => pct(r.coverage, 0) },
    { h: "n", w: 3, f: (r) => r.n },
    { h: "accuracy", w: 9, f: (r) => pct(r.accuracy) },
    { h: "risk", w: 7, f: (r) => pct(r.risk) },
  ]);

  // baseline
  let baseRows = null;
  if (baselineEnabled()) {
    console.log(`\n--- LLM baseline: ${BASELINE.model} @ ${BASELINE.base} ---`);
    baseRows = await runBaseline(cases);
    const bOverall = pooledAccuracy(baseRows);
    const bType = baseRows.filter((r) => r.typeError).length / baseRows.length;
    const bParse = baseRows.filter((r) => r.parseError).length / baseRows.length;
    const bMs = baseRows.filter((r) => !r.error).map((r) => r.ms);
    console.log(`Baseline accuracy ${bOverall.ok}/${bOverall.n} = ${pct(bOverall.acc)} (95% CI ${pct(bOverall.ci.lo, 0)}-${pct(bOverall.ci.hi, 0)})`);
    console.log(`  type-error rate ${pct(bType)}  parse-error rate ${pct(bParse)}  p50 ${M.percentile(bMs, 50).toFixed(0)}ms  p95 ${M.percentile(bMs, 95).toFixed(0)}ms`);
    printTable("Head-to-head", [
      { name: "Jev", acc: overall.acc, type: 0, p50: M.percentile(jev.filter((r) => !r.error).map((r) => r.ms), 50), brier: wBrier, ece: wEce },
      { name: BASELINE.model, acc: bOverall.acc, type: bType, p50: M.percentile(bMs, 50), brier: null, ece: null },
    ], [
      { h: "system", w: 20, f: (r) => r.name },
      { h: "accuracy", w: 9, f: (r) => pct(r.acc) },
      { h: "type-err", w: 9, f: (r) => pct(r.type) },
      { h: "Brier", w: 7, f: (r) => (r.brier === null ? "-" : r.brier.toFixed(3)) },
      { h: "ECE", w: 6, f: (r) => (r.ece === null ? "-" : r.ece.toFixed(3)) },
      { h: "p50ms", w: 7, f: (r) => r.p50.toFixed(0) },
    ]);
  } else {
    console.log("\n(LLM baseline skipped — set BASELINE_MODEL + BASELINE_API_KEY to enable a head-to-head.)");
  }

  // artifact
  const out = {
    meta: { backend, at: new Date().toISOString(), dataset: DATASET, cases: cases.length, baseline: baselineEnabled() ? BASELINE.model : null },
    overall, easy, hard, weighted: { brier: wBrier, ece: wEce },
    families: famRows,
    thresholdSweeps: Object.fromEntries(Object.entries(groups).map(([k, rs]) => [k, M.thresholdSweep(rs.map((r) => r.conf), rs.map((r) => r.correct), [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 0.95])])),
    riskCoverage: rc,
    jevRows: jev.map((r) => ({ id: r.id, family: r.family, label: r.label, pred: r.pred, conf: r.conf, correct: r.correct, difficulty: r.difficulty, ms: Math.round(r.ms), error: r.error })),
    baselineRows: baseRows ? baseRows.map((r) => ({ id: r.id, pred: r.pred, correct: r.correct, typeError: r.typeError, parseError: r.parseError, ms: Math.round(r.ms), raw: r.raw })) : null,
  };
  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `eval-${backend.replace(/[^a-z0-9-]/gi, "_")}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
