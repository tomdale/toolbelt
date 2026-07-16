import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the registry at a throwaway dir before importing loader modules, since
// they read the location at call time from this env var.
process.env.PI_CLAUDE_PLUGINS_DIR = join(mkdtempSync(join(tmpdir(), "cpl-")), "claude-plugins");

const { parseSource } = await import("../dist/source.js");
const { installFromSource } = await import("../dist/install.js");
const { readRegistry } = await import("../dist/registry.js");
// pi's real skill loader: the exact code path a live session uses on the
// skillPaths our extension returns.
const { loadSkillsFromDir } = await import("@earendil-works/pi-coding-agent");

test("parseSource understands pi-style shorthands", () => {
  assert.equal(parseSource("git:github.com/tomdale/skills").url, "https://github.com/tomdale/skills");
  assert.equal(parseSource("tomdale/skills").url, "https://github.com/tomdale/skills");
  assert.equal(parseSource("github.com/tomdale/skills@v1").ref, "v1");
  assert.equal(parseSource("https://github.com/tomdale/skills").kind, "git");
  assert.equal(parseSource("/tmp/local-plugin").kind, "local");
});

test("installs github.com/tomdale/skills and pi loads valid namespaced skills", { concurrency: false }, () => {
  const installed = installFromSource("git:github.com/tomdale/skills");

  assert.equal(installed.length, 1, "expected the single 'tdx' plugin");
  const [plugin] = installed;
  assert.equal(plugin.name, "tdx");
  assert.ok(plugin.skillDirs.length >= 1, "expected at least one skill directory");

  // The registry is what the extension reads at resources_discover time.
  const registry = readRegistry();
  assert.equal(registry.plugins.length, 1);

  // Load every registered skill dir exactly as pi would.
  const names = new Set();
  const diagnostics = [];
  for (const dir of registry.plugins[0].skillDirs) {
    const result = loadSkillsFromDir({ dir, source: "test" });
    for (const skill of result.skills) names.add(skill.name);
    diagnostics.push(...result.diagnostics);
  }

  assert.deepEqual(
    diagnostics.map((d) => `${d.path}: ${d.message}`),
    [],
    "staged plugin skills should not produce validation warnings",
  );

  // Skills ship in the test-case repo and must arrive namespaced as tdx-<name>,
  // never bare, so they cannot collide with global skills of the same name.
  for (const expected of ["tdx-refactoring", "tdx-recap", "tdx-cruft"]) {
    assert.ok(names.has(expected), `expected pi to load "${expected}" (got: ${[...names].join(", ")})`);
  }
  for (const bare of ["refactoring", "recap", "cruft"]) {
    assert.ok(!names.has(bare), `"${bare}" should be namespaced, not bare`);
  }
});
