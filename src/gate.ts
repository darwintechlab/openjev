/** Confidence gating — calibrated thresholds for Jev's RLCD probabilities. */

export const DEFAULT_THRESHOLDS = {
  choice: 0.75,
  noul: 0.75,
  score: 0.65,
  // Guardrails are asymmetric: auto-allowing a dangerous command is far worse
  // than asking, so "safe" must be very confident before we skip the prompt.
  guardrail: 0.95,
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

/**
 * Guardrail gate — deliberately asymmetric. `noul` is P(risky). We only
 * auto-allow when the safe side is very confident (`P(safe) >= safeThreshold`);
 * anything else asks a human. Fail-closed by design.
 */
export function gateGuardrail(noul: number, safeThreshold: number = DEFAULT_THRESHOLDS.guardrail): GateResult {
  const pSafe = 1 - noul;
  if (pSafe >= safeThreshold) return { action: "auto", reason: `P(safe) ${pSafe.toFixed(2)} >= ${safeThreshold} — allow` };
  return { action: "escalate", reason: `P(safe) ${pSafe.toFixed(2)} < ${safeThreshold} — ask before running` };
}

/**
 * Combine several atomic guardrail flags (e.g. data_loss, security, resources,
 * outside_workspace). Auto-allows only when every flag's safe side clears the
 * threshold; the most risky flag governs.
 */
export function gateGuardrailFlags(
  flags: Record<string, number> | number[],
  safeThreshold: number = DEFAULT_THRESHOLDS.guardrail
): GateResult {
  const values = (Array.isArray(flags) ? flags : Object.values(flags)).filter((v) => typeof v === "number");
  if (!values.length) return { action: "escalate", reason: "no guardrail flags supplied — ask" };
  return gateGuardrail(Math.max(...values), safeThreshold);
}

/** Convenience: pick gate by answer type */
export function gateAnswer(answer: { type: string; confidence?: number; noul?: number }, threshold?: number): GateResult {
  if (answer.type === "choice") return gateChoice(answer.confidence ?? 0, threshold);
  if (answer.type === "noul") return gateNoul(answer.noul ?? 0.5, threshold);
  if (answer.type === "score") return gateScore(answer.confidence ?? 0, threshold);
  return { action: "auto", reason: "unknown type" };
}
