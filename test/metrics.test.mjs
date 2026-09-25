import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as M from "../bench/metrics.mjs";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

describe("accuracy / F1", () => {
  it("computes accuracy", () => {
    close(M.accuracy([1, 1, 0], [1, 0, 0]), 2 / 3);
  });
  it("computes macro-F1 over classes", () => {
    const preds = ["a", "a", "b", "b"];
    const labels = ["a", "b", "a", "b"];
    close(M.macroF1(preds, labels, ["a", "b"]), 0.5);
  });
  it("builds a confusion matrix", () => {
    const c = M.confusion(["a", "b"], ["a", "a"], ["a", "b"]);
    assert.equal(c.a.a, 1);
    assert.equal(c.a.b, 1);
    assert.equal(c.b.a, 0);
  });
});

describe("calibration", () => {
  it("Brier is 0 for perfect confident predictions", () => {
    close(M.brier([{ a: 1, b: 0 }], ["a"], ["a", "b"]), 0);
  });
  it("Brier is 0.5 for a uniform guess", () => {
    close(M.brier([{ a: 0.5, b: 0.5 }], ["a"], ["a", "b"]), 0.5);
  });
  it("ECE is 0 when confidence matches accuracy", () => {
    close(M.ece([1, 1], [true, true]).ece, 0);
  });
  it("ECE detects overconfidence", () => {
    const { ece } = M.ece([0.9, 0.9], [true, false]);
    close(ece, 0.4);
  });
});

describe("selective prediction", () => {
  it("risk-coverage keeps the most confident first", () => {
    const rc = M.riskCoverage([0.9, 0.8, 0.1], [true, true, false], [1, 1 / 3]);
    close(rc[0].accuracy, 2 / 3);
    close(rc[1].accuracy, 1);
    close(rc[1].risk, 0);
  });
  it("threshold sweep reports coverage and selective accuracy", () => {
    const s = M.thresholdSweep([0.9, 0.8, 0.1], [true, false, true], [0.75]);
    assert.equal(s[0].n, 2);
    close(s[0].coverage, 2 / 3);
    close(s[0].accuracy, 0.5);
  });
  it("wilson interval brackets the estimate", () => {
    const w = M.wilson(10, 10);
    assert.equal(w.p, 1);
    assert.ok(w.lo < 1 && w.hi === 1);
    const w2 = M.wilson(1, 2);
    assert.ok(w2.lo > 0 && w2.lo < 0.5 && w2.hi > 0.5 && w2.hi < 1);
  });
});

describe("paired significance", () => {
  it("mcnemar counts discordant pairs and flags no difference as p=1", () => {
    const labels = ["a", "b", "a", "b"];
    const A = ["a", "b", "a", "b"];
    const B = ["a", "b", "a", "b"];
    const m = M.mcnemar(A, B, labels);
    assert.equal(m.a, 0);
    assert.equal(m.b, 0);
    assert.equal(m.both, 4);
    assert.equal(m.p, 1);
  });
  it("mcnemar detects a one-sided discordant split", () => {
    // A correct on 0..7, B wrong on all of those; B correct 8..9, A wrong
    const labels = Array.from({ length: 10 }, () => "x");
    const A = labels.map(() => "x");
    const B = ["y", "y", "y", "y", "y", "y", "y", "y", "x", "x"];
    const m = M.mcnemar(A, B, labels);
    assert.equal(m.a, 8);
    assert.equal(m.b, 0);
    assert.ok(m.p < 0.05, `expected significant, got p=${m.p}`);
  });
  it("paired bootstrap ignores the shared errors (works on the difference)", () => {
    const labels = ["a", "a", "b", "b"];
    const A = ["a", "a", "b", "b"];
    const B = ["a", "b", "b", "a"];
    const d = M.pairedBootstrapDiff(A, B, labels, { iters: 500, seed: 1 });
    assert.ok(d.mean > 0);
    assert.equal(d.iters, 500);
  });
  it("single-system bootstrap CI brackets the point estimate", () => {
    const corrects = [true, true, false, true, false, true, true, true];
    const ci = M.bootstrapCI(corrects, { iters: 1000, seed: 7 });
    const point = corrects.filter(Boolean).length / corrects.length;
    assert.ok(ci.lo <= point && point <= ci.hi, `${ci.lo} <= ${point} <= ${ci.hi}`);
  });
  it("mulberry32 is deterministic", () => {
    const a = M.mulberry32(123);
    const b = M.mulberry32(123);
    assert.equal(a(), b());
    assert.equal(a(), b());
  });
  it("costPer1k scales with tokens and decisions", () => {
    const c = M.costPer1k(1_000_000, 0, 1000, 0.042, 0);
    close(c, 0.042);
  });
});
