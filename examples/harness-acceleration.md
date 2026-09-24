# Harness acceleration: where Jev replaces text generation

Opencode harness today uses an LLM (often `llama.cpp`, `claude`, `gpt`) with `prompt -> text -> parse JSON` for decisions that are actually bounded. Jev replaces those with typed `Choice/Noul/Score` in a single 70–500ms call.

## Decision matrix

| Harness decision | Now (text) | With Jev (typed) | Latency gain* |
|------------------|------------|------------------|---------------|
| Skill / tool routing (`opencode-prompt-router` TF-IDF or LLM classify) | LLM generates `{"tool":"read"}` | `jev_choice` over `{read, edit, bash, jev_*}` | ~10–40x |
| Model tier routing (`jev-router` pattern) | LLM prompt to pick tier | `jev_choice` {haiku,sonnet,opus} + `jev_noul` is_complex | ~20x |
| `permission.ask` (`bash: rm *` / `.env` read) | LLM judges + regex | `jev_noul` "Is this destructive?" | ~10x, calibrated |
| Session compaction | LLM summarizes | `jev_score` quality + `jev_choice` keep/discard | no hallucinated summary |
| PR triage / QA verdict | LLM writes prose verdict | `jev_choice` {approve, request_changes, block} + confidence | ~25x, 0% type error |

*TypeSafe reports 75x/170x vs GPT/Claude on 27-task row-filter harness; your numbers will vary but order-of-magnitude holds because Jev is parallel non-autoregressive.

## Example: routing 27 harness tasks in one call (vs 27 LLM calls)

```js
import { decide } from "opencode-openjev";

const state = { transcript: "...", tools: ["read","edit","bash","jev_choice"] };

// One Jev call, 27 questions evaluated in parallel, same state
const { answers } = await decide(JSON.stringify(state), {
  route_01: { type: "choice", instructions: "Pick tool for 'fix typo in README'", criteria: { read:"...", edit:"...", bash:"..." } },
  // ... up to N
  is_risky_01: { type: "noul", instructions: "Is this edit risky?" },
  quality_01: { type: "score", instructions: "Score completeness", criteria: ["empty","partial","complete"] },
});
```

## Confidence gating pattern (shipped with plugin)

```js
const { choice, confidence } = JSON.parse(await jev_choice({ ... }));
if (confidence < 0.75) {
  // escalate: LLM with rationale or human `ask`
} else {
  route(choice);
}
```

Jev's probabilities are calibrated (RLCD) — higher `confidence` actually means higher accuracy — so thresholds are meaningful, unlike LLM `temperature` tricks.
