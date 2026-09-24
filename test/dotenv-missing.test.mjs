import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv, dotEnvPaths } from "../dist/src/dotenv.js";

// Separate file: node --test runs each file in its own process, so this gets a fresh cache.
describe("loadDotEnv (missing file)", () => {
  it("silently ignores a missing file", () => {
    process.env.JEV_ENV_FILE = join(tmpdir(), "openjev-does-not-exist-xyz", ".env");
    try {
      const res = loadDotEnv();
      assert.equal(res.applied.length, 0);
      assert.deepEqual(dotEnvPaths(), []);
    } finally {
      delete process.env.JEV_ENV_FILE;
    }
  });
});
