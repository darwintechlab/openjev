/**
 * Evaluation metrics for typed decisions.
 *
 * Pure functions, no deps. All take parallel arrays unless noted.
 * `probsList` is an array of { class -> probability } maps (one per sample).
 * `confs` is the top-label confidence (max prob) per sample; `corrects` is boolean.
 */

export function accuracy(preds, labels) {
  if (!preds.length) return 0;
  let ok = 0;
  for (let i = 0; i < preds.length; i++) if (preds[i] === labels[i]) ok++;
  return ok / preds.length;
}

export function confusion(preds, labels, classes) {
  const m = {};
  for (const a of classes) {
    m[a] = {};
    for (const b of classes) m[a][b] = 0;
  }
  for (let i = 0; i < preds.length; i++) {
    const l = labels[i];
    const p = preds[i];
    if (m[l] && m[l][p] !== undefined) m[l][p]++;
  }
  return m;
}

export function perClass(preds, labels, classes) {
  const out = {};
  for (const c of classes) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let support = 0;
    for (let i = 0; i < preds.length; i++) {
      if (labels[i] === c) {
        support++;
        if (preds[i] === c) tp++;
        else fn++;
      } else if (preds[i] === c) {
        fp++;
      }
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    out[c] = { precision, recall, f1, support };
  }
  return out;
}

export function macroF1(preds, labels, classes) {
  const pc = perClass(preds, labels, classes);
  return classes.reduce((a, c) => a + pc[c].f1, 0) / classes.length;
}

/** Multiclass Brier score (lower is better; 0 = perfect). */
export function brier(probsList, labels, classes) {
  if (!probsList.length) return 0;
  let s = 0;
  for (let i = 0; i < probsList.length; i++) {
    for (const c of classes) {
      const p = probsList[i][c] ?? 0;
      const y = labels[i] === c ? 1 : 0;
      s += (p - y) * (p - y);
    }
  }
  return s / probsList.length;
}

/**
 * Expected Calibration Error over confidence bins (lower is better).
 * Bins by top-label confidence; compares mean confidence to empirical accuracy.
 */
export function ece(confs, corrects, bins = 10) {
  const N = confs.length;
  if (!N) return { ece: 0, bins: [] };
  const detail = [];
  let e = 0;
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    let n = 0;
    let confSum = 0;
    let accSum = 0;
    for (let i = 0; i < N; i++) {
      const c = confs[i];
      const inBin = (c > lo && c <= hi) || (b === 0 && c === 0);
      if (!inBin) continue;
      n++;
      confSum += c;
      accSum += corrects[i] ? 1 : 0;
    }
    const avgConf = n ? confSum / n : 0;
    const avgAcc = n ? accSum / n : 0;
    if (n) e += (n / N) * Math.abs(avgAcc - avgConf);
    detail.push({ bin: [lo, hi], n, avgConf, avgAcc, gap: avgAcc - avgConf });
  }
  return { ece: e, bins: detail };
}

/** Selective prediction: accuracy/risk when keeping the top-`coverage` fraction by confidence. */
export function riskCoverage(confs, corrects, coverages = [1, 0.9, 0.8, 0.7, 0.5, 0.3, 0.1]) {
  const N = confs.length;
  if (!N) return [];
  const idx = confs.map((_, i) => i).sort((a, b) => confs[b] - confs[a]);
  return coverages.map((cov) => {
    const k = Math.max(1, Math.round(cov * N));
    let ok = 0;
    for (let j = 0; j < k; j++) if (corrects[idx[j]]) ok++;
    const acc = ok / k;
    return { coverage: k / N, n: k, accuracy: acc, risk: 1 - acc };
  });
}

/** Accuracy/coverage if we only accept answers with confidence >= threshold. */
export function thresholdSweep(confs, corrects, thresholds) {
  const N = confs.length;
  return thresholds.map((t) => {
    let n = 0;
    let ok = 0;
    for (let i = 0; i < N; i++) {
      if (confs[i] >= t) {
        n++;
        if (corrects[i]) ok++;
      }
    }
    return { threshold: t, coverage: n / N, n, accuracy: n ? ok / n : null, risk: n ? 1 - ok / n : null };
  });
}

/** Wilson score interval for a binomial proportion (small-n safe). */
export function wilson(successes, n, z = 1.96) {
  if (!n) return { p: 0, lo: 0, hi: 1 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / denom;
  return { p, lo: Math.max(0, center - margin), hi: Math.min(1, center + margin) };
}

export function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * s.length) - 1;
  return s[Math.max(0, Math.min(idx, s.length - 1))];
}

export function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

