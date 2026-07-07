import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/args.js";

test("parseArgs uses both providers by default", () => {
  const args = parseArgs([]);
  assert.deepEqual(args.providers, ["codex", "claude"]);
  assert.equal(args.json, false);
  assert.equal(args.targetDir, process.cwd());
});

test("parseArgs accepts provider, limit, query, home, and json options", () => {
  const args = parseArgs(["--agent", "codex", "--limit", "5", "--query", "router", "--home", "/tmp/home", "--cwd", "/tmp/project", "--json"]);
  assert.deepEqual(args.providers, ["codex"]);
  assert.equal(args.limit, 5);
  assert.equal(args.query, "router");
  assert.equal(args.homeDir, "/tmp/home");
  assert.equal(args.targetDir, "/tmp/project");
  assert.equal(args.json, true);
});

test("parseArgs rejects unknown providers", () => {
  assert.throws(() => parseArgs(["--agent", "other"]), /Unsupported agent provider/u);
});
