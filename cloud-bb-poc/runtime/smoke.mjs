#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from 'node:http';
import { CORE_PORT, assertCorePortFree } from './launch.mjs';

const [installation, state] = process.argv.slice(2);
if (!installation || !state) throw new Error('Usage (isolated container): node smoke.mjs ABS_INSTALLATION ABS_FRESH_STATE');
await assertCorePortFree();
const child = spawn(process.execPath, [fileURLToPath(new URL('./launch.mjs', import.meta.url)), installation, state, 'https://bb.example.test'], { stdio: ['ignore', 'inherit', 'inherit'] });
const exit = new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })); });
const origin = `http://127.0.0.1:${CORE_PORT}`;
const checks = [];
try {
  let ready = false;
  for (let i = 0; i < 180; i++) {
    if (child.exitCode !== null || child.signalCode) throw new Error('Runtime exited before readiness.');
    if (existsSync(join(state, 'runtime.json'))) {
      try { ready = (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
      if (ready) break;
    }
    await delay(250);
  }
  assert(ready, 'fresh runtime becomes healthy within 45 seconds');
  assert.deepEqual(await (await fetch(`${origin}/health`)).json(), { ok: true });
  checks.push('fresh health endpoint');
  const duplicate = spawnSync(process.execPath, [fileURLToPath(new URL('./launch.mjs', import.meta.url)), installation, `${state}-occupied`], { encoding: 'utf8' });
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /Core loopback port 38886 unavailable/);
  assert.equal(existsSync(`${state}-occupied`), false);
  checks.push('occupied core port rejected before state mutation');
  const version = await (await fetch(`${origin}/api/v1/system/version`)).json();
  assert.equal(version.currentVersion, '0.48.1');
  checks.push(`actual released BB ${version.currentVersion}`);
  const htmlResponse = await fetch(origin);
  assert.equal(htmlResponse.status, 200);
  const html = await htmlResponse.text();
  const asset = html.match(/src="([^"]+\.js)"/);
  assert(asset, 'HTML references bundled JS');
  const js = await fetch(new URL(asset[1], origin));
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert((await js.arrayBuffer()).byteLength > 1000);
  checks.push('bundled UI HTML and referenced JS served');
  assert.deepEqual(await (await fetch(`${origin}/api/v1/hosts`)).json(), []);
  checks.push('no local agent host registered');
  const skillRoot = join(installation, 'app/node_modules/bb-app/server/dist/builtin-skills');
  const skills = readdirSync(skillRoot).filter(name => existsSync(join(skillRoot, name, 'SKILL.md')));
  for (const skill of ['bb-cli', 'bb-plugin-authoring', 'skill-creator', 'submit-a-plugin']) assert(skills.includes(skill), skill);
  checks.push(`bundled skill files: ${skills.join(', ')}`);
  const withHeaders = (path, headers) => new Promise((done, reject) => {
    const req = request(new URL(path, origin), { headers }, response => {
      response.resume();
      response.once('end', () => done({ status: response.statusCode, headers: response.headers }));
    });
    req.once('error', reject);
    req.end();
  });
  const publicResponse = await withHeaders('/api/v1/system/version', { Host: 'bb.example.test', Origin: 'https://bb.example.test' });
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers['access-control-allow-origin'], 'https://bb.example.test');
  const untrustedResponse = await withHeaders('/health', { Host: 'untrusted.example.test' });
  assert.equal(untrustedResponse.status, 403);
  checks.push('public Host/Origin accepted only for configured hostname');
  const ws = new WebSocket(`ws://127.0.0.1:${CORE_PORT}/ws`);
  try {
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket timed out')), 5000);
      ws.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket upgrade failed')); }, { once: true });
    });
    checks.push('realtime /ws upgrade');
  } finally { ws.close(); }
  if (process.platform === 'linux') {
    const port = CORE_PORT.toString(16).toUpperCase();
    const listeners = ['/proc/net/tcp', '/proc/net/tcp6'].flatMap(path => readFileSync(path, 'utf8').split('\n').map(line => line.trim().split(/\s+/)).filter(fields => fields[3] === '0A' && fields[1]?.endsWith(`:${port}`)));
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0][1], `0100007F:${port}`);
    checks.push('Linux kernel confirms core bound only to IPv4 loopback');
  }
} finally {
  child.kill('SIGTERM');
  const stopped = await Promise.race([exit, delay(10000).then(() => null)]);
  if (!stopped) { child.kill('SIGKILL'); throw new Error('Runtime did not stop within 10 seconds.'); }
  assert.equal(stopped.code, 0, 'runtime forwards shutdown to process group');
}
await assertCorePortFree();
checks.push('graceful shutdown releases core listener');
const reused = spawnSync(process.execPath, [fileURLToPath(new URL('./launch.mjs', import.meta.url)), installation, state], { encoding: 'utf8' });
assert.equal(reused.status, 1);
assert.match(reused.stderr, /State directory must be new or empty/);
checks.push('existing state refused after shutdown');
console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, installation: resolve(installation), state: resolve(state), checks }, null, 2));
