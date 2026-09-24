#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { decide } from "../dist/src/client.js";

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * s.length) - 1;
  return s[Math.max(0, Math.min(idx, s.length - 1))];
}
function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function fmt(n) {
  return n.toFixed(1);
}

async function timed(fn) {
  const t0 = performance.now();
  const res = await fn();
  const t1 = performance.now();
  return { ms: t1 - t0, res };
}

// ---- synthetic datasets ----
const ticketCases = [
  { state: "Help! payouts failing 3 days — order #48281 hasn't cleared. Customers complaining.", expect: "billing" },
  { state: "Login loop after MFA — can't access dashboard, 500 on /auth/callback", expect: "technical" },
  { state: "What does enterprise plan cost for 50 seats? Need invoice.", expect: "sales" },
  { state: "WIN FREE CRYPTO click here!!!", expect: "spam" },
  { state: "Refund for invoice INV-9921 — charged twice for pro plan.", expect: "billing" },
  { state: "API returns 429 even at 2 req/s — docs say 10 req/s limit. Repro curl included.", expect: "technical" },
  { state: "Can I upgrade mid-cycle and prorate?", expect: "sales" },
  { state: "You have been pre-approved for a loan — reply with SSN", expect: "spam" },
  { state: "Payout webhook not firing for ACH — logs show 200 but no event.", expect: "technical" },
  { state: "Billing address change for next invoice — VAT ID updated.", expect: "billing" },
];

const criteria = {
  billing: "payments, invoices, payouts, refunds, billing address, VAT",
  technical: "bugs, outages, API, auth, webhooks, errors, integration",
  sales: "buying, pricing, plans, upgrade, seats, procurement",
  spam: "irrelevant, abusive, scam, promotion, unsolicited",
};

async function benchLatency({ backendLabel, runs = 10, questions = 1 }) {
  const msArr = [];
  let lastUsage = null;
  for (let i = 0; i < runs; i++) {
    const qs = {};
    for (let q = 0; q < questions; q++) {
      qs[`q${q}`] = { type: "choice", instructions: "Route to team", criteria };
    }
    const { ms, res } = await timed(() => decide(ticketCases[0].state, qs));
    msArr.push(ms);
    lastUsage = res.usage;
    if (backendLabel !== "mock") await new Promise((r) => setTimeout(r, 120)); // gentle pacing for hosted
  }
  return { backendLabel, runs, questions, p50: percentile(msArr, 50), p95: percentile(msArr, 95), mean: mean(msArr), min: Math.min(...msArr), max: Math.max(...msArr), lastUsage, raw: msArr };
}

async function benchAccuracy() {
  let correct = 0;
  const rows = [];
  for (const { state, expect } of ticketCases) {
    const res = await decide(state, { team: { type: "choice", instructions: "Route to team", criteria } });
    const ans = res.answers.team;
    const ok = ans.choice === expect;
    if (ok) correct++;
    rows.push({ state: state.slice(0, 60), expect, got: ans.choice, conf: ans.confidence, ok, probs: ans.probabilities });
    await new Promise((r) => setTimeout(r, 80));
  }
  return { correct, total: ticketCases.length, acc: correct / ticketCases.length, rows };
}

async function benchParallelVsSequential({ n = 10 }) {
  // sequential: n separate decide calls with 1 question each
  const state = ticketCases[0].state;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    await decide(state, { q: { type: "choice", instructions: "Route to team", criteria } });
    await new Promise((r) => setTimeout(r, 40));
  }
  const seqMs = performance.now() - t0;

  // parallel: one decide with n questions
  const qs = {};
  for (let i = 0; i < n; i++) qs[`q${i}`] = { type: "choice", instructions: "Route to team", criteria };
  const { ms: parMs, res } = await timed(() => decide(state, qs));

  return { n, seqMs, parMs, speedup: seqMs / parMs, usage: res.usage };
}

