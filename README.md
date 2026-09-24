# opencode-openjev

Typed decisions for the Opencode harness via **Jev (System One)** or an **OpenJev**-compatible endpoint — `Choice` / `Noul` / `Score` with calibrated probabilities, not text generation.

> Jev = generic classifier you never have to train. 70–500 ms, `$0.042 / M` input (output free), 0 % hallucination / type errors. Use it where the harness currently does `prompt → text → parse JSON` for a bounded decision.

* **Status:** ready for review as an Opencode ecosystem plugin
* **License:** MIT
* **Node:** `>=20`
* **Opencode:** `>=1.18`
* **Setup:** **[SETUP.md](./SETUP.md)** — 5-minute install (npm or file plugin, env, verify)

---

## Why this exists

Opencode's harness makes many **typed decisions** today with text generation: which skill/tool to route to, which model tier to use, whether a `bash`/`edit` should require approval, whether to compact a session, what verdict to return on a PR. Those are `Choice`/`Noul`/`Score` problems — bounded answers with probabilities you can branch on.

This plugin gives the harness five typed tools that return probabilities directly, with retries, validation, and a mock fallback so CI never needs a key.

## Plugin vs Skill

| Artifact | What it is | Distribution |
|---|---|---|
| **Plugin** (`opencode-openjev`) | JS/TS module that registers tools + handles auth/retries | `npm` package, `opencode.json: { "plugin": ["opencode-openjev"] }` → auto `bun install` from `~/.cache/opencode/node_modules/` |
| **Skill** (`openjev`) | Markdown prompt guidance (`SKILL.md`) that makes the agent default to the typed tools | `skill/openjev/SKILL.md` — register via `skills.paths` or a skills catalog |

**The plugin works with zero skill** — tools are advertised automatically via `tool()`. The bundled `openjev` skill is optional prompt guidance that makes the agent reach for `jev_*` by default for bounded decisions (routing, guardrails, approvals, scoring) instead of generating text.

---

## Tools

| Tool | Primitive | Returns (JSON string) |
|---|---|---|
| `jev_choice` | Choice | `{model, choice, probabilities, confidence, usage}` |
| `jev_noul` | Noul | `{model, noul:0..1, is_yes, confidence, usage}` |
| `jev_score` | Score | `{model, score, probabilities, confidence, legend, usage}` |
| `jev_ask` | parallel (any mix) | `{model, answers:{id->Answer}, usage}` |
| `jev_doctor` | smoke test | `{ok, model, answers, usage}` or `{ok:false, error}` |

All questions in a single `jev_ask` are evaluated **in parallel** on the same `state` — adding questions barely changes latency and does not cause context rot.

---

## Install

### As an npm plugin (recommended)

```json
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-openjev"]
}
```

```bash
npm i opencode-openjev   # or pnpm/bun add opencode-openjev
# opencode installs it at startup via Bun
```

### Local development

```bash
git clone https://github.com/anomalyco/opencode-openjev.git
cd opencode-openjev
npm install
npm run build
npm test

# live-load into this repo's harness (no npm publish needed)
mkdir -p .opencode/plugins
# handled automatically: .opencode/plugins/openjev.ts re-exports dist/
```

### Enable the bundled skill (optional)

`skill/openjev/SKILL.md` ships with the package and makes the agent default to
`jev_*` for bounded decisions. Register it in `opencode.json` — relative paths
resolve against the project directory — then restart opencode:

```json
{ "$schema": "https://opencode.ai/config.json", "skills": { "paths": ["openjev/skill"] } }
```

For a global install, copy the folder to `~/.config/opencode/skills/openjev/`.

---

## Configuration

All backends are selected via environment variables — same convention as `jev-use` and the TypeSafe SDK.

| Backend | Env | Endpoint |
|---|---|---|
| `typesafe` (default if key present) | `TYPESAFE_API_KEY=ts_...` | `https://api.typesafe.ai/v1/systemone` |
| `openrouter` | `OPENROUTER_API_KEY=…` | `https://openrouter.ai/api/v1/systemone` |
| `gateway` (Vercel AI Gateway) | `AI_GATEWAY_API_KEY=…` | `https://ai-gateway.vercel.sh/v1/systemone` |
| `custom` (self-hosted OpenJev) | `JEV_BASE_URL=…` + `JEV_API_KEY=…` | your URL |
| `mock` | `JEV_BACKEND=mock` | local deterministic, no network |
| `openjev-local` | `JEV_BACKEND=openjev-local` | hook for local calibrated LLM (currently falls back to `mock`) |

Optional overrides: `JEV_MODEL` (default `jev-latest`), `JEV_BASE_URL`, `JEV_BACKEND`.

