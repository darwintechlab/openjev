import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  gateChoice,
  gateNoul,
  gateScore,
  gateGuardrail,
  gateGuardrailFlags,
  gateAnswer,
  DEFAULT_THRESHOLDS,
} from "../dist/src/gate.js";

describe("symmetric gates", () => {
  it("choice auto at/above threshold", () => {
    assert.equal(gateChoice(0.76).action, "auto");
    assert.equal(gateChoice(0.74).action, "escalate");
  });
  it("noul uses max(p, 1-p)", () => {
    assert.equal(gateNoul(0.8).action, "auto"); // conf 0.8
    assert.equal(gateNoul(0.2).action, "auto"); // conf 0.8
    assert.equal(gateNoul(0.6).action, "escalate"); // conf 0.6
  });
  it("score threshold is lower", () => {
    assert.equal(gateScore(0.7).action, "auto");
    assert.ok(DEFAULT_THRESHOLDS.score < DEFAULT_THRESHOLDS.choice);
  });
});

describe("guardrail gate is asymmetric", () => {
  it("auto-allows only when the safe side is very confident", () => {
    assert.equal(gateGuardrail(0.0).action, "auto"); // P(safe)=1
    assert.equal(gateGuardrail(0.04).action, "auto"); // P(safe)=0.96
    assert.equal(gateGuardrail(0.06).action, "escalate"); // P(safe)=0.94
  });
  it("is strict around the 0.95 safe boundary", () => {
    assert.equal(gateGuardrail(0.04, 0.95).action, "auto"); // 0.96
    assert.equal(gateGuardrail(0.06, 0.95).action, "escalate"); // 0.94
  });
  it("escalates a case that the symmetric gate would auto-run", () => {
    // guard-14: chmod -R 777 /var/www judged P(risky)=0.10 (conf 0.90)
    assert.equal(gateNoul(0.1).action, "auto"); // old behavior: ran it
    assert.equal(gateGuardrail(0.1).action, "escalate"); // new: asks
  });
});

describe("gateGuardrailFlags", () => {
  it("auto-allows when every flag is confidently safe", () => {
    assert.equal(gateGuardrailFlags({ data_loss: 0.01, security: 0.02, resources: 0.0, outside_workspace: 0.03 }).action, "auto");
  });
  it("escalates when any flag is risky or uncertain", () => {
    assert.equal(gateGuardrailFlags({ data_loss: 0.9, security: 0.01 }).action, "escalate");
    assert.equal(gateGuardrailFlags({ data_loss: 0.1, security: 0.01 }).action, "escalate"); // 0.10 > 0.05
  });
  it("fails closed on empty input", () => {
    assert.equal(gateGuardrailFlags({}).action, "escalate");
    assert.equal(gateGuardrailFlags([]).action, "escalate");
  });
});

describe("gateAnswer dispatch", () => {
  it("routes by answer type", () => {
    assert.equal(gateAnswer({ type: "choice", confidence: 0.9 }).action, "auto");
    assert.equal(gateAnswer({ type: "noul", noul: 0.5 }).action, "escalate");
    assert.equal(gateAnswer({ type: "score", confidence: 0.9 }).action, "auto");
  });
});
