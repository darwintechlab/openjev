---
name: openjev
description: Use the opencode-openjev typed-decision tools (jev_choice, jev_noul, jev_score, jev_ask) by default whenever a task reduces to a bounded decision — routing/classification, yes-no guardrails or approvals, or an ordered severity/quality score — instead of generating text and parsing it. Triggers on "route this", "classify", "which team", "is this destructive/urgent/breaking", "approve or block", "triage", "score severity/risk/quality", "confidence", "calibrated", "structured output", or "typed decision". Also use when the user names jev, OpenJev, or System One.
---

# OpenJev typed decisions (default)

opencode-openjev exposes five tools backed by Jev/System One. They return
**calibrated probabilities**, not text, so branch on the numbers instead of
re-parsing prose.

## Default rule

For any **bounded** decision, call the matching `jev_*` tool **first**:

| Decision shape | Tool | Returns |
|---|---|---|
| One of 2–32 named options (routing, classification, verdict) | `jev_choice` | `{choice, probabilities, confidence, gated}` |
| Yes/no (guardrail, approval, urgency, breaking-change) | `jev_noul` | `{noul:0..1, is_yes, confidence, gated}` |
| Ordered rubric (severity, risk, quality) | `jev_score` | `{score, probabilities, confidence, legend, gated}` |
| Several of the above at once | `jev_ask` | `{answers:{id→…}, gated}` in one round-trip |

Use it by default — not only when asked. Do **not** answer these with generated
text or hand-parsed JSON.

## How to call

- `state`: the content to decide on (ticket, diff, command, JSON). Keep it
  focused; never include secrets, API keys, or passwords.
- `instructions`: one well-scoped question, e.g. "Route this ticket to the correct team".
- `criteria`: for choice, a JSON object `{"option":"rubric sentence"}` (≥2, distinct);
  for score, a JSON array lowest→highest, e.g. `["low","medium","high","critical"]`.
- Give each option a real rubric sentence; vague or overlapping options lower
  accuracy (the tools lint for this and warn).

## Gate every result

Each answer includes `gated.action`:

- `auto` (calibrated confidence ≥ threshold): use the answer directly.
- `escalate`: fall back to an LLM or ask the user for a rationale — never act
  silently on a low-confidence result.

Thresholds: choice/noul 0.75, score 0.65.

## Canonical uses

- **Routing** — `jev_choice` over `{billing, technical, sales, spam}`.
- **Guardrails** — before a risky `bash`/`edit`, `jev_noul` "Is this destructive or irreversible?"
- **Review verdicts** — `jev_choice` `{approve, request_changes, block}` + confidence.
- **Triage** — `jev_ask` with route (choice) + urgent (noul) + severity (score) in one call.

## Do not use for

- Open-ended generation, summaries, explanations, or anything without a bounded answer.
- Cases where the user explicitly wants prose.
- Passing secrets or unrelated private data as `state`.

## Verify wiring

Run `jev_doctor` to confirm the backend (hosted Jev vs `mock`). On `mock` the
numbers are deterministic placeholders — fine for CI, not for real decisions.
