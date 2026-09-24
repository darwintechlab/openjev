# OpenJev for opencode

**Your opencode agent makes a lot of small decisions. OpenJev makes them faster and cheaper, and it tells you when it isn't sure.**

A coding agent spends much of its time on questions with only a few possible answers. *Is this command safe to run? Which tool fits this task? Is this PR ready to merge? How serious is this bug?* Today the agent handles these the way it writes code: a large language model writes out an answer in text, and something then has to parse that text.

OpenJev gives opencode a model built for these questions. You pass it the text and the possible answers. It tells you which answer fits and how confident it is. It doesn't write text, so it can only answer with one of the options you gave it.

`opencode-openjev` · MIT · Node ≥ 20 · opencode ≥ 1.18 · **[5-minute setup](./SETUP.md)**

**Maintained by:** https://darwintechlab.com, https://darwinevo.com & the community.

---

## Why use it

| | Asking the LLM | With OpenJev |
|---|---|---|
| **Speed** | Usually seconds, because the model writes its answer word by word | About 0.3 s per decision ([measured](./bench/results.md): p50 267 ms) |
| **Cost** | You pay for every word it writes | About $0.017 per 1,000 decisions, and you don't pay for output |
| **Answer format** | Free text that has to be parsed, and sometimes the parsing fails | Always one of the options you defined |
| **When it's unsure** | Sounds equally confident whether it's right or guessing | Gives a confidence score and flags uncertain answers |
| **Several questions at once** | A longer prompt and a longer answer to parse | Up to 32 questions in one call; 27 questions took about 5 ms longer than 1 in our tests |

**The confidence score is the main reason to use it.** The scores are calibrated, which means higher confidence really does mean the answer is more likely to be right. In our tests, the pick-one answers it scored 0.75 or higher were right 96% of the time. The agent can act on its own when OpenJev is confident and bring in you (or the bigger model) when it isn't. The plugin labels every answer for you as `auto` (confident enough to act on) or `escalate` (should go to the LLM or a person).

### What that looks like

Here are two support tickets, each routed to one of four teams (billing, technical, sales, spam):

| Ticket | OpenJev's answer | Confidence | What happens |
|---|---|---|---|
| "Help! payouts failing 3 days — order #48281" | billing | 0.99 | Routed automatically |
| "Please help" | technical | 0.38 | Too vague to route, so it's flagged for a person |

The second ticket doesn't say enough to choose a team. OpenJev reports that with a low score instead of confidently giving an answer.

### What you can use it for

* **Safety checks.** Before the agent runs `rm -rf` or reads `.env`, ask whether the action is destructive or irreversible. If the answer is a confident yes, the agent stops and asks you.
* **Choosing a tool or model.** Decide which tool fits a request, or whether a task needs the large, expensive model or a small, fast one.
* **Review verdicts.** Approve, request changes, or block a PR, with a confidence bar that you set.
* **Triage.** Get the team, urgency, and severity for an issue in one call.
* **Scoring.** Rate risk, quality, or severity on a scale you define.

### What it's not for

It doesn't write code, summaries, or explanations, and it can't answer questions that don't have a fixed set of answers. Keep using your LLM for those. OpenJev works alongside the LLM and handles the small decisions so the LLM doesn't have to.

---

## How it works in opencode

Installing the plugin gives your agent five new tools: `jev_choice`, `jev_noul`, `jev_score`, `jev_ask`, and `jev_doctor`. The agent can call them whenever it reaches a decision like the ones above. If you also turn on the bundled skill, the agent uses the tools by default without being asked.

**Jev** (System One) answers the questions. It's a hosted decision model that you can reach through TypeSafe, OpenRouter, or Vercel AI Gateway. You can also point the plugin at an OpenJev-compatible endpoint that you host yourself.

## Get started

You need opencode 1.18+, Node 20+, and a free API key from **https://console.typesafe.ai**.

1. **Add the plugin** to your `opencode.json`. opencode installs it the next time it starts.

   ```json
   { "$schema": "https://opencode.ai/config.json", "plugin": ["opencode-openjev"] }
   ```

2. **Set your key** in your shell (keep it out of the repo). You can also put it in a `.env` file, which the plugin loads for you.

   ```bash
   export TYPESAFE_API_KEY=ts_...
   ```

3. **Restart opencode and run `jev_doctor`** to confirm the plugin is connected.

