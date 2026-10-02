import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "cpl-snapshots-"));
process.env.PI_CLAUDE_PLUGINS_DIR = join(home, "loader");
after(() => rmSync(home, { recursive: true, force: true }));
const { installFromSource, refreshLocalPlugins } = await import("../dist/install.js");
const { readRegistry, removePlugin, upsertPlugin } = await import("../dist/registry.js");
const { loadSkillsFromDir } = await import("@earendil-works/pi-coding-agent");
const installUrl = new URL("../dist/install.js", import.meta.url).href;
const registryUrl = new URL("../dist/registry.js", import.meta.url).href;

function fixture(name, count = 1) {
  const root = join(home, name);
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name }));
  for (let i = 0; i < count; i++) addSkill(root, `skill-${i}`);
  return root;
}
function addSkill(root, name) {
  mkdirSync(join(root, "skills", name), { recursive: true });
  writeFileSync(join(root, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Example skill\n---\n\nInitial\n`);
}
function names(dir) {
  return loadSkillsFromDir({ dir, source: "test" }).skills.map((s) => s.name).sort();
}
function child(code, ...args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--input-type=module", "-e", code, ...args], {
      env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (data) => { stdout += data; });
    proc.stderr.on("data", (data) => { stderr += data; });
    proc.on("error", reject);
    proc.on("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `Exit ${code}`)));
  });
}

test("unchanged refresh is read-only and retains installedAt", () => {
  const root = fixture("cached");
  const [before] = installFromSource(root);
  const registryPath = join(process.env.PI_CLAUDE_PLUGINS_DIR, "registry.json");
  const skillPath = join(before.skillDirs[0], "skill-0/SKILL.md");
  const registryStat = statSync(registryPath);
  const skillStat = statSync(skillPath);
  refreshLocalPlugins();
  const [after] = installFromSource(root);
  assert.deepEqual(after, JSON.parse(JSON.stringify(before)));
  assert.equal(statSync(registryPath).mtimeMs, registryStat.mtimeMs);
  assert.equal(statSync(registryPath).ino, registryStat.ino);
  assert.equal(statSync(skillPath).ino, skillStat.ino);
  assert.equal(statSync(skillPath).mtimeMs, skillStat.mtimeMs);
  assert.ok(existsSync(join(after.skillDirs[0], ".complete")));
});

test("content, additions, deletions, manifests and resource modes invalidate snapshots", () => {
  const root = fixture("edits");
  const [initial] = installFromSource(root);
  const source = join(root, "skills/skill-0/SKILL.md");
  const stamp = statSync(source);
  // Same byte count and restored mtime: metadata-only caching would miss this.
  writeFileSync(source, readFileSync(source, "utf8").replace("Initial", "Changed"));
  utimesSync(source, stamp.atime, stamp.mtime);
  const [changed] = installFromSource(root);
  assert.notEqual(changed.skillDirs[0], initial.skillDirs[0]);
  assert.match(readFileSync(join(initial.skillDirs[0], "skill-0/SKILL.md"), "utf8"), /Initial/);
  addSkill(root, "added");
  const [added] = installFromSource(root);
  assert.equal(names(added.skillDirs[0]).length, 2);
  rmSync(join(root, "skills/added"), { recursive: true });
  const [deleted] = installFromSource(root);
  assert.equal(deleted.skillDirs[0], changed.skillDirs[0]);
  const resource = join(root, "skills/skill-0/run.sh");
  writeFileSync(resource, "echo ok\n");
  chmodSync(resource, 0o644);
  const [resourceAdded] = installFromSource(root);
  chmodSync(resource, 0o755);
  const [executable] = installFromSource(root);
  assert.notEqual(executable.skillDirs[0], resourceAdded.skillDirs[0]);
  assert.equal(statSync(join(executable.skillDirs[0], "skill-0/run.sh")).mode & 0o777, 0o755);
  writeFileSync(resource, "echo changed\n");
  const [resourceEdited] = installFromSource(root);
  assert.notEqual(resourceEdited.skillDirs[0], executable.skillDirs[0]);
  writeFileSync(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "edits", version: "2" }));
  const [manifestEdited] = installFromSource(root);
  assert.notEqual(manifestEdited.skillDirs[0], resourceEdited.skillDirs[0]);
});

test("empty directories, linked resource contents and marketplace edits are captured", () => {
  const root = fixture("resources");
  const [initial] = installFromSource(root);
  mkdirSync(join(root, "skills/skill-0/empty"));
  const [empty] = installFromSource(root);
  assert.notEqual(empty.skillDirs[0], initial.skillDirs[0]);
  assert.ok(statSync(join(empty.skillDirs[0], "skill-0/empty")).isDirectory());
  const external = join(home, "external-resource.txt");
  writeFileSync(external, "first");
  symlinkSync(external, join(root, "skills/skill-0/linked.txt"));
  const [linked] = installFromSource(root);
  writeFileSync(external, "second");
  const [edited] = installFromSource(root);
  assert.notEqual(edited.skillDirs[0], linked.skillDirs[0]);
  assert.equal(readFileSync(join(linked.skillDirs[0], "skill-0/linked.txt"), "utf8"), "first");
  const marketplace = join(root, ".claude-plugin/marketplace.json");
  writeFileSync(marketplace, JSON.stringify({ name: "market", plugins: [{ name: "resources", source: "." }] }));
  const [market] = installFromSource(root);
  writeFileSync(marketplace, readFileSync(marketplace, "utf8") + "\n");
  const [marketEdited] = installFromSource(root);
  assert.notEqual(marketEdited.skillDirs[0], market.skillDirs[0]);
});

test("old snapshots survive unregister and interrupted unpublished builds are ignored", () => {
  const root = fixture("retained");
  const [plugin] = installFromSource(root);
  const versions = join(process.env.PI_CLAUDE_PLUGINS_DIR, "skills/.versions");
  const interrupted = join(versions, ".retained-interrupted");
  mkdirSync(join(interrupted, "skill-0"), { recursive: true });
  writeFileSync(join(interrupted, "skill-0/SKILL.md"), "partial");
  const [again] = installFromSource(root);
  assert.equal(again.skillDirs[0], plugin.skillDirs[0]);
  assert.equal(names(again.skillDirs[0]).length, 1);
  assert.equal(removePlugin(plugin.name), true);
  assert.equal(names(plugin.skillDirs[0]).length, 1);
  assert.equal(removePlugin(plugin.name), false);
});

test("failed staging never publishes a partial snapshot or changes the installed record", () => {
  const root = fixture("failure");
  const [plugin] = installFromSource(root);
  symlinkSync("missing", join(root, "skills/skill-0/broken"));
  assert.throws(() => installFromSource(root), /ENOENT/);
  assert.deepEqual(readRegistry().plugins.find((p) => p.name === "failure"), JSON.parse(JSON.stringify(plugin)));
  assert.equal(names(plugin.skillDirs[0]).length, 1);
});

test("cyclic resource links fail without publishing", () => {
  const root = fixture("cycle");
  symlinkSync(".", join(root, "skills/skill-0/self"));
  assert.throws(() => installFromSource(root), /Cyclic skill resource/);
  assert.ok(!readRegistry().plugins.some((p) => p.name === "cycle"));
});

test("refresh cannot resurrect a concurrently removed record", () => {
  const root = fixture("removed");
  const [old] = installFromSource(root);
  writeFileSync(join(root, "skills/skill-0/SKILL.md"), "---\nname: skill-0\ndescription: Edited\n---\n");
  const [candidate] = installFromSource(root);
  removePlugin("removed");
  upsertPlugin(candidate, old);
  assert.ok(!readRegistry().plugins.some((p) => p.name === "removed"));
});

test("refresh cannot overwrite a concurrent reinstall from a different source", () => {
  const root = fixture("reinstalled");
  const [old] = installFromSource(root);
  const other = fixture("replacement");
  writeFileSync(join(other, ".claude-plugin/plugin.json"), JSON.stringify({ name: "reinstalled" }));
  const [replacement] = installFromSource(other);
  upsertPlugin({ ...old, description: "stale refresh" }, JSON.parse(JSON.stringify(old)));
  assert.equal(readRegistry().plugins.find((p) => p.name === "reinstalled").source, replacement.source);
});

test("legacy staging migrates without deleting paths held by existing sessions", () => {
  const root = fixture("legacy");
  const legacy = join(process.env.PI_CLAUDE_PLUGINS_DIR, "skills/legacy");
  mkdirSync(join(legacy, "skill-0"), { recursive: true });
  writeFileSync(join(legacy, "skill-0/SKILL.md"), "---\nname: legacy-skill-0\ndescription: Legacy\n---\n");
  upsertPlugin({ name: "legacy", source: root, root, skillDirs: [legacy], commandPaths: [], installedAt: "old" });
  refreshLocalPlugins();
  const migrated = readRegistry().plugins.find((p) => p.name === "legacy");
  assert.notEqual(migrated.skillDirs[0], legacy);
  assert.deepEqual(names(migrated.skillDirs[0]), ["legacy-skill-0"]);
  assert.deepEqual(names(legacy), ["legacy-skill-0"]);
});

test("an interrupted registry writer times out without stealing its lock", async () => {
  const lock = join(process.env.PI_CLAUDE_PLUGINS_DIR, "registry.lock");
  mkdirSync(lock);
  const before = readFileSync(join(process.env.PI_CLAUDE_PLUGINS_DIR, "registry.json"), "utf8");
  try {
    const start = Date.now();
    await assert.rejects(child(`
      const { removePlugin } = await import(${JSON.stringify(registryUrl)});
      removePlugin('cached');
    `), /Registry is locked/);
    assert.ok(Date.now() - start < 10_000);
    assert.ok(existsSync(lock));
    assert.equal(readFileSync(join(process.env.PI_CLAUDE_PLUGINS_DIR, "registry.json"), "utf8"), before);
  } finally {
    rmSync(lock, { recursive: true });
  }
});

test("simultaneous cold starts publish one complete snapshot and preserve unrelated installs", async () => {
  const root = fixture("parallel", 18);
  const code = `
    const { installFromSource } = await import(${JSON.stringify(installUrl)});
    const { readRegistry } = await import(${JSON.stringify(registryUrl)});
    const [plugin] = installFromSource(process.argv[1]);
    for (let i = 0; i < 100; i++) JSON.parse((await import('node:fs')).readFileSync(process.env.PI_CLAUDE_PLUGINS_DIR + '/registry.json', 'utf8'));
    console.log(JSON.stringify(plugin));
  `;
  const roots = [root, ...Array.from({ length: 7 }, (_, i) => fixture(`other-${i}`))];
  const results = await Promise.all([...Array(8).fill(root), ...roots.slice(1)].map((r) => child(code, r)));
  const parallel = results.map((r) => JSON.parse(r)).filter((p) => p.name === "parallel");
  assert.equal(new Set(parallel.map((p) => p.skillDirs[0])).size, 1);
  assert.equal(new Set(parallel.map((p) => p.installedAt)).size, 1);
  assert.equal(names(parallel[0].skillDirs[0]).length, 18);
  for (let i = 0; i < 7; i++) assert.ok(readRegistry().plugins.some((p) => p.name === `other-${i}`));
  const versions = join(process.env.PI_CLAUDE_PLUGINS_DIR, "skills/.versions");
  assert.equal(readdirSync(versions).filter((n) => n.startsWith("parallel-")).length, 1);
  assert.equal(readdirSync(versions).filter((n) => n.startsWith(".parallel-")).length, 0);
});

test("a changed generation is published without disrupting concurrent readers", async () => {
  const root = fixture("generation", 18);
  const [old] = installFromSource(root);
  addSkill(root, "new");
  const start = Date.now() + 500;
  const builders = Array.from({ length: 6 }, () => child(`
    const { installFromSource } = await import(${JSON.stringify(installUrl)});
    while (Date.now() < ${start}) await new Promise(r => setTimeout(r, 1));
    console.log(JSON.stringify(installFromSource(process.argv[1])[0]));
  `, root));
  const reader = child(`
    const { readFileSync, readdirSync } = await import('node:fs');
    while (Date.now() < ${start}) await new Promise(r => setTimeout(r, 1));
    for (let i = 0; i < 1000; i++) {
      const registry = JSON.parse(readFileSync(process.env.PI_CLAUDE_PLUGINS_DIR + '/registry.json', 'utf8'));
      const plugin = registry.plugins.find(p => p.name === 'generation');
      const count = readdirSync(plugin.skillDirs[0]).filter(n => n !== '.complete').length;
      if (count !== 18 && count !== 19) throw new Error('Partial snapshot: ' + count);
      if (!readFileSync(${JSON.stringify(join(old.skillDirs[0], "skill-0/SKILL.md"))}, 'utf8').includes('Initial')) throw new Error('Old generation changed');
    }
  `);
  const [results] = await Promise.all([Promise.all(builders), reader]);
  assert.equal(new Set(results.map(r => JSON.parse(r).skillDirs[0])).size, 1);
  assert.equal(names(JSON.parse(results[0]).skillDirs[0]).length, 19);
  assert.equal(names(old.skillDirs[0]).length, 18);
});

test("concurrent warm refreshes leave registry and snapshot untouched", async () => {
  const root = fixture("warm", 18);
  const [plugin] = installFromSource(root);
  const registryPath = join(process.env.PI_CLAUDE_PLUGINS_DIR, "registry.json");
  const inode = statSync(registryPath).ino;
  const results = await Promise.all(Array.from({ length: 8 }, () => child(`
    const { installFromSource } = await import(${JSON.stringify(installUrl)});
    console.log(JSON.stringify(installFromSource(process.argv[1])[0]));
  `, root)));
  for (const result of results) assert.deepEqual(JSON.parse(result), JSON.parse(JSON.stringify(plugin)));
  assert.equal(statSync(registryPath).ino, inode);
  assert.equal(names(plugin.skillDirs[0]).length, 18);
});
