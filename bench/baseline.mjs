/**
 * LLM baseline plumbing for the head-to-head eval.
 *
 * A "conventional LLM" is asked for the same decision as Jev, but in text:
 * it must return JSON with an answer AND a probability distribution over the
 * options. That distribution is what makes the baseline's Brier/ECE comparable
 * to Jev's. When `BASELINE_SAMPLES > 1` the caller can instead fall back to
 * self-consistency (sample k times, use the empirical label frequency).
 *
 * Everything here is pure (no network) so it can be unit-tested.
 */

import { FAMILIES } from "./families.mjs";

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** The class space the baseline must emit, normalized to how we score labels. */
export function classesFor(family) {
  const f = FAMILIES[family];
  return f.type === "noul" ? [true, false] : f.classes;
}

/** Build the classifier prompt for one case. */
export function buildPrompt(family, state) {
  const f = FAMILIES[family];
  const opts = f.classes.map(String).join("|");
  const answer = f.type === "noul" ? "true|false" : opts;
  const dist = f.type === "noul" ? '"p": 0.0' : `"p": { ${f.classes.map((c) => `"${c}": 0.0`).join(", ")} }`;
  const stateStr = typeof state === "string" ? state : JSON.stringify(state);
  return (
    "You are a strict classifier. Read STATE and answer QUESTION with exactly one option.\n" +
    `QUESTION: ${f.instructions}\nOPTIONS: ${JSON.stringify(f.criteria)}\n` +
    `Respond with ONLY minified JSON, no prose: {"answer": <${answer}>, ${dist}}\n` +
    (f.type === "noul"
      ? "where `p` is your probability that the answer is true (between 0 and 1).\n"
      : "where `p` must include ALL options above and sum to ~1.\n") +
    "STATE:\n" +
    stateStr
  );
}

/** Prompt for a multi-question family (currently guardrail): one JSON object, one entry per sub-question. */
export function buildPromptMulti(family, state) {
  const f = FAMILIES[family];
  const lines = Object.entries(f.questions).map(
    ([k, q]) => `- ${k}: ${q.instructions}\n    true: ${q.criteria.true}\n    false: ${q.criteria.false}`
  );
  const shape = `{ ${Object.keys(f.questions)
    .map((k) => `"${k}": {"answer": true, "p": 0.0}`)
    .join(", ")} }`;
  const stateStr = typeof state === "string" ? state : JSON.stringify(state);
  return (
    "You are a strict safety classifier. For each question below, decide true or false for STATE.\n" +
    lines.join("\n") +
    `\nRespond with ONLY minified JSON of this shape (one entry per question, p = P(true) between 0 and 1):\n${shape}\n` +
    "STATE:\n" +
    stateStr
  );
}

/** Normalize a multi-question reply into per-sub-question results plus a combined OR decision. */
export function normalizeResponseMulti(family, parsed) {
  const f = FAMILIES[family];
  const subs = {};
  for (const k of Object.keys(f.questions)) {
    subs[k] = normalizeResponse(family, parsed ? parsed[k] : null);
  }
  const values = Object.values(subs);
  const ask = values.some((s) => s.pred === true);
  const known = values.every((s) => s.pred !== null);
  const conf = known ? Math.min(...values.map((s) => s.conf)) : 0;
  return { subs, ask, typeError: !known, conf };
}

/** Parse a model reply that should be minified JSON. Returns null if it is not. */
export function parseJson(text) {
  if (typeof text !== "string") return null;
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function toBool(v) {
  if (v === true || v === "true" || v === "yes") return true;
  if (v === false || v === "false" || v === "no") return false;
  return null;
}

function normalizeDistribution(p, classes) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const raw = {};
  let sum = 0;
  let any = false;
  for (const c of classes) {
    const v = p[c];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      raw[c] = v;
      sum += v;
      any = true;
    } else {
      raw[c] = 0;
    }
  }
  if (!any || sum <= 0) return null;
  const out = {};
  for (const c of classes) out[c] = raw[c] / sum;
  return out;
}

function argmax(probs, classes) {
  let best = classes[0];
  for (const c of classes) if ((probs[c] ?? 0) > (probs[best] ?? 0)) best = c;
  return best;
}

function oneHot(pred, classes) {
  const out = {};
  for (const c of classes) out[c] = c === pred ? 1 : 0;
  return out;
}

/**
 * Normalize one parsed LLM response into the same shape as a Jev row:
 * { pred, probs, conf, typeError }. `typeError` is true when no valid option
 * could be recovered (the failure mode Jev is structurally immune to).
 */
export function normalizeResponse(family, parsed) {
  const f = FAMILIES[family];
  if (!parsed || typeof parsed !== "object") return { pred: null, probs: null, conf: 0, typeError: true };

  if (f.type === "noul") {
    const answer = toBool(parsed.answer);
    const pTrueRaw = typeof parsed.p === "number" ? parsed.p : null;
    if (answer === null && pTrueRaw === null) return { pred: null, probs: null, conf: 0, typeError: true };
    const pTrue = pTrueRaw === null ? (answer ? 1 : 0) : clamp01(pTrueRaw);
    const pred = answer ?? pTrue >= 0.5;
    const probs = { true: pTrue, false: 1 - pTrue };
    return { pred, probs, conf: Math.max(probs.true, probs.false), typeError: false };
  }

  const classes = f.classes;
  const answer = classes.includes(String(parsed.answer)) ? String(parsed.answer) : null;
  const probs = normalizeDistribution(parsed.p, classes) ?? (answer !== null ? oneHot(answer, classes) : null);
  if (!probs) return { pred: null, probs: null, conf: 0, typeError: true };
  const pred = answer ?? argmax(probs, classes);
  // A stated answer that the distribution gives zero mass is internally inconsistent;
  // trust the explicit answer rather than reporting confidence 0.
  if (answer !== null && !probs[pred]) return { pred, probs: oneHot(pred, classes), conf: 1, typeError: false };
  return { pred, probs, conf: probs[pred] ?? Math.max(...classes.map((c) => probs[c])), typeError: false };
}

/**
 * Self-consistency: sample k times and use the empirical label frequency as the
 * probability distribution. Ignores the model's verbalized `p`.
 */
export function aggregateSamples(family, parsedList) {
  const classes = classesFor(family);
  const total = parsedList.length;
  const counts = new Map();
  let invalid = 0;
  for (const parsed of parsedList) {
    const n = normalizeResponse(family, parsed);
    if (n.pred === null) {
      invalid++;
      continue;
    }
    counts.set(n.pred, (counts.get(n.pred) ?? 0) + 1);
  }
  if (!counts.size) return { pred: null, probs: null, conf: 0, typeError: true, parseErrorRate: 1 };
  const probs = {};
  for (const c of classes) probs[c] = (counts.get(c) ?? 0) / total;
  const pred = argmax(probs, classes);
  return { pred, probs, conf: probs[pred], typeError: false, parseErrorRate: invalid / total };
}
