#!/usr/bin/env node
// Demo without needing an LLM — uses JEV_BACKEND=mock
import { decide } from "../dist/src/client.js";

process.env.JEV_BACKEND = process.env.JEV_BACKEND ?? "mock";

const state = "Help! My payouts have been failing for 3 days. Order #48281 hasn't cleared.";

const res = await decide(state, {
  team: {
    type: "choice",
    instructions: "Route this support ticket to the correct team",
    criteria: {
      billing: "payments, invoices, payouts",
      technical: "bugs, outages, integration",
      sales: "buying, pricing",
      spam: "irrelevant or abusive",
    },
  },
  is_urgent: { type: "noul", instructions: "Does this convey urgency?" },
  severity: {
    type: "score",
    instructions: "Score severity from low to critical",
    criteria: ["low", "medium", "high", "critical"],
  },
});

console.log(JSON.stringify(res, null, 2));
console.log("\n--- harness decision ---");
const team = res.answers.team;
if (team.choice && team.confidence > 0.7) {
  console.log(`→ Auto-route to ${team.choice} (conf ${team.confidence.toFixed(2)})`);
} else {
  console.log(`→ Low confidence (${team.confidence.toFixed(2)}), escalate to LLM/human`);
}
if (res.answers.is_urgent.noul > 0.7) console.log("→ Urgent: prioritize queue");
console.log(`→ Severity score: ${res.answers.severity.score.toFixed(2)}`);
