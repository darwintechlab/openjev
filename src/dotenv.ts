/**
 * Minimal zero-dependency .env loader.
 *
 * opencode does NOT load `.env` into `process.env` (see opencode issues #10458 / #21187),
 * so the plugin reads project `.env` itself. Existing OS/shell variables always win —
 * we only fill keys that are unset, so an explicit `export TYPESAFE_API_KEY=…` still overrides.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let loadedPaths: string[] | undefined;
const appliedKeys = new Set<string>();

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

export type DotEnvResult = { loaded: string[]; applied: string[] };

/**
 * Load `.env` files into `process.env` (idempotent). Search order:
 *   1. `JEV_ENV_FILE` (explicit path)
 *   2. `process.cwd()/.env`
 *   3. `process.cwd()/.opencode/.env`
 *   4. any `extraPaths` (e.g. plugin `directory` / `worktree`)
 * Values already present in `process.env` are never overwritten.
 */
export function loadDotEnv(extraPaths: string[] = []): DotEnvResult {
  if (loadedPaths) return { loaded: loadedPaths, applied: [...appliedKeys] };
  loadedPaths = [];
  const candidates = [
    process.env.JEV_ENV_FILE,
    join(process.cwd(), ".env"),
    join(process.cwd(), ".opencode", ".env"),
    ...extraPaths,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  const seen = new Set<string>();
  for (const path of candidates) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    loadedPaths.push(path);
    for (const [key, value] of Object.entries(parseEnv(text))) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
        appliedKeys.add(key);
      }
    }
  }
  return { loaded: loadedPaths, applied: [...appliedKeys] };
}

/** Paths that were successfully read (empty until `loadDotEnv` runs). */
export function dotEnvPaths(): string[] {
  return loadedPaths ?? [];
}
