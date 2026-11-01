#!/usr/bin/env node
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export function supportedNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major === 24 || major === 26 || (major === 22 && minor >= 19);
}

export function install(destination) {
  if (!supportedNode()) throw new Error('Use supported Node 22.19+, 24, or 26 (not Node 25).');
  if (!destination || !isAbsolute(destination)) throw new Error('Provide a new absolute installation directory.');
  const root = resolve(destination);
  mkdirSync(root, { recursive: false, mode: 0o700 });
  for (const sub of ['home', 'cache', 'app']) mkdirSync(join(root, sub), { mode: 0o700 });
  for (const config of ['user.npmrc', 'global.npmrc']) writeFileSync(join(root, config), '');
  const source = dirname(fileURLToPath(import.meta.url));
  for (const name of ['package.json', 'package-lock.json']) copyFileSync(join(source, name), join(root, 'app', name));
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin`,
    HOME: join(root, 'home'),
    NPM_CONFIG_USERCONFIG: join(root, 'user.npmrc'),
    NPM_CONFIG_GLOBALCONFIG: join(root, 'global.npmrc'),
    NPM_CONFIG_CACHE: join(root, 'cache'),
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_MIN_RELEASE_AGE: '0',
  };
  const npm = join(dirname(process.execPath), 'npm');
  const version = spawnSync(npm, ['--version'], { env, encoding: 'utf8' });
  if (version.status !== 0) throw new Error(`npm unavailable beside Node: ${version.stderr || version.error}`);
  if (!/^11\./.test(version.stdout.trim())) throw new Error('Use npm 11 bundled with Node 24; native addon install scripts must run.');
  const result = spawnSync(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund', '--foreground-scripts'], {
    cwd: join(root, 'app'), env, stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`npm ci failed (${result.status}); discard this incomplete installation.`);
  const installed = JSON.parse(readFileSync(join(root, 'app/node_modules/bb-app/package.json'), 'utf8'));
  if (installed.version !== '0.48.1') throw new Error('Unexpected BB release.');
  writeFileSync(join(root, 'installation.json'), JSON.stringify({ version: installed.version, node: process.version, nodeAbi: process.versions.modules, platform: process.platform, arch: process.arch }, null, 2));
  process.stdout.write(`BB installed at ${root}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { install(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
