/** Confidence gating — calibrated thresholds for Jev's RLCD probabilities. */

export const DEFAULT_THRESHOLDS = {
  choice: 0.75,
  noul: 0.75,
  score: 0.65,
} as const;

export type GateResult = { action: "auto"; reason: string } | { action: "escalate"; reason: string };

export function gateChoice(confidence: number, threshold: number = DEFAULT_THRESHOLDS.choice): GateResult {
  if (confidence >= threshold) return { action: "auto", reason: `confidence ${confidence.toFixed(2)} >= ${threshold}` };
  return { action: "escalate", reason: `confidence ${confidence.toFixed(2)} < ${threshold} — escalate to LLM/human for rationale` };
}

export function gateNoul(noul: number, threshold: number = DEFAULT_THRESHOLDS.noul): GateResult {
  const conf = Math.max(noul, 1 - noul);
  if (conf >= threshold) return { action: "auto", reason: `noul ${noul.toFixed(2)} (conf ${conf.toFixed(2)}) >= ${threshold}` };
  return { action: "escalate", reason: `noul ${noul.toFixed(2)} (conf ${conf.toFixed(2)}) < ${threshold} — ambiguous, ask LLM/human` };
}

export function gateScore(confidence: number, threshold: number = DEFAULT_THRESHOLDS.score): GateResult {
  if (confidence >= threshold) return { action: "auto", reason: `score conf ${confidence.toFixed(2)} >= ${threshold}` };
  return { action: "escalate", reason: `score conf ${confidence.toFixed(2)} < ${threshold} — low certainty rubric` };
}

/** Convenience: pick gate by answer type */
export function gateAnswer(answer: { type: string; confidence?: number; noul?: number }, threshold?: number): GateResult {
  if (answer.type === "choice") return gateChoice(answer.confidence ?? 0, threshold);
  if (answer.type === "noul") return gateNoul(answer.noul ?? 0.5, threshold);
  if (answer.type === "score") return gateScore(answer.confidence ?? 0, threshold);
  return { action: "auto", reason: "unknown type" };
}
