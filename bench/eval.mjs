#!/usr/bin/env node
/**
 * Decision-quality eval for OpenJev typed decisions.
 *
 * Runs the labeled dataset through `decide()` (Choice/Noul/Score) and reports
 * accuracy, macro-F1, calibration (Brier/ECE), risk-coverage, and threshold
 * sweeps. Optionally runs a measured LLM `prompt -> JSON` baseline on the same
 * cases for a head-to-head (accuracy + significance + calibration + cost).
 *
 * Multi-question families (guardrail) are asked as ONE parallel call; they are
 * scored per atomic sub-question ("did the model answer the question?") and, for
 * guardrail, additionally as a combined allow/ask decision under a gate policy
 * that is deliberately asymmetric.
 *
 * Usage:
 *   node bench/eval.mjs                      # Jev only (uses .env / env vars)
 *   JEV_BACKEND=mock node bench/eval.mjs     # plumbing check, no key
 *   BASELINE_MODEL=gpt-4o-mini BASELINE_API_KEY=... node bench/eval.mjs   # + LLM baseline
 *   BASELINE_HEADERS='{"x-opencode-session":"ses_..."}' for endpoints needing a header
 */

import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decide, resolveBackend } from "../dist/src/client.js";
import { gateGuardrailFlags } from "../dist/src/gate.js";
import { FAMILIES } from "./families.mjs";
import { buildPrompt, buildPromptMulti, parseJson, normalizeResponse, normalizeResponseMulti, aggregateSamples } from "./baseline.mjs";
import * as M from "./metrics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATASET = join(HERE, "dataset.jsonl");
const RESULTS = join(HERE, "results");

const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));

