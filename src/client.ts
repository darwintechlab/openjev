/**
 * Jev / OpenJev client
 * Spec: docs.typesafe.ai/api — POST {model, state, questions} -> {model, answers, usage}
 * Endpoint: https://api.typesafe.ai/v1/systemone (primary), gateways via baseURL override
 * Context limits: ~64k total (32k state + longest question) per llmreference; we enforce 60k char soft cap.
 */

import { loadDotEnv } from "./dotenv.js";

export type Backend = "typesafe" | "openrouter" | "gateway" | "custom" | "mock" | "openjev-local";

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
};

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
};

export type ScoreQuestion = {
  type: "score";
  instructions: string;
  criteria: string[];
};

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type NoulAnswer = { type: "noul"; noul: number };
export type ScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};
export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export type JevResponse = {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export type ClientOptions = {
  backend?: Backend;
  apiKey?: string;
  baseURL?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

// ---- env helper ----
function env(name: string): string | undefined {
  try {
    const fromGlobal = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env?.[name];
    if (fromGlobal !== undefined) return fromGlobal;
    if (typeof process !== "undefined" && (process as unknown as { env?: Record<string, string> }).env) {
      return (process as unknown as { env: Record<string, string> }).env[name];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ---- constants ----
export const DEFAULT_MODEL = "jev-latest";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_RETRIES = 2;
export const MAX_STATE_CHARS = 60_000;
export const MAX_QUESTIONS = 32;

const BACKEND_URLS: Record<Exclude<Backend, "mock" | "openjev-local" | "custom">, string> = {
  typesafe: "https://api.typesafe.ai/v1/systemone",
  openrouter: "https://openrouter.ai/api/v1/systemone",
  gateway: "https://ai-gateway.vercel.sh/v1/systemone",
};

export function resolveBackend(opts: ClientOptions = {}): {
  backend: Backend;
  apiKey?: string;
  baseURL: string;
  model: string;
} {
  loadDotEnv();
  const model = (opts.model ?? env("JEV_MODEL") ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;

  // Explicit backend wins — honour baseURL/apiKey overrides per backend type
  const explicit = (opts.backend ?? (env("JEV_BACKEND") as Backend | undefined))?.trim() as Backend | undefined;
  if (explicit) {
    const baseURL = resolveBaseURL(explicit, opts.baseURL);
    return { backend: explicit, apiKey: opts.apiKey ?? resolveKeyForBackend(explicit), baseURL, model };
  }

  // Auto-detect: prefer real backends if keys present, else mock
  if (env("TYPESAFE_API_KEY")) {
    return { backend: "typesafe", apiKey: env("TYPESAFE_API_KEY"), baseURL: BACKEND_URLS.typesafe, model };
  }
  if (env("OPENROUTER_API_KEY")) {
    return { backend: "openrouter", apiKey: env("OPENROUTER_API_KEY"), baseURL: BACKEND_URLS.openrouter, model };
  }
  if (env("AI_GATEWAY_API_KEY")) {
    return { backend: "gateway", apiKey: env("AI_GATEWAY_API_KEY"), baseURL: opts.baseURL ?? BACKEND_URLS.gateway, model };
  }
  if (env("JEV_BASE_URL")) {
    return {
      backend: "custom",
      apiKey: opts.apiKey ?? env("JEV_API_KEY") ?? env("TYPESAFE_API_KEY"),
      baseURL: env("JEV_BASE_URL")!,
      model,
    };
  }
  return { backend: "mock", apiKey: undefined, baseURL: "mock", model };
}

function resolveBaseURL(backend: Backend, override?: string): string {
  if (override) return override;
  const envURL = env("JEV_BASE_URL");
  if (envURL && backend === "custom") return envURL;
  if (backend in BACKEND_URLS) return BACKEND_URLS[backend as keyof typeof BACKEND_URLS];
  if (backend === "custom") return envURL ?? "https://api.typesafe.ai/v1/systemone";
  return "mock";
}

function resolveKeyForBackend(backend: Backend): string | undefined {
  switch (backend) {
    case "typesafe":
      return env("TYPESAFE_API_KEY");
    case "openrouter":
      return env("OPENROUTER_API_KEY");
    case "gateway":
      return env("AI_GATEWAY_API_KEY");
    case "custom":
      return env("JEV_API_KEY") ?? env("TYPESAFE_API_KEY");
    default:
      return undefined;
  }
}

export function resolveAuth(
  backend: Backend,
  baseURL: string,
  apiKey?: string
): { url: string; headers: Record<string, string> } {
  const key = apiKey ?? resolveKeyForBackend(backend) ?? env("JEV_API_KEY") ?? env("TYPESAFE_API_KEY") ?? env("OPENROUTER_API_KEY") ?? env("AI_GATEWAY_API_KEY");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  return { url: baseURL, headers };
}

// ---- validation ----
export function validateQuestions(questions: Questions): void {
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new Error("questions: at least one question required");
  if (ids.length > MAX_QUESTIONS) throw new Error(`questions: at most ${MAX_QUESTIONS} questions per call (got ${ids.length})`);
  for (const [id, q] of Object.entries(questions)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(id)) throw new Error(`question id "${id}" must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`);
    if (!q || typeof q !== "object") throw new Error(`question "${id}": invalid shape`);
    if (typeof q.instructions !== "string" || !q.instructions.trim()) throw new Error(`question "${id}": instructions must be a non-empty string`);
    if (q.instructions.length > 4000) throw new Error(`question "${id}": instructions too long (max 4000 chars)`);
    switch (q.type) {
      case "choice": {
        const c = (q as ChoiceQuestion).criteria;
        if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error(`question "${id}": choice criteria must be an object`);
        const opts = Object.keys(c);
        if (opts.length < 2) throw new Error(`question "${id}": choice requires at least 2 options`);
        if (opts.length > 32) throw new Error(`question "${id}": choice supports at most 32 options`);
        for (const k of opts) if (!k.trim()) throw new Error(`question "${id}": option keys must be non-empty`);
        break;
      }
      case "noul":
        break;
      case "score": {
        const c = (q as ScoreQuestion).criteria;
        if (!Array.isArray(c) || c.length < 2) throw new Error(`question "${id}": score criteria must be an array with at least 2 levels`);
        if (c.length > 16) throw new Error(`question "${id}": score supports at most 16 levels`);
        for (const lvl of c) if (typeof lvl !== "string" || !lvl.trim()) throw new Error(`question "${id}": score levels must be non-empty strings`);
        break;
      }
      default:
        throw new Error(`question "${id}": unknown type "${(q as { type: string }).type}"`);
    }
  }
}

import { smartTruncate } from "./state.js";

function validateState(state: string | object | unknown[]): string {
  const asString = typeof state === "string" ? state : JSON.stringify(state);
  if (!asString.trim()) throw new Error("state must be a non-empty string or object");
  if (asString.length > MAX_STATE_CHARS) {
    const { text, origChars } = smartTruncate(asString);
    // Preserve safety: truncate with marker instead of hard error, but surface warning via error message prefix
    // Caller (plugin) will log truncated warning; we return truncated text to stay within Jev limits
    // If still too large (should not), throw
    if (text.length > MAX_STATE_CHARS) throw new Error(`state too large (${origChars} chars, max ${MAX_STATE_CHARS}). Trim context, summarize, or split questions.`);
    return text;
  }
  return asString;
}

export function wasStateTruncated(original: string | object | unknown[], validated: string): boolean {
  const orig = typeof original === "string" ? original : JSON.stringify(original);
  return orig.length !== validated.length;
}

// ---- mock ----
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}
function softmax(logits: number[]): number[] {
  const m = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - m));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / sum);
}
export function mockAnswer(state: string, questions: Questions): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  const stateStr = typeof state === "string" ? state : JSON.stringify(state);
  for (const [qid, q] of Object.entries(questions)) {
    const seedBase = `${stateStr}::${qid}::${q.instructions}`;
    if (q.type === "choice") {
      const opts = Object.keys(q.criteria);
      const logits = opts.map((opt) => hash01(`${seedBase}::${opt}`) * 2 - 0.5);
      const probs = softmax(logits);
      const maxIdx = probs.indexOf(Math.max(...probs));
      const probabilities: Record<string, number> = {};
      opts.forEach((opt, i) => {
        probabilities[opt] = probs[i]!;
      });
      out[qid] = { type: "choice", choice: opts[maxIdx]!, probabilities, confidence: Math.max(...probs) };
    } else if (q.type === "noul") {
      const v = hash01(seedBase);
      out[qid] = { type: "noul", noul: 0.05 + v * 0.9 };
    } else if (q.type === "score") {
      const levels = q.criteria;
      const logits = levels.map((_, i) => hash01(`${seedBase}::${i}`));
      const probs = softmax(logits.map((v) => v * 3));
      const score = probs.reduce((acc, p, i) => acc + p * i, 0);
      const legend: Record<string, string> = {};
      levels.forEach((desc, i) => {
        legend[String(i)] = desc;
      });
      const probabilities: Record<string, number> = {};
      probs.forEach((p, i) => {
        probabilities[String(i)] = p;
      });
      out[qid] = { type: "score", score, legend, probabilities, confidence: Math.max(...probs) };
    }
  }
  return out;
}

