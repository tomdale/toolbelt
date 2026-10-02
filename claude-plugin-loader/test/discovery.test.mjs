import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readlinkSync, statSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
const home = mkdtempSync(join(tmpdir(), 'cpl-discovery-'));
process.env.PI_CLAUDE_PLUGINS_DIR = join(home, 'loader');
after(() => rmSync(home, { recursive: true, force: true }));
const { installFromSource } = await import('../dist/install.js');
const { removePlugin } = await import('../dist/registry.js');
const { loadSkills } = await import('@earendil-works/pi-coding-agent');
const root = join(home, 'plugin');
mkdirSync(join(root, '.claude-plugin'), { recursive: true });
mkdirSync(join(root, 'skills/example'), { recursive: true });
writeFileSync(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'example' }));
const source = join(root, 'skills/example/SKILL.md');
writeFileSync(source, '---\nname: example\ndescription: Example\n---\n\nInitial\n');
const link = join(process.env.PI_CLAUDE_PLUGINS_DIR, 'current/example');

test('stable link follows changed snapshots without modifying session paths', () => {
 const [old] = installFromSource(root);
 assert.equal(readlinkSync(link), dirname(old.skillDirs[0]));
 const inode = statSync(link, { throwIfNoEntry: true }).ino;
 const [cached] = installFromSource(root);
 assert.equal(cached.skillDirs[0], old.skillDirs[0]);
 assert.equal(statSync(link).ino, inode);
 writeFileSync(source, readFileSync(source, 'utf8').replace('Initial', 'Changed'));
 const [changed] = installFromSource(root);
 assert.equal(readlinkSync(link), dirname(changed.skillDirs[0]));
 assert.notEqual(changed.skillDirs[0], old.skillDirs[0]);
 assert.match(readFileSync(join(old.skillDirs[0], 'example/SKILL.md'), 'utf8'), /Initial/);
 assert.match(readFileSync(join(link, 'skills/example/SKILL.md'), 'utf8'), /Changed/);
 const result = loadSkills({ cwd: home, agentDir: home, includeDefaults: false, skillPaths: [join(link, 'skills'), changed.skillDirs[0]] });
 assert.equal(result.skills.length, 1);
 assert.equal(result.skills[0].name, 'example-example');
 assert.deepEqual(result.diagnostics, []);
});

test('concurrent refreshes expose only complete snapshots through the stable link', async () => {
 writeFileSync(source, readFileSync(source, 'utf8') + '\nEdited again\n');
 const module = new URL('../dist/install.js', import.meta.url).href;
 await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
   const { installFromSource } = await import(${JSON.stringify(module)});
   installFromSource(${JSON.stringify(root)});
   const { readFileSync } = await import('node:fs');
   for (let i=0; i<500; i++) {
    const skill=readFileSync(${JSON.stringify(join(link, 'skills/example/SKILL.md'))},'utf8');
    if(!skill.includes('Edited again')) throw new Error('Incomplete link target');
   }
  `], { env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr=''; child.stderr.on('data', b => stderr += b);
  child.on('error',reject); child.on('exit',code => code===0 ? resolve() : reject(new Error(stderr)));
 })));
 assert.ok(existsSync(join(readlinkSync(link), '.complete')));
});

test('repairs missing aliases and unregisters without deleting snapshots', () => {
 const [plugin] = installFromSource(root);
 rmSync(link);
 installFromSource(root);
 assert.equal(readlinkSync(link), dirname(plugin.skillDirs[0]));
 removePlugin('example');
 assert.ok(!existsSync(link));
 assert.ok(existsSync(join(plugin.skillDirs[0], 'example/SKILL.md')));
});

test('never overwrites a non-link discovery path', () => {
 mkdirSync(link);
 assert.throws(() => installFromSource(root), /not a symlink/);
 assert.ok(statSync(link).isDirectory());
});
