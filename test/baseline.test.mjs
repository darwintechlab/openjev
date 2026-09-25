import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, buildPromptMulti, parseJson, normalizeResponse, normalizeResponseMulti, aggregateSamples, classesFor } from "../bench/baseline.mjs";

describe("buildPrompt", () => {
  it("includes the instruction, options, JSON contract, and state", () => {
    const p = buildPrompt("routing", "my ticket text");
    assert.ok(p.includes("Route this support ticket"));
    assert.ok(p.includes("billing"));
    assert.ok(p.includes('"answer"'));
    assert.ok(p.includes("my ticket text"));
  });
  it("asks for a scalar probability on noul", () => {
    const p = buildPrompt("guardrail", "rm -rf /");
    assert.ok(p.includes("true|false"));
    assert.ok(p.includes('"p": 0.0'));
  });
});

describe("parseJson", () => {
  it("parses minified JSON", () => {
    assert.deepEqual(parseJson('{"answer":"billing"}'), { answer: "billing" });
  });
  it("strips code fences", () => {
    assert.deepEqual(parseJson('```json\n{"answer":"billing"}\n```'), { answer: "billing" });
  });
  it("recovers JSON embedded in prose", () => {
    assert.deepEqual(parseJson('Sure: {"answer":"sales"} thanks'), { answer: "sales" });
  });
  it("returns null on garbage", () => {
    assert.equal(parseJson("not json at all"), null);
    assert.equal(parseJson(undefined), null);
  });
});

describe("normalizeResponse — choice", () => {
  it("accepts a valid option and derives one-hot probs when p missing", () => {
    const n = normalizeResponse("routing", { answer: "billing" });
    assert.equal(n.pred, "billing");
    assert.equal(n.typeError, false);
    assert.equal(n.probs.billing, 1);
    assert.equal(n.conf, 1);
  });
  it("uses and renormalizes a verbalized distribution", () => {
    const n = normalizeResponse("routing", { answer: "technical", p: { billing: 1, technical: 3, sales: 0, spam: 0 } });
    assert.equal(n.pred, "technical");
    assert.ok(Math.abs(n.probs.technical - 0.75) < 1e-9);
    assert.ok(Math.abs(n.probs.billing - 0.25) < 1e-9);
    assert.ok(Math.abs(n.conf - 0.75) < 1e-9);
  });
  it("flags an out-of-space answer with no valid p as a type error", () => {
    const n = normalizeResponse("routing", { answer: "refunds" });
    assert.equal(n.pred, null);
    assert.equal(n.typeError, true);
  });
  it("falls back to the distribution argmax when the answer is invalid", () => {
    const n = normalizeResponse("routing", { answer: "nonsense", p: { billing: 0.1, technical: 0.7, sales: 0.1, spam: 0.1 } });
    assert.equal(n.pred, "technical");
    assert.equal(n.typeError, false);
  });
});

describe("normalizeResponse — noul", () => {
  it("reads a boolean answer", () => {
    const n = normalizeResponse("guardrail", { answer: true });
    assert.equal(n.pred, true);
    assert.equal(n.probs.true, 1);
  });
  it("reads a probability and derives the decision", () => {
    const n = normalizeResponse("guardrail", { p: 0.3 });
    assert.equal(n.pred, false);
    assert.ok(Math.abs(n.probs.true - 0.3) < 1e-9);
    assert.ok(Math.abs(n.conf - 0.7) < 1e-9);
  });
  it("flags a missing answer as a type error", () => {
    assert.equal(normalizeResponse("guardrail", {}).typeError, true);
  });
});

describe("aggregateSamples (self-consistency)", () => {
  it("turns label frequencies into probabilities", () => {
    const n = aggregateSamples("routing", [{ answer: "billing" }, { answer: "billing" }, { answer: "sales" }, { answer: "billing" }]);
    assert.equal(n.pred, "billing");
    assert.ok(Math.abs(n.probs.billing - 0.75) < 1e-9);
    assert.ok(Math.abs(n.probs.sales - 0.25) < 1e-9);
  });
  it("handles all-invalid samples", () => {
    const n = aggregateSamples("routing", [{ answer: "nope" }, null]);
    assert.equal(n.pred, null);
    assert.equal(n.typeError, true);
    assert.equal(n.parseErrorRate, 1);
  });
});

describe("multi-question (guardrail)", () => {
  it("builds one prompt covering every sub-question", () => {
    const p = buildPromptMulti("guardrail", "chmod -R 777 /");
    for (const k of ["data_loss", "security", "resources", "outside_workspace"]) assert.ok(p.includes(k), `missing ${k}`);
    assert.ok(p.includes("chmod -R 777 /"));
  });
  it("normalizes per sub-question and combines with OR", () => {
    const n = normalizeResponseMulti("guardrail", {
      data_loss: { answer: false, p: 0.1 },
      security: { answer: true, p: 0.8 },
      resources: { answer: false, p: 0.05 },
      outside_workspace: { answer: true, p: 0.9 },
    });
    assert.equal(n.subs.security.pred, true);
    assert.equal(n.subs.data_loss.pred, false);
    assert.equal(n.ask, true);
    assert.equal(Math.round(n.conf * 100) / 100, 0.8); // min sub confidence
    assert.equal(n.typeError, false);
  });
  it("flags a missing sub-question as a type error", () => {
    const n = normalizeResponseMulti("guardrail", { data_loss: { answer: false } });
    assert.equal(n.typeError, true);
    assert.equal(n.conf, 0);
  });
  it("returns all-safe when every sub-question is false", () => {
    const n = normalizeResponseMulti("guardrail", {
      data_loss: { answer: false },
      security: { answer: false },
      resources: { answer: false },
      outside_workspace: { answer: false },
    });
    assert.equal(n.ask, false);
    assert.equal(n.typeError, false);
  });
});

describe("classesFor", () => {
  it("gives boolean classes for noul and the class list otherwise", () => {
    assert.deepEqual(classesFor("guardrail"), [true, false]);
    assert.deepEqual(classesFor("routing"), ["billing", "technical", "sales", "spam"]);
  });
});
