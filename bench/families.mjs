/**
 * Decision families used by the eval. Each case in dataset.jsonl references a
 * family; the family supplies the instruction, criteria, and class space.
 */

export const FAMILIES = {
  routing: {
    type: "choice",
    instructions: "Route this support ticket to the correct team",
    criteria: {
      billing: "payments, invoices, payouts, refunds, billing address, VAT",
      technical: "bugs, outages, API, auth, webhooks, errors, integration",
      sales: "buying, pricing, plans, upgrade, seats, procurement",
      spam: "irrelevant, abusive, scam, promotion, unsolicited",
    },
    classes: ["billing", "technical", "sales", "spam"],
  },
  tool: {
    type: "choice",
    instructions: "Pick the single best tool to accomplish the user's request",
    criteria: {
      read: "inspect existing files, search, or understand code",
      edit: "modify an existing file",
      write: "create a new file",
      bash: "run a command, test, build, or git operation",
    },
    classes: ["read", "edit", "write", "bash"],
  },
  verdict: {
    type: "choice",
    instructions: "Review verdict for this change",
    criteria: {
      approve: "safe, correct, and tested",
      request_changes: "minor issues only, no blocking risk",
      block: "security, data-loss, or correctness risk",
    },
    classes: ["approve", "request_changes", "block"],
  },
  guardrail: {
    type: "noul",
    instructions: "Is this command destructive or irreversible?",
    criteria: { true: "deletes/overwrites data, or pipes remote code to a shell", false: "safe or read-only" },
    classes: [true, false],
  },
  urgency: {
    type: "noul",
    instructions: "Does this message convey urgency requiring immediate attention?",
    criteria: { true: "outage, security, or blocked revenue", false: "routine or informational" },
    classes: [true, false],
  },
  severity: {
    type: "score",
    instructions: "Score the severity of this issue from low to critical",
    criteria: ["low", "medium", "high", "critical"],
    classes: ["low", "medium", "high", "critical"],
  },
};
