import { tool, type Plugin } from "@opencode-ai/plugin";
import { decide, resolveBackend, type Questions } from "./client.js";
import { loadDotEnv } from "./dotenv.js";
import { gateChoice, gateNoul, gateScore, gateAnswer, DEFAULT_THRESHOLDS } from "./gate.js";
import { toAuditEntry, auditLogLine } from "./audit.js";
import { lintChoiceCriteria, lintScoreLevels } from "./state.js";

const MAX_STATE_CHARS = 60_000;
const MAX_CRITERIA_OPTION_DESC = 2000;

function parseChoiceCriteria(input: unknown): Record<string, string | null> {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) throw new Error("criteria: must be a JSON object string mapping option -> description");
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (v !== null && typeof v !== "string") throw new Error(`criteria["${k}"]: value must be string or null`);
          if (typeof v === "string" && v.length > MAX_CRITERIA_OPTION_DESC) throw new Error(`criteria["${k}"]: description too long (max ${MAX_CRITERIA_OPTION_DESC})`);
        }
        return parsed as Record<string, string | null>;
      }
    } catch (e) {
      if ((e as Error).message.includes("description too long") || (e as Error).message.includes("value must")) throw e;
    }
    throw new Error('criteria must be a JSON object string, e.g. \'{"billing":"payments","technical":"bugs"}\'');
  }
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, string | null>;
  throw new Error("criteria must be a JSON object or object");
}

function parseState(input: unknown): string | object {
  if (typeof input === "string") {
    if (input.length > MAX_STATE_CHARS) {
      // client will smart-truncate with marker; we just warn early
    }
    const trimmed = input.trim();
    if (!trimmed) throw new Error("state must be a non-empty string");
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < MAX_STATE_CHARS) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return input;
      }
    }
    return input;
  }
  if (input && typeof input === "object") return input as object;
  throw new Error("state must be a string or JSON-serializable object");
}

