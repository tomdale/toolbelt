import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanSessions } from "../src/scanner.js";

test("scanSessions reads Codex JSONL and Claude JSONL history", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlog-"));
  const project = join(home, "project");
  await mkdir(join(home, ".codex", "sessions", "2026"), { recursive: true });
  await mkdir(join(home, ".claude", "projects", "sample"), { recursive: true });

  await writeFile(
    join(home, ".codex", "sessions", "2026", "codex-session.jsonl"),
    [
      JSON.stringify({ timestamp: "2026-07-01T10:00:00.000Z", type: "session_meta", payload: { id: "codex-1", cwd: project } }),
      JSON.stringify({ timestamp: "2026-07-01T10:00:30.000Z", type: "response_item", payload: { type: "message", role: "user", content: "# AGENTS.md instructions\n\n<INSTRUCTIONS>Prefer pnpm.</INSTRUCTIONS>" } }),
      JSON.stringify({ timestamp: "2026-07-01T10:01:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the CLI history" }] } }),
    ].join("\n"),
  );

  await writeFile(
    join(home, ".claude", "projects", "sample", "claude-session.jsonl"),
    [
      JSON.stringify({ timestamp: "2026-07-02T10:00:00.000Z", cwd: join(project, "child"), sessionId: "claude-1", message: { content: [{ type: "text", text: "Refactor parser" }] } }),
    ].join("\n"),
  );

  const records = await scanSessions({ homeDir: home, targetDir: project, providers: ["codex", "claude"] });
  assert.equal(records.length, 2);
  assert.equal(records[0]?.provider, "claude");
  assert.equal(records[0]?.title, "Refactor parser");
  assert.equal(records[0]?.id, "claude-1");
  assert.equal(records[1]?.provider, "codex");
  assert.equal(records[1]?.id, "codex-1");
  assert.equal(records[1]?.title, "Inspect the CLI history");
});

test("scanSessions filters by query and limit", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlog-"));
  const project = join(home, "project");
  await mkdir(join(home, ".codex", "sessions"), { recursive: true });
  await writeFile(
    join(home, ".codex", "sessions", "one.jsonl"),
    JSON.stringify({ timestamp: "2026-07-01T10:00:00.000Z", type: "session_meta", payload: { cwd: project } }) +
      "\n" +
      JSON.stringify({ timestamp: "2026-07-01T10:01:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: "needle session" } }),
  );
  await writeFile(
    join(home, ".codex", "sessions", "two.jsonl"),
    JSON.stringify({ timestamp: "2026-07-02T10:00:00.000Z", type: "session_meta", payload: { cwd: project } }) +
      "\n" +
      JSON.stringify({ timestamp: "2026-07-02T10:01:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: "other session" } }),
  );

  const records = await scanSessions({ homeDir: home, targetDir: project, providers: ["codex"], query: "needle", limit: 1 });
  assert.equal(records.length, 1);
  assert.match(records[0]?.title ?? "", /needle/u);
});

test("scanSessions only returns sessions for the target directory tree", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlog-"));
  const project = join(home, "project");
  await mkdir(join(home, ".claude", "projects", "sample"), { recursive: true });

  await writeFile(
    join(home, ".claude", "projects", "sample", "inside.jsonl"),
    JSON.stringify({ timestamp: "2026-07-02T10:00:00.000Z", cwd: join(project, "child"), sessionId: "inside", message: { content: "inside project" } }),
  );
  await writeFile(
    join(home, ".claude", "projects", "sample", "outside.jsonl"),
    JSON.stringify({ timestamp: "2026-07-03T10:00:00.000Z", cwd: join(home, "project-other"), sessionId: "outside", message: { content: "outside project" } }),
  );

  const records = await scanSessions({ homeDir: home, targetDir: project, providers: ["claude"] });
  assert.deepEqual(
    records.map((record) => record.id),
    ["inside"],
  );
});