/** Deterministic PRNG (mulberry32) so bootstrap results are reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Lanczos log-gamma, so the exact test stays finite for large discordant counts.
function logGamma(x) {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function logBinomPmf(n, k, p) {
  if (k < 0 || k > n) return -Infinity;
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log(1 - p);
}

/** Sum a set of log-probabilities without underflow. */
function logSumExp(logs) {
  let max = -Infinity;
  for (const l of logs) if (l > max) max = l;
  if (max === -Infinity) return 0;
  let sum = 0;
  for (const l of logs) sum += Math.exp(l - max);
  return Math.log(sum) + max;
}

/**
 * McNemar's test for paired correctness of two systems A and B.
 *   a = # cases where A is correct and B is wrong
 *   b = # cases where A is wrong and B is correct
 * Returns the two-sided exact binomial p-value (robust at small discordant
 * counts) plus the continuity-corrected chi-square statistic.
 * p < 0.05 means the accuracy difference is unlikely under the null (A == B).
 */
export function mcnemar(predsA, predsB, labels) {
  let a = 0;
  let b = 0;
  let both = 0;
  let neither = 0;
  for (let i = 0; i < labels.length; i++) {
    const A = predsA[i] === labels[i];
    const B = predsB[i] === labels[i];
    if (A && B) both++;
    else if (!A && !B) neither++;
    else if (A) a++;
    else b++;
  }
  const n = a + b;
  let p = 1;
  if (n > 0) {
    const k = Math.min(a, b);
    const logs = [];
    for (let i = 0; i <= k; i++) logs.push(logBinomPmf(n, i, 0.5));
    p = Math.min(1, 2 * Math.exp(logSumExp(logs)));
  }
  const chi2 = n > 0 ? (Math.abs(a - b) - 1) ** 2 / n : 0;
  return { a, b, both, neither, n, chi2, p };
}

/**
 * Bootstrap CI for a single accuracy. `corrects` is a boolean array.
 * Resamples cases with replacement (deterministic via `seed`).
 */
export function bootstrapCI(corrects, { iters = 2000, seed = 42, alpha = 0.05 } = {}) {
  const N = corrects.length;
  if (!N) return { mean: 0, lo: 0, hi: 0, iters, alpha };
  const rand = mulberry32(seed);
  const out = new Float64Array(iters);
  for (let t = 0; t < iters; t++) {
    let ok = 0;
    for (let i = 0; i < N; i++) if (corrects[Math.floor(rand() * N)]) ok++;
    out[t] = ok / N;
  }
  return summarizeBootstrap(out, iters, alpha);
}

/**
 * Paired bootstrap CI for the accuracy difference (A - B) on the same cases.
 * Because it resamples *cases*, it respects the pairing. `pApprox` is the
 * two-sided bootstrap p-value (mass on the wrong side of zero, doubled).
 */
export function pairedBootstrapDiff(predsA, predsB, labels, { iters = 2000, seed = 42, alpha = 0.05 } = {}) {
  const N = labels.length;
  if (!N) return { mean: 0, lo: 0, hi: 0, iters, alpha, pApprox: 1 };
  const rand = mulberry32(seed);
  const out = new Float64Array(iters);
  for (let t = 0; t < iters; t++) {
    let accA = 0;
    let accB = 0;
    for (let i = 0; i < N; i++) {
      const j = Math.floor(rand() * N);
      if (predsA[j] === labels[j]) accA++;
      if (predsB[j] === labels[j]) accB++;
    }
    out[t] = (accA - accB) / N;
  }
  const s = summarizeBootstrap(out, iters, alpha);
  let le = 0;
  let ge = 0;
  for (let t = 0; t < iters; t++) {
    if (out[t] <= 0) le++;
    if (out[t] >= 0) ge++;
  }
  return { ...s, pApprox: Math.min(1, (2 * Math.min(le, ge)) / iters) };
}

function summarizeBootstrap(out, iters, alpha) {
  out.sort();
  const lo = out[Math.min(iters - 1, Math.max(0, Math.floor((alpha / 2) * iters)))];
  const hi = out[Math.min(iters - 1, Math.max(0, Math.ceil((1 - alpha / 2) * iters) - 1))];
  let sum = 0;
  for (let t = 0; t < iters; t++) sum += out[t];
  return { mean: sum / iters, lo, hi, iters, alpha };
}

/** $ per 1k decisions from aggregate token usage over `n` decisions. */
export function costPer1k(tokensIn, tokensOut, n, priceInPerM, priceOutPerM = 0) {
  if (!n) return 0;
  return ((tokensIn * priceInPerM + tokensOut * priceOutPerM) / 1_000_000 / n) * 1000;
}
