import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixture = JSON.parse(
  await readFile(
    new URL("../fixtures/pi-get-commands.json", import.meta.url),
    "utf8",
  ),
);

function skillRootsFromPiCommands(commands) {
  return commands
    .filter((command) => command.source === "skill")
    .map((command) => ({
      path: command.sourceInfo.path,
      origin:
        command.sourceInfo.scope === "project" ? "project" : "user",
      shape: "skill-file",
    }));
}

test("Pi get_commands preserves package and resources_discover skill file paths", () => {
  assert.deepEqual(skillRootsFromPiCommands(fixture.commands), [
    {
      path: "/home/test/.pi/agent/npm/node_modules/example-pi-package/skills/package-skill/SKILL.md",
      origin: "user",
      shape: "skill-file",
    },
    {
      path: "/opt/example-extension/resources/dynamic-skill/SKILL.md",
      origin: "user",
      shape: "skill-file",
    },
  ]);
});

test("Pi get_commands does not expose enough scope for resources_discover paths", () => {
  const dynamic = fixture.commands.find(
    (command) => command.name === "skill:dynamic-skill",
  );
  assert.equal(dynamic.sourceInfo.scope, "temporary");
  assert.notEqual(dynamic.sourceInfo.scope, "user");
  assert.notEqual(dynamic.sourceInfo.scope, "project");
  assert.equal(
    "resourceScope" in dynamic.sourceInfo,
    false,
    "Pi must expose whether a dynamic path is user or project scoped before BB can classify it without guessing from paths",
  );
});
