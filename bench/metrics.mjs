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
