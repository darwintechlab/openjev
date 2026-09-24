/** Structured audit log — privacy-safe, no secrets in state. */

export type AuditEntry = {
  at: string;
  model: string;
  backend: string;
  tool: string;
  stateHash: string;
  stateChars: number;
  questions: string[];
  answers: Record<string, { type: string; choice?: string; noul?: number; score?: number; confidence?: number }>;
  latencyMs: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  gated?: Record<string, { action: "auto" | "escalate"; reason: string }>;
};

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function toAuditEntry(args: {
  tool: string;
  model: string;
  backend: string;
  state: string | object;
  questions: Record<string, unknown>;
  answers: Record<string, unknown>;
  latencyMs: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  gated?: Record<string, { action: "auto" | "escalate"; reason: string }>;
}): AuditEntry {
  const stateStr = typeof args.state === "string" ? args.state : JSON.stringify(args.state);
  return {
    at: new Date().toISOString(),
    model: args.model,
    backend: args.backend,
    tool: args.tool,
    stateHash: hash(stateStr),
    stateChars: stateStr.length,
    questions: Object.keys(args.questions),
    answers: Object.fromEntries(
      Object.entries(args.answers as Record<string, { type: string; choice?: string; noul?: number; score?: number; confidence?: number }>).map(([k, v]) => [
        k,
        { type: v.type, choice: v.choice, noul: v.noul, score: v.score, confidence: v.confidence },
      ])
    ),
    latencyMs: Math.round(args.latencyMs),
    usage: args.usage,
    gated: args.gated,
  };
}

/** Format for client.app.log — keep stateHash, not raw state */
export function auditLogLine(e: AuditEntry): string {
  const g = e.gated ? ` gated=${Object.entries(e.gated).map(([k, v]) => `${k}:${v.action}`).join(",")}` : "";
  return `jev ${e.tool} ${e.model}/${e.backend} ${e.latencyMs}ms hash=${e.stateHash}${g} conf=${Object.values(e.answers).map((a) => a.confidence?.toFixed(2) ?? a.noul?.toFixed(2) ?? "-").join(",")}`;
}
