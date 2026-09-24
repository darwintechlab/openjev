import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decide, mockAnswer, validateQuestions, resolveBackend } from "../dist/src/client.js";

// Ensure mock backend for all tests
process.env.JEV_BACKEND = "mock";
delete process.env.TYPESAFE_API_KEY;
delete process.env.OPENROUTER_API_KEY;

describe("validateQuestions", () => {
  it("rejects empty questions", () => {
    assert.throws(() => validateQuestions({}), /at least one question/);
  });
  it("rejects unknown type", () => {
    assert.throws(() => validateQuestions({ q: { type: "bogus", instructions: "hi" } }), /unknown type/);
  });
  it("rejects choice with <2 options", () => {
    assert.throws(
      () => validateQuestions({ q: { type: "choice", instructions: "pick", criteria: { a: "x" } } }),
      /at least 2 options/
    );
  });
  it("rejects score with <2 levels", () => {
    assert.throws(
      () => validateQuestions({ q: { type: "score", instructions: "rate", criteria: ["only"] } }),
      /at least 2 levels/
    );
  });
  it("accepts valid mixed questions", () => {
    validateQuestions({
      c: { type: "choice", instructions: "pick", criteria: { a: "x", b: "y" } },
      n: { type: "noul", instructions: "is yes?" },
      s: { type: "score", instructions: "rate", criteria: ["low", "high"] },
    });
  });
});

describe("mockAnswer", () => {
  it("choice probabilities sum to ~1 and confidence is max", () => {
    const ans = mockAnswer("state", { q: { type: "choice", instructions: "pick", criteria: { a: "x", b: "y", c: "z" } } });
    const p = ans.q.probabilities;
    const sum = Object.values(p).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
    assert.equal(ans.q.confidence, Math.max(...Object.values(p)));
    assert.ok(["a", "b", "c"].includes(ans.q.choice));
  });
  it("noul in [0,1]", () => {
    const ans = mockAnswer("state", { q: { type: "noul", instructions: "is?" } });
    assert.ok(ans.q.noul >= 0 && ans.q.noul <= 1);
  });
  it("score weighted avg between levels", () => {
    const ans = mockAnswer("state", { q: { type: "score", instructions: "rate", criteria: ["low", "mid", "high"] } });
    assert.ok(ans.q.score >= 0 && ans.q.score <= 2);
    assert.ok(ans.q.legend["0"] === "low");
  });
  it("deterministic", () => {
    const a = mockAnswer("hello", { q: { type: "choice", instructions: "pick", criteria: { a: "x", b: "y" } } });
    const b = mockAnswer("hello", { q: { type: "choice", instructions: "pick", criteria: { a: "x", b: "y" } } });
    assert.deepEqual(a, b);
  });
});

describe("decide (mock)", () => {
  it("validates empty state", async () => {
    await assert.rejects(() => decide("", { q: { type: "noul", instructions: "is?" } }), /state must be/);
  });
  it("truncates oversized state instead of throwing (smartTruncate)", async () => {
    const big = "x".repeat(61_000);
    const res = await decide(big, { q: { type: "noul", instructions: "is?" } });
    assert.equal(res.model, "mock"); // truncated and succeeded
  });
  it("returns mock model when no key", async () => {
    const res = await decide("hello", { q: { type: "noul", instructions: "is hello?" } });
    assert.equal(res.model, "mock");
    assert.ok(res.answers.q.noul >= 0);
  });
  it("parallel questions in one call", async () => {
    const res = await decide("ticket: payout fails", {
      team: { type: "choice", instructions: "route", criteria: { billing: "pay", tech: "bug" } },
      urgent: { type: "noul", instructions: "is urgent?" },
      sev: { type: "score", instructions: "severity", criteria: ["low", "high"] },
    });
    assert.ok(res.answers.team.choice);
    assert.ok(typeof res.answers.urgent.noul === "number");
    assert.ok(typeof res.answers.sev.score === "number");
  });
});

describe("resolveBackend", () => {
  it("explicit mock wins", () => {
    const r = resolveBackend({ backend: "mock" });
    assert.equal(r.backend, "mock");
  });
  it("auto-detect mock when no keys", () => {
    const r = resolveBackend({});
    assert.equal(r.backend, "mock");
  });
});