function truncateForLog(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export const OpenJevPlugin: Plugin = async ({ client, directory, worktree }) => {
  const extraEnvPaths = [directory, worktree]
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .map((d) => `${d}/.env`);
  const dotenv = loadDotEnv(extraEnvPaths);
  const { backend } = resolveBackend();
  await client.app.log({
    body: {
      service: "openjev",
      level: "info",
      message:
        `OpenJev plugin initialized — backend=${backend}, .env files=${dotenv.loaded.length}, keys applied=${dotenv.applied.join(",") || "none"} ` +
        "(typed decisions: Choice/Noul/Score) — audit+gate enabled, state truncated at 60k, low-conf escalation at 0.75",
    },
  });

  return {
    tool: {
      jev_choice: tool({
        description:
          "Typed Choice decision via Jev/OpenJev (System One). Use instead of LLM text generation when the answer is one of a bounded set. Returns {choice, probabilities, confidence, gated} with calibrated probabilities and no hallucination. Gate: auto if conf>=0.75 else escalate to LLM/human for rationale. Use for routing, classification, triage.",
        args: {
          state: tool.schema.string().describe("Application state to decide on — ticket, transcript, file diff, or JSON. Can be string or JSON string."),
          instructions: tool.schema.string().describe("What to decide. One well-scoped question, e.g. 'Route this ticket to the correct team'"),
          criteria: tool.schema
            .string()
            .describe('JSON object mapping option -> description. Example: \'{"billing":"payments","technical":"bugs","spam":"irrelevant"}\''),
          model: tool.schema.string().optional().describe("Override model, default jev-latest (or mock when no key)"),
        },
        async execute(args) {
          const t0 = Date.now();
          try {
            const state = parseState(args.state);
            const criteria = parseChoiceCriteria(args.criteria);
            if (Object.keys(criteria).length < 2) throw new Error("choice criteria requires at least 2 options");
            const warnings = lintChoiceCriteria(criteria);
            if (warnings.length) await client.app.log({ body: { service: "openjev", level: "warn", message: `jev_choice criteria lint: ${warnings.join(" | ")}` } });
            const stateStrForWarn = typeof args.state === "string" ? args.state : JSON.stringify(args.state);
            if (stateStrForWarn.length > MAX_STATE_CHARS)
              await client.app.log({ body: { service: "openjev", level: "warn", message: `state ${stateStrForWarn.length} chars > ${MAX_STATE_CHARS} — will be head+tail truncated with marker` } });
            const instructions = args.instructions.trim();
            if (!instructions) throw new Error("instructions must be a non-empty string");
            const questions: Questions = { q: { type: "choice", instructions, criteria } };
            const res = await decide(state, questions, { model: args.model?.trim() || undefined });
            const ans = res.answers.q as import("./client.js").ChoiceAnswer;
            const gated = gateChoice(ans.confidence);
            const backend = resolveBackend({ model: args.model?.trim() || undefined }).backend;
            const entry = toAuditEntry({
              tool: "jev_choice",
              model: res.model,
              backend,
              state: state as string | object,
              questions,
              answers: res.answers,
              latencyMs: Date.now() - t0,
              usage: res.usage,
              gated: { q: gated },
            });
            await client.app.log({ body: { service: "openjev", level: gated.action === "auto" ? "info" : "warn", message: auditLogLine(entry) } });
            return JSON.stringify(
              { model: res.model, choice: ans.choice, probabilities: ans.probabilities, confidence: ans.confidence, gated, warnings: warnings.length ? warnings : undefined, usage: res.usage },
              null,
              2
            );
          } catch (e) {
            const msg = (e as Error).message;
            await client.app.log({ body: { service: "openjev", level: "error", message: `jev_choice failed: ${truncateForLog(msg)}` } });
            throw new Error(msg);
          }
        },
      }),

      jev_noul: tool({
        description:
          "Typed Noul (yes/no) decision via Jev/OpenJev. Returns probability 0..1 (noul). Use instead of LLM text for guardrails, approvals, escalation checks. Calibrated: higher confidence corresponds to higher accuracy. Gate: auto if max(noul,1-noul)>=0.75 else escalate.",
        args: {
          state: tool.schema.string().describe("State to evaluate"),
          instructions: tool.schema.string().describe("Yes/no question, e.g. 'Does this diff introduce a breaking change?' or 'Is this request urgent?'"),
          true_desc: tool.schema.string().optional().describe("What yes (noul near 1) means"),
          false_desc: tool.schema.string().optional().describe("What no (noul near 0) means"),
          model: tool.schema.string().optional().describe("Override model"),
        },
        async execute(args) {
          const t0 = Date.now();
          try {
            const state = parseState(args.state);
            const instructions = args.instructions.trim();
            if (!instructions) throw new Error("instructions must be a non-empty string");
            const questions: Questions = {
              q: {
                type: "noul",
                instructions,
                criteria:
                  args.true_desc || args.false_desc ? { true: args.true_desc ?? undefined, false: args.false_desc ?? undefined } : undefined,
              },
            };
            const res = await decide(state, questions, { model: args.model?.trim() || undefined });
            const ans = res.answers.q as import("./client.js").NoulAnswer;
            const confidence = Math.max(ans.noul, 1 - ans.noul);
            const gated = gateNoul(ans.noul);
            const backend = resolveBackend({ model: args.model?.trim() || undefined }).backend;
            const entry = toAuditEntry({
              tool: "jev_noul",
              model: res.model,
              backend,
              state: state as string | object,
              questions,
              answers: res.answers,
              latencyMs: Date.now() - t0,
              usage: res.usage,
              gated: { q: gated },
            });
            await client.app.log({ body: { service: "openjev", level: gated.action === "auto" ? "info" : "warn", message: auditLogLine(entry) } });
            return JSON.stringify({ model: res.model, noul: ans.noul, is_yes: ans.noul > 0.5, confidence, gated, usage: res.usage }, null, 2);
          } catch (e) {
            const msg = (e as Error).message;
            await client.app.log({ body: { service: "openjev", level: "error", message: `jev_noul failed: ${truncateForLog(msg)}` } });
            throw new Error(msg);
          }
        },
      }),

      jev_score: tool({
        description:
          "Typed Score via Jev/OpenJev. Rates state on an ordered rubric. Returns {score (weighted avg across levels), probabilities, confidence, legend, gated}. Use for urgency, quality, risk scoring. Gate: auto if conf>=0.65 else escalate.",
        args: {
          state: tool.schema.string().describe("State to score"),
          instructions: tool.schema.string().describe("What to rate, e.g. 'Score urgency from low to critical'"),
          criteria: tool.schema.string().describe('JSON array of ordered level descriptions, lowest first. Example: \'["low","medium","high","critical"]\''),
          model: tool.schema.string().optional().describe("Override model"),
        },
        async execute(args) {
          const t0 = Date.now();
          try {
            const state = parseState(args.state);
            const instructions = args.instructions.trim();
            if (!instructions) throw new Error("instructions must be a non-empty string");
            let levels: string[];
            try {
              levels = JSON.parse(args.criteria);
            } catch {
              throw new Error('criteria must be a JSON array string, e.g. \'["low","medium","high"]\'');
            }
            if (!Array.isArray(levels) || levels.length < 2) throw new Error("criteria must be an array with at least 2 levels");
            if (levels.length > 16) throw new Error("score supports at most 16 levels");
            for (const lvl of levels) if (typeof lvl !== "string" || !lvl.trim()) throw new Error("score levels must be non-empty strings");
            const w = lintScoreLevels(levels);
            if (w.length) await client.app.log({ body: { service: "openjev", level: "warn", message: `jev_score lint: ${w.join(" | ")}` } });
            const questions: Questions = { q: { type: "score", instructions, criteria: levels } };
            const res = await decide(state, questions, { model: args.model?.trim() || undefined });
            const ans = res.answers.q as import("./client.js").ScoreAnswer;
            const gated = gateScore(ans.confidence);
            const backend = resolveBackend({ model: args.model?.trim() || undefined }).backend;
            const entry = toAuditEntry({
              tool: "jev_score",
              model: res.model,
              backend,
              state: state as string | object,
              questions,
              answers: res.answers,
              latencyMs: Date.now() - t0,
              usage: res.usage,
              gated: { q: gated },
            });
            await client.app.log({ body: { service: "openjev", level: gated.action === "auto" ? "info" : "warn", message: auditLogLine(entry) } });
            return JSON.stringify(
              { model: res.model, score: ans.score, probabilities: ans.probabilities, confidence: ans.confidence, legend: ans.legend, gated, warnings: w.length ? w : undefined, usage: res.usage },
              null,
              2
            );
          } catch (e) {
            const msg = (e as Error).message;
            await client.app.log({ body: { service: "openjev", level: "error", message: `jev_score failed: ${truncateForLog(msg)}` } });
            throw new Error(msg);
          }
        },
      }),

      jev_ask: tool({
        description:
          "Generic parallel Jev/OpenJev call. Send state + map of typed questions (choice/noul/score) and get calibrated answers in one 70-500ms round-trip. All questions evaluated in parallel, no context rot. Prefer this when you need multiple typed decisions at once. Each answer includes gated action.",
        args: {
          state: tool.schema.string().describe("State (string or JSON string) to evaluate"),
          questions: tool.schema.string().describe(
            'JSON object mapping id -> Question. Each Question: {type:"choice"|"noul"|"score", instructions:string, criteria:object|array}. Example: \'{"route":{"type":"choice","instructions":"Pick team","criteria":{"billing":"...","tech":"..."}},"is_urgent":{"type":"noul","instructions":"Is urgent?"}}\''
          ),
          model: tool.schema.string().optional().describe("Override model"),
        },
        async execute(args) {
          const t0 = Date.now();
          try {
            const state = parseState(args.state);
            let questions: Questions;
            try {
              questions = JSON.parse(args.questions);
            } catch (e) {
              throw new Error(`questions must be valid JSON: ${(e as Error).message}`);
            }
            // lint all choice/score in the map
            for (const [id, q] of Object.entries(questions)) {
              if (q.type === "choice") {
                const w = lintChoiceCriteria((q as import("./client.js").ChoiceQuestion).criteria);
                if (w.length) await client.app.log({ body: { service: "openjev", level: "warn", message: `jev_ask ${id} lint: ${w.join(" | ")}` } });
              }
            }
            const res = await decide(state, questions, { model: args.model?.trim() || undefined });
            const gated: Record<string, { action: "auto" | "escalate"; reason: string }> = {};
            for (const [id, ans] of Object.entries(res.answers as Record<string, import("./client.js").Answer>)) {
              gated[id] = gateAnswer(ans as unknown as { type: string; confidence?: number; noul?: number });
            }
            const backend = resolveBackend({ model: args.model?.trim() || undefined }).backend;
            const entry = toAuditEntry({
              tool: "jev_ask",
              model: res.model,
              backend,
              state: state as string | object,
              questions,
              answers: res.answers,
              latencyMs: Date.now() - t0,
              usage: res.usage,
              gated,
            });
            const anyEscalate = Object.values(gated).some((g) => g.action === "escalate");
            await client.app.log({ body: { service: "openjev", level: anyEscalate ? "warn" : "info", message: auditLogLine(entry) } });
            return JSON.stringify({ ...res, gated }, null, 2);
          } catch (e) {
            const msg = (e as Error).message;
            await client.app.log({ body: { service: "openjev", level: "error", message: `jev_ask failed: ${truncateForLog(msg)}` } });
            throw new Error(msg);
          }
        },
      }),

      jev_doctor: tool({
        description: "Check Jev/OpenJev wiring: backend, auth, and a smoke decision. No state needed. Use to verify TYPESAFE_API_KEY / JEV_BACKEND=mock.",
        args: {
          probe_state: tool.schema.string().optional().describe("Optional custom probe state"),
        },
        async execute(args) {
          const probe = args.probe_state?.trim() || "Help! My payouts have been failing for 3 days.";
          const questions: Questions = {
            is_urgent: { type: "noul", instructions: "Does this convey urgency?" },
            team: { type: "choice", instructions: "Route to team", criteria: { billing: "payments/invoices", technical: "bugs/outages", sales: "buying", spam: "irrelevant" } },
          };
          try {
            const res = await decide(probe, questions);
            return JSON.stringify({ ok: true, model: res.model, answers: res.answers, usage: res.usage }, null, 2);
          } catch (e) {
            return JSON.stringify({ ok: false, error: (e as Error).message }, null, 2);
          }
        },
      }),
    },
  };
};

export default OpenJevPlugin;
export const OpenJev = OpenJevPlugin;
export const Jev = OpenJevPlugin;