// ---- retry helper ----
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 529 || (status >= 500 && status < 600);
}

// ---- main ----
export async function decide(
  state: string | object | unknown[],
  questions: Questions,
  opts: ClientOptions = {}
): Promise<JevResponse> {
  validateQuestions(questions);
  const stateStr = validateState(state);

  const { backend, apiKey, baseURL, model } = resolveBackend(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  if (backend === "mock" || backend === "openjev-local") {
    return {
      model: backend === "mock" ? "mock" : "openjev-local(mock)",
      answers: mockAnswer(stateStr, questions),
      usage: { input_tokens: stateStr.length, output_tokens: 0 },
    };
  }

  const { url, headers } = resolveAuth(backend, baseURL, apiKey);
  const body = JSON.stringify({ model, state: typeof state === "string" ? state : state, questions });

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: "POST", headers, body, signal: ac.signal });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`Jev API ${res.status} ${res.statusText}: ${text.slice(0, 800)}`);
        // do not leak URL with key; log backend only
        (err as Error & { status?: number }).status = res.status;
        if (isRetryableStatus(res.status) && attempt < maxRetries) {
          const backoff = 250 * 2 ** attempt + Math.random() * 150;
          await sleep(backoff);
          lastErr = err;
          continue;
        }
        throw err;
      }

      const json = (await res.json()) as JevResponse;
      if (!json || typeof json !== "object" || !json.answers) throw new Error("Jev API: invalid response shape (missing answers)");
      return json;
    } catch (e) {
      const err = e as Error & { name?: string; status?: number };
      const isAbort = err.name === "AbortError";
      if (isAbort) {
        const abortErr = new Error(`Jev API timeout after ${timeoutMs}ms (backend=${backend})`);
        if (attempt < maxRetries) {
          lastErr = abortErr;
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw abortErr;
      }
      if (err.status !== undefined && isRetryableStatus(err.status) && attempt < maxRetries) {
        lastErr = err;
        await sleep(250 * 2 ** attempt);
        continue;
      }
      // network errors are retryable once
      if (attempt < maxRetries && !err.status) {
        lastErr = err;
        await sleep(250 * 2 ** attempt);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr ?? new Error("Jev API: unknown error after retries");
}