To have the agent use the tools on its own, turn on the bundled skill ([SETUP.md, step 8](./SETUP.md#8-optional--bundled-skill)).

> **No key yet?** The plugin still runs without one, in *mock* mode. Everything works end to end, but the answers are placeholders. Mock mode is useful for testing your setup and for CI. Don't use it for real decisions.

For the full walkthrough and troubleshooting, see **[SETUP.md](./SETUP.md)**.

## How accurate is it?

We tested it on 52 labeled decisions ([full results](./bench/results.md)):

* **88.5% correct overall.** That's 97% on clear cases and 71% on ambiguous ones.
* **Confident answers are more reliable.** 80% of the pick-one decisions scored 0.75 or higher, and 96% of those were correct. The rest were flagged for review.
* **Severity scoring is the weakest area:** 67% correct, though there were only 6 cases.

The test set is small and we wrote it ourselves, so treat these numbers as a starting point. To measure accuracy on your own workload, replace `bench/dataset.jsonl` with your own cases and run `npm run bench:eval`.

## Your data

* The text you ask about (`state`) is sent to the Jev endpoint you configure. Don't include passwords, API keys, or private data that has nothing to do with the decision.
* Every decision is recorded in the opencode log with its answer, confidence, and whether it was `auto` or `escalate`. The log stores a hash of the text, not the text itself.
* To keep everything in-house, point the plugin at a self-hosted OpenJev endpoint (see [Configuration](#configuration)).

---

# Reference

The rest of this page is for developers who are integrating the plugin or contributing to it.

## Tools

| Tool | Answers questions like | Returns (JSON string) |
|---|---|---|
| `jev_choice` | "Which team should get this?" (one of 2–32 options) | `{model, choice, probabilities, confidence, gated, usage}` |
| `jev_noul` | "Is this destructive?" (yes/no, as a probability 0..1) | `{model, noul, is_yes, confidence, gated, usage}` |
| `jev_score` | "How severe is this?" (an ordered scale) | `{model, score, probabilities, confidence, legend, gated, usage}` |
| `jev_ask` | Any mix of the above, in one call | `{model, answers:{id->Answer}, gated, usage}` |
| `jev_doctor` | "Is my setup working?" | `{ok, model, answers, usage}` or `{ok:false, error}` |

All questions in a single `jev_ask` are evaluated **in parallel** on the same `state`. Adding questions barely changes latency and doesn't cause context rot.

Default confidence gates: `choice` and `noul` 0.75, `score` 0.65 (`src/gate.ts`).

### Plugin vs skill

* **Plugin** (`opencode-openjev`): the npm package that registers the tools and handles auth, retries, validation, gating, and audit logging. It works on its own.
* **Skill** (`skill/openjev/SKILL.md`): optional prompt guidance that makes the agent reach for `jev_*` by default for bounded decisions (routing, guardrails, approvals, scoring) instead of generating text.

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
git clone https://github.com/darwintechlab/openjev.git
cd openjev
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
| `mock` | `JEV_BACKEND=mock` (also used when no key is set) | local deterministic, no network |
| `openjev-local` | `JEV_BACKEND=openjev-local` | hook for local calibrated LLM (currently falls back to `mock`) |

Optional overrides: `JEV_MODEL` (default `jev-latest`), `JEV_BASE_URL`, `JEV_BACKEND`.

> **`.env` is auto-loaded.** opencode does not load `.env` into `process.env` itself (issues #10458 / #21187), so the plugin reads it at startup from, in order: `JEV_ENV_FILE`, `./.env`, `./.opencode/.env`, then the plugin's project dir. Existing shell/OS variables always win, so `export TYPESAFE_API_KEY=…` still overrides the file. Restart opencode after editing `.env`.

**Verify wiring in the Opencode TUI:**

```
jev_doctor
jev_doctor { "probe_state": "my ticket text" }
```

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
// → {"choice":"billing","probabilities":{"billing":0.99,…},"confidence":0.99,"gated":{"action":"auto",…},"model":"jev-latest"}
```

### Confidence gating (recommended)

Every result already includes `gated.action` (`auto` / `escalate`). If you want your own threshold:

```ts
const { choice, confidence } = JSON.parse(await jev_choice({ ... }));
if (confidence < 0.75) {
  // escalate to a slower LLM for rationale, or to a human `ask`
} else {
  route(choice);
}
```

Jev's numbers are **calibrated** (RLCD training), so higher confidence actually means higher accuracy. Standard LLMs are not calibrated this way.

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

### Integration ideas for the harness

The plugin exposes tools; these are places in an opencode setup where they can replace `prompt → text → parse JSON`:

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
  plugin.ts   # opencode plugin (5 tools, input parsing, logging)
  gate.ts     # confidence gating (auto / escalate thresholds)
  audit.ts    # privacy-safe audit log entries (state hash, not raw state)
  state.ts    # criteria lint and state helpers
  dotenv.ts   # zero-dep .env loader (opencode does not load .env itself)
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

* Input validation before network (`state` 0–60k chars, 1–32 questions, per-type criteria limits). Longer `state` is head+tail truncated with a marker.
* Retries with exponential backoff + jitter for `429` / `529` / `5xx` and timeouts (per `docs.typesafe.ai/api`).
* Auth via `Authorization: Bearer …`; errors do not log the URL or key, only `backend`.
* Mock backend is deterministic (FNV + softmax) so CI is reproducible without a key.

---

## Security

* Never send passwords, API keys, or unrelated private data as `state` (`docs.typesafe.ai` guidance — keep irreversible actions behind your own human approval).
* `state` is the content to decide on; `questions` are the typed schema you define upfront — there is no free-form generation to leak data.

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
