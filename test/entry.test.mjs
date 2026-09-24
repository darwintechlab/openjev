import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.JEV_BACKEND = "mock";
delete process.env.TYPESAFE_API_KEY;

describe("package entry (opencode loader contract)", () => {
  it("default-exports a { id, server } module", async () => {
    const mod = await import("../dist/index.js");
    const entry = mod.default;
    assert.equal(typeof entry, "object");
    assert.ok(entry && !Array.isArray(entry));
    assert.equal(typeof entry.server, "function");
    assert.equal(typeof entry.id, "string");
    assert.equal(entry.id.length > 0, true);
  });

  it("keeps named plugin exports and helpers", async () => {
    const mod = await import("../dist/index.js");
    assert.equal(typeof mod.OpenJevPlugin, "function");
    assert.equal(typeof mod.OpenJev, "function");
    assert.equal(typeof mod.Jev, "function");
    assert.equal(typeof mod.decide, "function");
  });

  it("exposes a server() that returns tools (v2 detect path)", async () => {
    const { default: entry } = await import("../dist/index.js");
    const fakeClient = { app: { log: async () => {} } };
    const hooks = await entry.server({
      client: fakeClient,
      project: {},
      directory: process.cwd(),
      worktree: process.cwd(),
      $: null,
    });
    assert.deepEqual(Object.keys(hooks.tool).sort(), ["jev_ask", "jev_choice", "jev_doctor", "jev_noul", "jev_score"]);
  });
});