async function main() {
  const backend = process.env.JEV_BACKEND || (process.env.TYPESAFE_API_KEY ? "hosted(typesafe)" : "mock");
  const isMock = backend === "mock" || process.env.JEV_BACKEND === "mock";
  console.log(`\n=== OpenJev bench — backend: ${isMock ? "mock" : "hosted"} (${new Date().toISOString()}) ===`);
  console.log(`Model: jev-latest / jev-1.13.0 | State: ticket routing | Criteria: ${Object.keys(criteria).join(", ")}`);

  // Warmup
  await decide("warmup", { q: { type: "noul", instructions: "warm?" } });

  // 1) Latency — single question
  console.log("\n--- 1) Latency: 1 question, 15 runs ---");
  const l1 = await benchLatency({ backendLabel: isMock ? "mock" : "hosted", runs: 15, questions: 1 });
  console.log(`p50 ${fmt(l1.p50)}ms  p95 ${fmt(l1.p95)}ms  mean ${fmt(l1.mean)}ms  min ${fmt(l1.min)}ms  max ${fmt(l1.max)}ms  usage: ${JSON.stringify(l1.lastUsage)}`);

  // 2) Latency — parallel 27 (harness row-filter scale per AntonioCoppe/jev-harness)
  console.log("\n--- 2) Latency: 27 parallel questions, 8 runs ---");
  const l27 = await benchLatency({ backendLabel: isMock ? "mock" : "hosted", runs: 8, questions: 27 });
  console.log(`p50 ${fmt(l27.p50)}ms  p95 ${fmt(l27.p95)}ms  mean ${fmt(l27.mean)}ms  min ${fmt(l27.min)}ms  max ${fmt(l27.max)}ms  overhead vs 1q: +${fmt(l27.mean - l1.mean)}ms  usage: ${JSON.stringify(l27.lastUsage)}`);

  // 3) Parallel vs sequential n=10
  console.log("\n--- 3) Parallel vs sequential (n=10 choices, same state) ---");
  const ps = await benchParallelVsSequential({ n: 10 });
  console.log(`sequential 10x1q: ${fmt(ps.seqMs)}ms  parallel 1x10q: ${fmt(ps.parMs)}ms  speedup ${ps.speedup.toFixed(1)}x  usage: ${JSON.stringify(ps.usage)}`);

  // 4) Accuracy on 10 synthetic tickets (hosted is meaningful; mock is noise baseline)
  console.log("\n--- 4) Accuracy: 10 tickets → Choice(billing/technical/sales/spam) ---");
  const acc = await benchAccuracy();
  console.log(`accuracy ${acc.correct}/${acc.total} = ${(acc.acc * 100).toFixed(1)}%`);
  for (const r of acc.rows) {
    console.log(`  ${r.ok ? "✓" : "✗"} expect=${r.expect} got=${r.got} conf=${r.conf.toFixed(2)}  "${r.state}..."`);
  }
  const confs = acc.rows.map((r) => r.conf);
  console.log(`  confidence mean ${mean(confs).toFixed(2)} p50 ${percentile(confs, 50).toFixed(2)}`);

  // 5) Cost estimate (TypeSafe pricing: $0.042/M input, output free)
  const est = l1.lastUsage?.input_tokens ?? 400;
  const costPerCall = (est / 1_000_000) * 0.042;
  console.log("\n--- 5) Cost (vendor pricing) ---");
  console.log(`Hosted Jev: $0.042/M input, output free. This bench's 1q call: ~${est} in-tok => $${costPerCall.toFixed(6)} / call (~$${(costPerCall * 1000).toFixed(4)} / 1k calls)`);
  console.log(`TypeSafe report: ~$0.0004 / decision case vs GPT-5.6 Terra $0.0304 (1/76), 0% type errors. Local mock: $0.`);

  console.log("\n--- 6) Baseline context (reported, not measured here) ---");
  console.log("LLM text → JSON on same task: Terra ~10s, Sol ~23s, Opus ~38s per DataCamp/TypeSafe 4-workflow eval (67-74% acc). Jev 0.07-0.5s at ~68% — 40-200x faster, 40-400x cheaper.");

  // also write json for artifact
  const out = { meta: { backend: isMock ? "mock" : "hosted", at: new Date().toISOString() }, latency1: l1, latency27: l27, parallel: ps, accuracy: acc, cost: { inputTok1q: est, usdPerCall: costPerCall } };
  await import("node:fs/promises").then(async (fs) => {
    await fs.mkdir("bench/results", { recursive: true });
    await fs.writeFile(`bench/results/bench-${isMock ? "mock" : "hosted"}-${Date.now()}.json`, JSON.stringify(out, null, 2));
    console.log(`\nWrote bench/results/bench-${isMock ? "mock" : "hosted"}-*.json`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