> **`.env` is auto-loaded.** opencode does not load `.env` into `process.env` itself (issues #10458 / #21187), so the plugin reads it at startup from, in order: `JEV_ENV_FILE`, `./.env`, `./.opencode/.env`, then the plugin's project dir. Existing shell/OS variables always win, so `export TYPESAFE_API_KEY=…` still overrides the file. Restart opencode after editing `.env`.


**Verify wiring in the Opencode TUI:**

```
jev_doctor
jev_doctor { "probe_state": "my ticket text" }
```

**Do not send secrets or unrelated private data as `state`** — see Security below.

---

## Usage

### Single decision

```json
// tool: jev_choice
{
  "state": "Help! payouts failing 3 days — order #48281",
  "instructions": "Route to team",
  "criteria": "{\"billing\":\"payments/invoices\",\"technical\":\"bugs/outages\",\"sales\":\"buying\",\"spam\":\"irrelevant\"}"
}
// → {"choice":"technical","probabilities":{"technical":0.82,…},"confidence":0.82,"model":"jev-latest"}
```

### Confidence gating (recommended)

```ts
const { choice, confidence } = JSON.parse(await jev_choice({ ... }));
if (confidence < 0.75) {
  // escalate to a slower LLM for rationale, or to a human `ask`
} else {
  route(choice);
}
```

Jev's numbers are **calibrated** (RLCD training) — higher confidence actually means higher accuracy. Standard LLMs are not.

### Parallel decisions (one round-trip)

```json
// tool: jev_ask
{
  "state": "{\"ticket\":\"payouts failing\",\"diff\":\"...\"}",
  "questions": "{\"team\":{\"type\":\"choice\",\"instructions\":\"Pick team\",\"criteria\":{\"billing\":\"...\",\"tech\":\"...\"}},\"is_urgent\":{\"type\":\"noul\",\"instructions\":\"Is urgent?\"},\"severity\":{\"type\":\"score\",\"instructions\":\"Score severity\",\"criteria\":[\"low\",\"medium\",\"high\",\"critical\"]}}"
}
```

### Direct Node.js (without Opencode)

```ts
import { decide } from "opencode-openjev";
const res = await decide("Help! payouts failing", {
  team: { type: "choice", instructions: "Route", criteria: { billing: "pay", technical: "bug" } },
  is_urgent: { type: "noul", instructions: "Is urgent?" },
});
```

See `examples/demo.mjs` and `examples/harness-acceleration.md`.

---

## Where this replaces text generation in the harness

* **Routing** skill/tool (`opencode-prompt-router` TF-IDF → `jev_choice`)
* **Model-tier routing** (`jev-router` via `chat.params` → `jev_choice` + `jev_noul`)
* **`permission.ask` gating** (`bash: rm *`, `.env` read → `jev_noul` “is destructive?”)
* **Session compaction** quality scoring (`session.compacted` → `jev_score`)
* **Triage / QA verdicts** → `jev_choice` {approve, request_changes, block} + confidence

---

## Development

```bash
npm run build      # tsc → dist/
npm run typecheck  # tsc --noEmit
npm test           # node --test (mock backend, no key needed)
JEV_BACKEND=mock npm test
npm run bench:eval # decision-quality eval (accuracy/Brier/ECE/risk-coverage + optional LLM baseline)
node examples/demo.mjs
opencode debug config --print-logs  # should show "OpenJev plugin initialized"
```

### Project layout

```
src/
  client.ts   # backend resolution, validation, retries, mock, decide()
  dotenv.ts   # zero-dep .env loader (opencode does not load .env itself)
  plugin.ts   # opencode plugin (5 tools, input parsing, logging)
index.ts      # public entry
skill/
  openjev/SKILL.md   # optional: makes the agent default to jev_* tools
test/
  client.test.mjs
  plugin.test.mjs
  dotenv.test.mjs
  dotenv-missing.test.mjs
  metrics.test.mjs
bench/
  eval.mjs        # decision-quality eval (accuracy/calibration/risk-coverage)
  metrics.mjs     # pure metric functions (Brier, ECE, risk-coverage, Wilson)
  families.mjs    # decision family definitions
  dataset.jsonl   # labeled seed cases (replace with real held-out data)
examples/
  demo.mjs
  harness-acceleration.md
```

### Error handling

* Input validation before network (`state` 0–60k chars, 1–32 questions, per-type criteria limits).
* Retries with exponential backoff + jitter for `429` / `529` / `5xx` and timeouts (per `docs.typesafe.ai/api`).
* Auth via `Authorization: Bearer …`; errors do not log the URL or key, only `backend`.
* Mock backend is deterministic (FNV + softmax) so CI is reproducible without a key.

---

## Security

* Never send passwords, API keys, or unrelated private data as `state` (`docs.typesafe.ai` guidance — keep irreversible actions behind your own human approval).
* `state` is the content to decide on; `questions` are the Typed schema you define upfront — there is no free-form generation to leak data.

---

## Contributing

PRs welcome — please add a test for new question types or backends. Run `npm run typecheck && npm test` before pushing.

## License

MIT — see `LICENSE`.

## Ecosystem

To propose this for `opencode.ai/docs/ecosystem`, ensure `npm publish --dry-run` is clean and `opencode plugin` can install it:

```bash
npm pack --dry-run
opencode plugin opencode-openjev  # adds to opencode.json and bun-installs
```
