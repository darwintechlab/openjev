import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OpenJevPlugin } from "../dist/src/plugin.js";

process.env.JEV_BACKEND = "mock";
delete process.env.TYPESAFE_API_KEY;

function fakeClient() {
  return { app: { log: async () => {} } };
}

describe("plugin tools (mock)", () => {
  it("exposes 5 tools", async () => {
    const plugin = await OpenJevPlugin({ client: fakeClient(), project: {}, directory: process.cwd(), worktree: process.cwd(), $: null });
    assert.deepEqual(Object.keys(plugin.tool).sort(), ["jev_ask", "jev_choice", "jev_doctor", "jev_noul", "jev_score"]);
  });

  it("jev_choice validates and returns typed JSON", async () => {
    const plugin = await OpenJevPlugin({ client: fakeClient(), project: {}, directory: "/tmp", worktree: "/tmp", $: null });
    const raw = await plugin.tool.jev_choice.execute(
      { state: "ticket: payout fails", instructions: "Route", criteria: JSON.stringify({ billing: "pay", technical: "bug" }) },
      {}
    );
    const j = JSON.parse(raw);
    assert.ok(["billing", "technical"].includes(j.choice));
    assert.ok(j.confidence > 0 && j.confidence <= 1);
    assert.equal(j.model, "mock");
  });

  it("jev_choice rejects bad criteria", async () => {
    const plugin = await OpenJevPlugin({ client: fakeClient(), project: {}, directory: "/tmp", worktree: "/tmp", $: null });
    await assert.rejects(() => plugin.tool.jev_choice.execute({ state: "hi", instructions: "pick", criteria: "not-json" }, {}), /criteria must be/);
  });

  it("jev_noul returns noul 0..1", async () => {
    const plugin = await OpenJevPlugin({ client: fakeClient(), project: {}, directory: "/tmp", worktree: "/tmp", $: null });
    const raw = await plugin.tool.jev_noul.execute({ state: "is this risky? pr deletes db", instructions: "Is risky?" }, {});
    const j = JSON.parse(raw);
    assert.ok(j.noul >= 0 && j.noul <= 1);
  });

  it("jev_score validates levels", async () => {
    const plugin = await OpenJevPlugin({ client: fakeClient(), project: {}, directory: "/tmp", worktree: "/tmp", $: null });
    await assert.rejects(
      () => plugin.tool.jev_score.execute({ state: "hi", instructions: "rate", criteria: JSON.stringify(["only"]) }, {}),
      /at least 2 levels/
    );
    const raw = await plugin.tool.jev_score.execute({ state: "hi", instructions: "rate", criteria: JSON.stringify(["low", "high"]) }, {});
    assert.ok(typeof JSON.parse(raw).score === "number");
  });

  it("jev_ask parallel", async () => {
    const plugin = await OpenJevPlugin({ client: fakeClient(), project: {}, directory: "/tmp", worktree: "/tmp", $: null });
    const raw = await plugin.tool.jev_ask.execute(
      { state: "hello", questions: JSON.stringify({ a: { type: "noul", instructions: "is hello?" }, b: { type: "choice", instructions: "pick", criteria: { x: "1", y: "2" } } }) },
      {}
    );
    const j = JSON.parse(raw);
    assert.equal(j.model, "mock");
    assert.ok(j.answers.a.noul >= 0);
    assert.ok(j.answers.b.choice);
  });

  it("jev_doctor ok true on mock", async () => {
    const plugin = await OpenJevPlugin({ client: fakeClient(), project: {}, directory: "/tmp", worktree: "/tmp", $: null });
    const raw = await plugin.tool.jev_doctor.execute({}, {});
    assert.equal(JSON.parse(raw).ok, true);
  });
});
