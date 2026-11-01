#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { supportedNode } from './install.mjs';

export const CORE_PORT = 38886;
export function runtimeEnvironment(root, publicOrigin) {
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin`,
    HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'home/.config'),
    XDG_CACHE_HOME: join(root, 'home/.cache'),
    XDG_DATA_HOME: join(root, 'home/.local/share'),
    NODE_ENV: 'production',
    BB_DATA_DIR: join(root, 'data'),
    BB_SERVER_BIND_HOST: '127.0.0.1',
    BB_SERVER_PORT: String(CORE_PORT),
    BB_HOST_DAEMON_PORT: '38887',
    BB_SKIP_ONBOARDING: '1',
    BB_TELEMETRY: '0',
  };
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== publicOrigin) {
      throw new Error('Public origin must be an HTTP(S) origin without path, credentials, or trailing slash.');
    }
    env.BB_APP_URL = url.origin;
  }
  return env;
}

export async function assertCorePortFree() {
  await new Promise((done, reject) => {
    const probe = createServer();
    probe.once('error', error => reject(new Error(`Core loopback port ${CORE_PORT} unavailable: ${error.code}`)));
    probe.listen({ host: '127.0.0.1', port: CORE_PORT, exclusive: true }, () => probe.close(done));
  });
}

export async function launch(installation, root, publicOrigin) {
  if (!supportedNode()) throw new Error('Use supported Node 22.19+, 24, or 26.');
  if (![installation, root].every(p => p && isAbsolute(p))) throw new Error('Usage: node launch.mjs ABS_INSTALLATION ABS_FRESH_STATE [PUBLIC_ORIGIN]');
  installation = resolve(installation);
  root = resolve(root);
  const manifest = JSON.parse(readFileSync(join(installation, 'installation.json'), 'utf8'));
  if (manifest.version !== '0.48.1' || manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.nodeAbi !== process.versions.modules) throw new Error('Installation version/platform/architecture/Node ABI mismatch; install on the target host with the launch Node version.');
  const pkg = join(installation, 'app/node_modules/bb-app');
  for (const artifact of ['dist/bb-server.js', 'app/dist/index.html', 'server/dist/builtin-skills/bb-cli/SKILL.md']) {
    if (!existsSync(join(pkg, artifact))) throw new Error(`Missing released artifact: ${artifact}`);
  }
  const env = runtimeEnvironment(root, publicOrigin);
  await assertCorePortFree();
  if (existsSync(root) && readdirSync(root).length !== 0) throw new Error('State directory must be new or empty; never point at daily BB data.');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const directory of ['home', 'tmp', 'data']) mkdirSync(join(root, directory), { mode: 0o700 });
  writeFileSync(join(root, 'runtime.json'), JSON.stringify({ coreOrigin: `http://127.0.0.1:${CORE_PORT}`, version: manifest.version, localAgentHost: false }, null, 2));
  const child = spawn(process.execPath, [join(pkg, 'dist/bb-server.js'), '--data-dir', env.BB_DATA_DIR, '--server-bind-host', '127.0.0.1', '--server-port', String(CORE_PORT)], {
    cwd: root, env, stdio: 'inherit', detached: true,
  });
  let stopping = false;
  const stop = signal => {
    stopping = true;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const term = () => stop('SIGTERM');
  const interrupt = () => stop('SIGINT');
  process.on('SIGTERM', term);
  process.on('SIGINT', interrupt);
  await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      process.exitCode = stopping ? 0 : (code ?? (signal ? 1 : 0));
      done();
    });
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(-child.pid, 0); } catch (error) {
      if (error.code === 'ESRCH') break;
      throw error;
    }
    if (attempt === 49) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      break;
    }
    await delay(100);
  }
  process.off('SIGTERM', term);
  process.off('SIGINT', interrupt);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await launch(...process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
