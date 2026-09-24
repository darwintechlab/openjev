# Setup — opencode-openjev (5 minutes)

This guide gets you from clone to live Jev decisions in Opencode. The same 5 tools (`jev_choice`/`jev_noul`/`jev_score`/`jev_ask`/`jev_doctor`) work in mock (CI, no key) and live (hosted).

## 1. Prerequisites

* **Node >=20**, **npm** (or `pnpm`/`bun`)
* **Opencode >=1.18** — `opencode --version` → `1.18.x`
* **API key** (live) — get it free at **https://console.typesafe.ai** → Create key `ts_…`. Keep it out of git.

> No key yet? Skip to step 4 — `JEV_BACKEND=mock` works for local dev and CI.

## 2. Get your key

1. Open https://console.typesafe.ai → Sign in → **API keys** → **Create**.
2. Copy the `ts_…` value.
3. Add it to your shell **(not in repo)**:

```bash
# macOS / zsh — persist
echo 'export TYPESAFE_API_KEY=ts_…' >> ~/.zshrc
source ~/.zshrc

# or one-off for this shell
export TYPESAFE_API_KEY=ts_…
```

Alternative gateways (no code change):
* OpenRouter — `export OPENROUTER_API_KEY=…`
* Vercel AI Gateway — `export AI_GATEWAY_API_KEY=…`
* Self-hosted OpenJev — `export JEV_BASE_URL=https://your-host/v1/systemone JEV_API_KEY=…`

`JEV_MODEL` overrides the model (`jev-latest` → `jev-1.13.0`).

## 3. Install the plugin (one line — npm)

```bash
# in your Opencode project (where opencode.json lives)
opencode plugin add opencode-openjev
# or manually: npm i opencode-openjev
# and ensure opencode.json:
# { "$schema":"https://opencode.ai/config.json", "plugin":["opencode-openjev"] }
```

Opencode installs via **Bun** to `~/.cache/opencode/node_modules/` at next startup. No other step.

Verify (inside Opencode TUI or headless):

```
jev_doctor
# live → {ok:true, model:"jev-1.13.0", answers:{team:{choice:"billing", confidence:0.94}}}
# no key → {ok:true, model:"mock", …} or {ok:false, error:"TYPESAFE_API_KEY is required…"} for live-only builds
```

Headless check:

```bash
opencode debug config --print-logs 2>&1 | grep OpenJev
# → OpenJev plugin initialized … audit+gate enabled …
```

## 4. Local development / mock (no key, no network)

```bash
git clone https://github.com/anomalyco/opencode-openjev.git
cd opencode-openjev
npm install
npm run build
npm test          # 34 pass, mock backend — no key needed

# live-load without publishing (file plugin)
mkdir -p .opencode/plugins
cat > .opencode/plugins/openjev.ts <<'TS'
export { OpenJevPlugin, OpenJev, Jev } from "../../dist/src/plugin.js";
export { OpenJevPlugin as default } from "../../dist/src/plugin.js";
TS
opencode debug config --print-logs | grep OpenJev
```

## 5. Configure (env vs .env)

**Recommended — env vars** (always win, not committed):

```bash
export TYPESAFE_API_KEY=ts_…
export JEV_MODEL=jev-latest
```

**File — `.env` (auto-loaded, gitignored)** — the plugin reads, in order: `$JEV_ENV_FILE`, `./.env`, `./.opencode/.env`, then project dir. Restart Opencode after editing `.env` (Opencode does not hot-reload env).

```bash
cp .env.example .env
# edit .env → TYPESAFE_API_KEY=ts_…
```

Check precedence: `JEV_ENV_FILE=.env.local opencode …`.

## 6. First decision (copy-paste in Opencode TUI)

```
jev_choice { "state":"Help! payouts failing 3 days — order #48281", "instructions":"Route to team", "criteria":"{\"billing\":\"payments/invoices\",\"technical\":\"bugs/outages\",\"sales\":\"buying\",\"spam\":\"irrelevant\"}" }
# → {choice:"billing", confidence:0.99, gated:{action:"auto"}, usage:{input_tokens:398}}
```

Low-confidence example (escalate):

```
jev_choice { "state":"Please help", "instructions":"Route to team", "criteria":"{\"billing\":\"pay\",\"technical\":\"bug\",\"sales\":\"buy\",\"spam\":\"junk\"}" }
# → {choice:"technical", confidence:0.38, gated:{action:"escalate", reason:"conf 0.38 < 0.75 …"}}
# → call Claude for rationale, or human ask
```

Parallel (one round-trip, +5ms for 26 extra questions):

```
jev_ask { "state":"{\"ticket\":\"payouts failing\"}", "questions":"{\"team\":{\"type\":\"choice\",\"instructions\":\"Route\",\"criteria\":{\"billing\":\"pay\",\"technical\":\"bug\"}},\"is_urgent\":{\"type\":\"noul\",\"instructions\":\"Is urgent?\"}}" }
```

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `ok:false, error:"TYPESAFE_API_KEY is required…"` | `echo $TYPESAFE_API_KEY` empty → `export TYPESAFE_API_KEY=ts_…` and restart Opencode (or set `.env`). For CI use `JEV_BACKEND=mock`. |
| `state too large … truncated` | State >60k — plugin head+tail truncates with marker. Summarize long transcripts first, or split via `jev_ask`. |
| `criteria lint: description too short` | Option desc <12 chars — add a rubric sentence (`"pay"` → `"payments, invoices, payouts, refunds"`). |
| `gated:{action:"escalate"}` on every call | Criteria overlap (Jaccard >0.6) or vague prompt — differentiate descriptions, make state more specific. |
| `Jev API 429/529` | Retry is automatic (2× backoff). If persistent, gate and fall back to mock (`JEV_BACKEND=mock`). |
| `opencode debug` shows no OpenJev log | `cat .opencode/plugins/openjev.ts` path wrong → should be `../../dist/src/plugin.js` (or `../../openjev/dist…` if nested). Rebuild `npm run build`. |

## 8. Optional — bundled skill

Makes the agent default to `jev_*` for bounded decisions:

```json
// opencode.json
{ "skills": { "paths": ["skill"] } }
```

Skill lives at `skill/openjev/SKILL.md` and is included in the npm package (`files: ["dist","skill","README.md","LICENSE"]`).

## 9. Publish (maintainers)

```bash
npm run typecheck && npm run build && npm test
npm pack --dry-run   # 32 files, ~27kB
npm publish          # then: gh repo create anomalyco/opencode-openjev --public --source=. --push
```

See `bench/bench.mjs` for the `p50 267ms` / `10/10 100%` harness bench.
