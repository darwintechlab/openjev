import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv, dotEnvPaths } from "../dist/src/dotenv.js";

describe("loadDotEnv", () => {
  it("parses keys, strips quotes/comments/export, and never overrides existing env", () => {
    const dir = mkdtempSync(join(tmpdir(), "openjev-dotenv-"));
    const file = join(dir, ".env");
    writeFileSync(
      file,
      [
        "# a comment",
        "export FOO=bar",
        'QUOTED="hello world"',
        "SINGLE='single quoted'",
        "TRAILING=value # inline comment",
        "PRE_SET=from_file",
        "INVALID KEY=ignored",
      ].join("\n")
    );

    process.env.JEV_ENV_FILE = file;
    process.env.PRE_SET = "from_shell";
    delete process.env.FOO;
    delete process.env.QUOTED;
    delete process.env.SINGLE;
    delete process.env.TRAILING;

    try {
      const res = loadDotEnv();
      assert.equal(process.env.FOO, "bar");
      assert.equal(process.env.QUOTED, "hello world");
      assert.equal(process.env.SINGLE, "single quoted");
      assert.equal(process.env.TRAILING, "value");
      assert.equal(process.env.PRE_SET, "from_shell", "existing env var must win");
      assert.equal(process.env["INVALID KEY"], undefined);
      assert.ok(res.loaded.includes(file));
      assert.ok(dotEnvPaths().includes(file));

      const second = loadDotEnv();
      assert.deepEqual(second.loaded, res.loaded, "loadDotEnv is idempotent");
    } finally {
      delete process.env.JEV_ENV_FILE;
      delete process.env.PRE_SET;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