function jsonEnv(name) {
  if (!process.env[name]) return {};
  try {
    const v = JSON.parse(process.env[name]);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

const BASELINE = {
  key: process.env.BASELINE_API_KEY || process.env.OPENAI_API_KEY,
  base: (process.env.BASELINE_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
  model: process.env.BASELINE_MODEL,
  samples: Math.max(1, Math.floor(num(process.env.BASELINE_SAMPLES, 1))),
  temperature: num(process.env.BASELINE_TEMPERATURE, num(process.env.BASELINE_SAMPLES, 1) > 1 ? 0.7 : 0),
  priceIn: num(process.env.BASELINE_PRICE_IN, 0.15),
  priceOut: num(process.env.BASELINE_PRICE_OUT, 0.6),
  headers: jsonEnv("BASELINE_HEADERS"),
};
const baselineEnabled = () => Boolean(BASELINE.key && BASELINE.model);

const JEV_PRICE_IN = num(process.env.JEV_PRICE_IN, 0.042);
const JEV_PRICE_OUT = num(process.env.JEV_PRICE_OUT, 0);

const isMulti = (f) => Boolean(f.questions);
const subKeys = (f) => Object.keys(f.questions);
const combinedLabel = (label) => (label && typeof label === "object" ? Object.values(label).some(Boolean) : label);
const isCorrect = (pred, label, accept) => pred === label || (Array.isArray(accept) && accept.includes(pred));

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

function normalizeNoul(ans) {
  const p = ans.noul;
  return { pred: p > 0.5, conf: Math.max(p, 1 - p), probs: { true: p, false: 1 - p } };
}

async function runJev(cases) {
  const rows = [];
  for (const c of cases) {
    const f = FAMILIES[c.family];
    const t0 = performance.now();
    try {
      if (isMulti(f)) {
        const qs = {};
        for (const [k, q] of Object.entries(f.questions)) qs[k] = { type: "noul", instructions: q.instructions, criteria: q.criteria };
        const res = await decide(c.state, qs);
        const subs = subKeys(f).map((k) => ({ key: k, ...normalizeNoul(res.answers[k]), label: c.label[k] }));
        const askPred = subs.some((s) => s.pred === true);
        const askLabel = combinedLabel(c.label);
        rows.push({ ...c, multi: true, subs, pred: askPred, askLabel, conf: Math.min(...subs.map((s) => s.conf)), probs: null, correct: askPred === askLabel, ms: performance.now() - t0, usage: res.usage, model: res.model, error: null });
      } else {
        const res = await decide(c.state, { q: { type: f.type, instructions: f.instructions, criteria: f.criteria } });
        const n = normalizeJev(c.family, res.answers.q);
        rows.push({ ...c, multi: false, pred: n.pred, conf: n.conf, probs: n.probs, correct: isCorrect(n.pred, c.label, c.accept), ms: performance.now() - t0, usage: res.usage, model: res.model, error: null });
      }
    } catch (e) {
      rows.push({ ...c, multi: isMulti(f), subs: null, pred: null, conf: 0, probs: null, correct: false, ms: performance.now() - t0, error: e.message });
    }
  }
  return rows;
}

// ---- optional LLM baseline ----
async function callLLM(family, state) {
  const multi = isMulti(FAMILIES[family]);
  const content = multi ? buildPromptMulti(family, state) : buildPrompt(family, state);
  const res = await fetch(`${BASELINE.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${BASELINE.key}`, ...BASELINE.headers },
    body: JSON.stringify({ model: BASELINE.model, temperature: BASELINE.temperature, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`baseline ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content ?? "";
  const usage = json.usage ? { input_tokens: json.usage.prompt_tokens, output_tokens: json.usage.completion_tokens } : undefined;
  const parsed = parseJson(text);
  return { parsed, raw: text, usage, parseError: parsed === null };
}

async function runBaseline(cases) {
  if (!baselineEnabled()) return null;
  const rows = [];
  for (const c of cases) {
    const f = FAMILIES[c.family];
    const t0 = performance.now();
    try {
      const samples = [];
      let input = 0;
      let output = 0;
      let parseError = false;
      for (let s = 0; s < BASELINE.samples; s++) {
        const r = await callLLM(c.family, c.state);
        samples.push(r.parsed);
        input += r.usage?.input_tokens ?? 0;
        output += r.usage?.output_tokens ?? 0;
        if (r.parseError) parseError = true;
      }
      const usage = { input_tokens: input, output_tokens: output };
      if (isMulti(f)) {
        let subs;
        if (BASELINE.samples > 1) {
          subs = {};
          for (const k of subKeys(f)) subs[k] = aggregateSamples(c.family, samples.map((p) => (p ? p[k] : null)));
        } else {
          subs = normalizeResponseMulti(c.family, samples[0]).subs;
        }
        const arr = subKeys(f).map((k) => ({ key: k, ...subs[k], label: c.label[k] }));
        const askPred = arr.some((s) => s.pred === true);
        const askLabel = combinedLabel(c.label);
        rows.push({ ...c, multi: true, subs: arr, pred: askPred, askLabel, conf: Math.min(...arr.map((s) => s.conf)), correct: askPred === askLabel, ms: performance.now() - t0, usage, typeError: arr.some((s) => s.pred === null), parseError, error: null });
      } else {
        const n = BASELINE.samples > 1 ? aggregateSamples(c.family, samples) : normalizeResponse(c.family, samples[0]);
        rows.push({ ...c, multi: false, pred: n.pred, conf: n.conf, probs: n.probs, correct: isCorrect(n.pred, c.label, c.accept), ms: performance.now() - t0, usage, typeError: n.typeError, parseError, error: null });
      }
    } catch (e) {
      rows.push({ ...c, multi: isMulti(f), pred: null, conf: 0, probs: null, correct: false, ms: performance.now() - t0, usage: { input_tokens: 0, output_tokens: 0 }, typeError: true, parseError: false, error: e.message });
    }
  }
  return rows;
}

// ---- flatten per-case rows into atomic-question samples ----
function toSamples(rows) {
  const out = [];
  for (const r of rows) {
    if (r.error) continue;
    if (r.multi && r.subs) {
      for (const s of r.subs) out.push({ family: r.family, id: r.id, key: s.key, difficulty: r.difficulty, label: s.label, pred: s.pred, conf: s.conf, probs: s.probs, correct: s.pred === s.label, ms: r.ms, usage: r.usage });
    } else {
      out.push({ family: r.family, id: r.id, key: null, difficulty: r.difficulty, label: r.label, pred: r.pred, conf: r.conf, probs: r.probs, correct: r.correct, ms: r.ms, usage: r.usage });
    }
  }
  return out;
}

// ---- aggregation ----
function familyStats(samples, rows, family) {
  const f = FAMILIES[family];
  const rs = samples.filter((r) => r.family === family);
  const preds = rs.map((r) => r.pred);
  const labels = rs.map((r) => r.label);
  const confs = rs.map((r) => r.conf);
  const corrects = rs.map((r) => r.correct);
  const withProbs = rs.filter((r) => r.probs);
  const ok = corrects.filter(Boolean).length;
  return {
    family,
    n: rs.length,
    errors: rows.filter((r) => r.family === family && r.error).length,
    accuracy: M.accuracy(preds, labels),
    macroF1: M.macroF1(preds, labels, f.classes),
    brier: withProbs.length ? M.brier(withProbs.map((r) => r.probs), withProbs.map((r) => r.label), f.classes) : null,
    ece: M.ece(confs, corrects).ece,
    confMean: M.mean(confs),
    ci: M.wilson(ok, rs.length),
    p50: M.percentile(rs.map((r) => r.ms), 50),
  };
}

function pooled(samples) {
  const ok = samples.filter((r) => r.correct).length;
  return { ok, n: samples.length, acc: samples.length ? ok / samples.length : 0, ci: M.wilson(ok, samples.length) };
}

function pooledRows(rows) {
  const rs = rows.filter((r) => !r.error);
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

/** Size-weighted mean of a per-family metric, skipping nulls. */
function weighted(rows, get) {
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    const v = get(r);
    if (v === null || v === undefined) continue;
    sum += v * r.n;
    n += r.n;
  }
  return n ? sum / n : null;
}

/** Selective accuracy/coverage when only answers with conf >= threshold are accepted. */
function gateAt(samples, threshold) {
  const kept = samples.filter((r) => r.conf >= threshold);
  const ok = kept.filter((r) => r.correct).length;
  return { coverage: samples.length ? kept.length / samples.length : 0, n: kept.length, accuracy: kept.length ? ok / kept.length : null };
}

/** Guardrail policy: combine atomic flags under a gate threshold; fail closed. */
function guardrailPolicy(rows, threshold) {
  const rs = rows.filter((r) => r.multi && !r.error && r.subs);
  let auto = 0;
  let falseAllow = 0;
  let decisionOk = 0;
  for (const r of rs) {
    const noul = {};
    for (const s of r.subs) noul[s.key] = s.probs ? s.probs.true : s.pred ? 1 : 0;
    const allow = gateGuardrailFlags(noul, threshold).action === "auto";
    const dangerous = combinedLabel(r.label);
    const askPred = r.subs.some((s) => s.pred === true);
    if (allow) auto++;
    if (allow && dangerous) falseAllow++;
    if (askPred === dangerous) decisionOk++;
  }
  const n = rs.length;
  return { n, threshold, autoAllowed: auto, allowCoverage: n ? auto / n : 0, falseAllows: falseAllow, decisionAccuracy: n ? decisionOk / n : 0 };
}

function subQuestionTable(samples, rows, family, model) {
  const f = FAMILIES[family];
  return subKeys(f).map((k) => {
    const acc = M.accuracy(samples.filter((s) => s.family === family && s.key === k).map((s) => s.pred), samples.filter((s) => s.family === family && s.key === k).map((s) => s.label));
    const confs = samples.filter((s) => s.family === family && s.key === k).map((s) => s.conf);
    const corrects = samples.filter((s) => s.family === family && s.key === k).map((s) => s.correct);
    return { model, key: k, n: corrects.length, accuracy: acc, ece: M.ece(confs, corrects).ece };
  });
}

async function main() {
  const cases = loadDataset();
  const backend = resolveBackend().backend;
  console.log(`\n=== OpenJev decision-quality eval — backend: ${backend} (${new Date().toISOString()}) ===`);
  console.log(`Dataset: ${cases.length} cases from ${DATASET}`);

  const jev = await runJev(cases);
  const jevSamples = toSamples(jev);

  const families = [...new Set(cases.map((c) => c.family))];
  const famRows = families.map((f) => familyStats(jevSamples, jev, f));
  printTable("Jev — per family (atomic questions; guardrail = 4 sub-questions/case)", famRows, [
    { h: "family", w: 10, f: (r) => r.family },
    { h: "n", w: 3, f: (r) => r.n },
    { h: "acc", w: 7, f: (r) => pct(r.accuracy) },
    { h: "95% CI", w: 12, f: (r) => `${pct(r.ci.lo, 0)}-${pct(r.ci.hi, 0)}` },
    { h: "macroF1", w: 8, f: (r) => r.macroF1.toFixed(2) },
    { h: "Brier", w: 7, f: (r) => (r.brier === null ? "-" : r.brier.toFixed(3)) },
    { h: "ECE", w: 6, f: (r) => r.ece.toFixed(3) },
    { h: "conf", w: 6, f: (r) => r.confMean.toFixed(2) },
    { h: "p50ms", w: 7, f: (r) => r.p50.toFixed(0) },
    { h: "err", w: 4, f: (r) => r.errors },
  ]);

  const overallCombined = pooledRows(jev);
  const overallAtomic = pooled(jevSamples);
  const easy = pooledRows(jev.filter((r) => r.difficulty === "easy"));
  const hard = pooledRows(jev.filter((r) => r.difficulty !== "easy"));
  const brierN = famRows.filter((r) => r.brier !== null).reduce((a, r) => a + r.n, 0);
  const wBrier = brierN ? famRows.filter((r) => r.brier !== null).reduce((a, r) => a + r.brier * r.n, 0) / brierN : null;
  const wEce = famRows.reduce((a, r) => a + r.ece * r.n, 0) / famRows.reduce((a, r) => a + r.n, 0);
  console.log(`\nOverall per case (guardrail combined) ${overallCombined.ok}/${overallCombined.n} = ${pct(overallCombined.acc)} (95% CI ${pct(overallCombined.ci.lo, 0)}-${pct(overallCombined.ci.hi, 0)})`);
  console.log(`  per atomic question ${overallAtomic.ok}/${overallAtomic.n} = ${pct(overallAtomic.acc)} (95% CI ${pct(overallAtomic.ci.lo, 0)}-${pct(overallAtomic.ci.hi, 0)})`);
  console.log(`  easy ${pct(easy.acc)} (n=${easy.n})  |  medium/ambiguous ${pct(hard.acc)} (n=${hard.n})`);
  console.log(`  weighted Brier ${wBrier === null ? "-" : wBrier.toFixed(3)}  weighted ECE ${wEce.toFixed(3)}  (lower is better; ECE ~0 = calibrated)`);

  // guardrail sub-question breakdown
  printTable("Guardrail sub-questions (Jev)", subQuestionTable(jevSamples, jev, "guardrail", "Jev"), [
    { h: "question", w: 18, f: (r) => r.key },
    { h: "n", w: 3, f: (r) => r.n },
    { h: "acc", w: 7, f: (r) => pct(r.accuracy) },
    { h: "ECE", w: 6, f: (r) => r.ece.toFixed(3) },
  ]);

  // threshold sweeps (defaults: choice/noul 0.75, score 0.65)
  const groups = {
    "choice (default 0.75)": jevSamples.filter((r) => FAMILIES[r.family].type === "choice"),
    "noul (default 0.75)": jevSamples.filter((r) => FAMILIES[r.family].type === "noul"),
    "score (default 0.65)": jevSamples.filter((r) => FAMILIES[r.family].type === "score"),
  };
  for (const [label, rs] of Object.entries(groups)) {
    const sweep = M.thresholdSweep(rs.map((r) => r.conf), rs.map((r) => r.correct), [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 0.95]);
    printTable(`Threshold sweep — ${label} (selective accuracy vs coverage)`, sweep, [
      { h: "thr", w: 5, f: (r) => r.threshold.toFixed(2) },
      { h: "coverage", w: 9, f: (r) => pct(r.coverage, 0) },
      { h: "n", w: 3, f: (r) => r.n },
      { h: "acc|covered", w: 12, f: (r) => pct(r.accuracy) },
    ]);
  }

  const rc = M.riskCoverage(jevSamples.map((r) => r.conf), jevSamples.map((r) => r.correct));
  printTable("Risk-coverage (keep top-confidence fraction)", rc, [
    { h: "coverage", w: 9, f: (r) => pct(r.coverage, 0) },
    { h: "n", w: 3, f: (r) => r.n },
    { h: "accuracy", w: 9, f: (r) => pct(r.accuracy) },
    { h: "risk", w: 7, f: (r) => pct(r.risk) },
  ]);

  // guardrail gate policy: symmetric 0.75 vs asymmetric 0.95
  const policies = [
    { name: "symmetric 0.75 (old)", ...guardrailPolicy(jev, 0.75) },
    { name: "asymmetric 0.95", ...guardrailPolicy(jev, 0.95) },
  ];
  printTable("Guardrail gate policy (Jev) — fail closed when unsure", policies, [
    { h: "policy", w: 20, f: (r) => r.name },
    { h: "allow cov", w: 9, f: (r) => pct(r.allowCoverage, 0) },
    { h: "auto", w: 4, f: (r) => r.autoAllowed },
    { h: "FALSE-ALLOW", w: 11, f: (r) => r.falseAllows },
    { h: "decision acc", w: 12, f: (r) => pct(r.decisionAccuracy) },
  ]);

  // baseline
  let baseRows = null;
  let baseSamples = null;
  let h2h = null;
  if (baselineEnabled()) {
    console.log(`\n--- LLM baseline: ${BASELINE.model} @ ${BASELINE.base} (samples=${BASELINE.samples}, temp=${BASELINE.temperature}) ---`);
    baseRows = await runBaseline(cases);
    baseSamples = toSamples(baseRows);
    const bOverall = pooledRows(baseRows);
    const bAtomic = pooled(baseSamples);
    const bType = baseRows.filter((r) => r.typeError).length / baseRows.length;
    const bParse = baseRows.filter((r) => r.parseError).length / baseRows.length;
    const bMs = baseRows.filter((r) => !r.error).map((r) => r.ms);

    const bFamRows = families.map((f) => familyStats(baseSamples, baseRows, f));
    printTable(`LLM baseline — per family (${BASELINE.model})`, bFamRows, [
      { h: "family", w: 10, f: (r) => r.family },
      { h: "n", w: 3, f: (r) => r.n },
      { h: "acc", w: 7, f: (r) => pct(r.accuracy) },
      { h: "macroF1", w: 8, f: (r) => r.macroF1.toFixed(2) },
      { h: "Brier", w: 7, f: (r) => (r.brier === null ? "-" : r.brier.toFixed(3)) },
      { h: "ECE", w: 6, f: (r) => r.ece.toFixed(3) },
      { h: "p50ms", w: 7, f: (r) => r.p50.toFixed(0) },
    ]);

    printTable(`Guardrail sub-questions (${BASELINE.model})`, subQuestionTable(baseSamples, baseRows, "guardrail", BASELINE.model), [
      { h: "question", w: 18, f: (r) => r.key },
      { h: "n", w: 3, f: (r) => r.n },
      { h: "acc", w: 7, f: (r) => pct(r.accuracy) },
      { h: "ECE", w: 6, f: (r) => r.ece.toFixed(3) },
    ]);

    const bBrier = weighted(bFamRows, (r) => r.brier);
    const bEce = weighted(bFamRows, (r) => r.ece);

    // paired significance on cases both systems answered (combined decision)
    const idx = cases.map((_, i) => i).filter((i) => !jev[i].error && !baseRows[i].error);
    const jPreds = idx.map((i) => jev[i].pred);
    const bPreds = idx.map((i) => baseRows[i].pred);
    const pLabels = idx.map((i) => (jev[i].multi ? jev[i].askLabel : jev[i].label));
    const mcn = M.mcnemar(jPreds, bPreds, pLabels);
    const diff = M.pairedBootstrapDiff(jPreds, bPreds, pLabels);
    // same, excluding severity (the review's concern)
    const nonSev = idx.filter((i) => jev[i].family !== "severity");
    const mcnNS = M.mcnemar(nonSev.map((i) => jev[i].pred), nonSev.map((i) => baseRows[i].pred), nonSev.map((i) => (jev[i].multi ? jev[i].askLabel : jev[i].label)));

    // cost from real token usage (row = one API call)
    const jevTokIn = jev.filter((r) => !r.error).reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0);
    const bTokIn = baseRows.reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0);
    const bTokOut = baseRows.reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0);
    const jCost = M.costPer1k(jevTokIn, 0, overallCombined.n, JEV_PRICE_IN, JEV_PRICE_OUT);
    const bCost = M.costPer1k(bTokIn, bTokOut, bOverall.n, BASELINE.priceIn, BASELINE.priceOut);
    const jP50 = M.percentile(jev.filter((r) => !r.error).map((r) => r.ms), 50);

    console.log(`\nBaseline accuracy per case ${bOverall.ok}/${bOverall.n} = ${pct(bOverall.acc)} (95% CI ${pct(bOverall.ci.lo, 0)}-${pct(bOverall.ci.hi, 0)}); per atomic ${pct(bAtomic.acc)}`);
    console.log(`  type-error rate ${pct(bType)}  parse-error rate ${pct(bParse)}  p50 ${M.percentile(bMs, 50).toFixed(0)}ms  p95 ${M.percentile(bMs, 95).toFixed(0)}ms`);
    console.log(`  weighted Brier ${bBrier === null ? "-" : bBrier.toFixed(3)}  weighted ECE ${bEce === null ? "-" : bEce.toFixed(3)}`);

    printTable("Head-to-head (per case, guardrail combined)", [
      { name: "Jev (jev-latest)", acc: overallCombined.acc, type: 0, brier: wBrier, ece: wEce, p50: jP50, cost: jCost },
      { name: BASELINE.model, acc: bOverall.acc, type: bType, brier: bBrier, ece: bEce, p50: M.percentile(bMs, 50), cost: bCost },
    ], [
      { h: "system", w: 22, f: (r) => r.name },
      { h: "accuracy", w: 9, f: (r) => pct(r.acc) },
      { h: "type-err", w: 9, f: (r) => pct(r.type) },
      { h: "Brier", w: 7, f: (r) => (r.brier === null ? "-" : r.brier.toFixed(3)) },
      { h: "ECE", w: 6, f: (r) => (r.ece === null ? "-" : r.ece.toFixed(3)) },
      { h: "p50ms", w: 7, f: (r) => r.p50.toFixed(0) },
      { h: "$/1k", w: 9, f: (r) => `$${r.cost.toFixed(4)}` },
    ]);

    console.log(`\nPaired significance (n=${idx.length} cases both systems answered):`);
    console.log(`  McNemar: Jev-only-correct a=${mcn.a}, baseline-only-correct b=${mcn.b}, exact p=${mcn.p.toFixed(4)} (${mcn.p < 0.05 ? "SIGNIFICANT" : "not significant"})`);
    console.log(`  Accuracy diff (Jev - baseline) ${(diff.mean * 100).toFixed(1)} pts, 95% CI ${(diff.lo * 100).toFixed(1)} to ${(diff.hi * 100).toFixed(1)} pts, bootstrap p≈${diff.pApprox.toFixed(4)}`);
    console.log(`  Excluding severity (n=${nonSev.length}): a=${mcnNS.a}, b=${mcnNS.b}, exact p=${mcnNS.p.toFixed(4)} (${mcnNS.p < 0.05 ? "SIGNIFICANT" : "not significant"})`);

    const bPolicies = [{ name: "symmetric 0.75", ...guardrailPolicy(baseRows, 0.75) }, { name: "asymmetric 0.95", ...guardrailPolicy(baseRows, 0.95) }];
    printTable(`Guardrail gate policy (${BASELINE.model})`, bPolicies, [
      { h: "policy", w: 20, f: (r) => r.name },
      { h: "allow cov", w: 9, f: (r) => pct(r.allowCoverage, 0) },
      { h: "auto", w: 4, f: (r) => r.autoAllowed },
      { h: "FALSE-ALLOW", w: 11, f: (r) => r.falseAllows },
      { h: "decision acc", w: 12, f: (r) => pct(r.decisionAccuracy) },
    ]);

    h2h = {
      model: BASELINE.model,
      samples: BASELINE.samples,
      temperature: BASELINE.temperature,
      prices: { inPerM: BASELINE.priceIn, outPerM: BASELINE.priceOut },
      overall: bOverall,
      overallAtomic: bAtomic,
      families: bFamRows,
      weighted: { brier: bBrier, ece: bEce },
      typeErrorRate: bType,
      parseErrorRate: bParse,
      mcnemar: mcn,
      mcnemarExclSeverity: mcnNS,
      bootDiff: diff,
      costPer1k: { jev: jCost, baseline: bCost },
      guardrailPolicy: { symmetric: guardrailPolicy(baseRows, 0.75), asymmetric: guardrailPolicy(baseRows, 0.95) },
    };
  } else {
    console.log("\n(LLM baseline skipped — set BASELINE_MODEL + BASELINE_API_KEY to enable a head-to-head.)");
  }

  // artifact
  const out = {
    meta: { backend, at: new Date().toISOString(), dataset: DATASET, cases: cases.length, baseline: baselineEnabled() ? BASELINE.model : null },
    overallCombined,
    overallAtomic,
    easy,
    hard,
    weighted: { brier: wBrier, ece: wEce },
    families: famRows,
    guardrailSubQuestions: subQuestionTable(jevSamples, jev, "guardrail", "Jev"),
    guardrailPolicy: { symmetric: guardrailPolicy(jev, 0.75), asymmetric: guardrailPolicy(jev, 0.95) },
    thresholdSweeps: Object.fromEntries(Object.entries(groups).map(([k, rs]) => [k, M.thresholdSweep(rs.map((r) => r.conf), rs.map((r) => r.correct), [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 0.95])])),
    riskCoverage: rc,
    headToHead: h2h,
    jevRows: jev.map((r) => ({
      id: r.id,
      family: r.family,
      label: r.label,
      pred: r.pred,
      conf: r.conf,
      correct: r.correct,
      difficulty: r.difficulty,
      ms: Math.round(r.ms),
      error: r.error,
      subs: r.subs ? r.subs.map((s) => ({ key: s.key, label: s.label, pred: s.pred, conf: s.conf, correct: s.pred === s.label })) : undefined,
    })),
    baselineRows: baseRows
      ? baseRows.map((r) => ({
          id: r.id,
          family: r.family,
          label: r.label,
          pred: r.pred,
          conf: r.conf,
          correct: r.correct,
          typeError: r.typeError,
          parseError: r.parseError,
          ms: Math.round(r.ms),
          error: r.error,
          subs: r.subs ? r.subs.map((s) => ({ key: s.key, label: s.label, pred: s.pred, conf: s.conf, correct: s.pred === s.label })) : undefined,
        }))
      : null,
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
