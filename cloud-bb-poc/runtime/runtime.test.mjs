import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runtimeEnvironment, CORE_PORT } from './launch.mjs';
import { supportedNode } from './install.mjs';

test('runtime excludes ambient provider secrets, inherited BB targets, and user config', () => {
  const env = runtimeEnvironment('/tmp/synthetic-runtime', 'https://bb.example.test');
  assert.equal(env.HOME, '/tmp/synthetic-runtime/home');
  assert.equal(env.BB_DATA_DIR, '/tmp/synthetic-runtime/data');
  assert.equal(env.BB_SERVER_BIND_HOST, '127.0.0.1');
  assert.equal(env.BB_SERVER_PORT, String(CORE_PORT));
  assert.equal(env.BB_APP_URL, 'https://bb.example.test');
  for (const name of ['BB_SERVER_URL', 'BB_CLI', 'BB_THREAD_ID', 'BB_ENVIRONMENT_ID', 'NODE_OPTIONS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'SSH_AUTH_SOCK', 'NPM_TOKEN']) {
    assert.equal(Object.hasOwn(env, name), false, name);
  }
});

test('public origins reject paths, credentials, arbitrary protocols, and ambiguous forms', () => {
  for (const origin of ['https://bb.example.test/', 'https://bb.example.test/path', 'https://user:pass@bb.example.test', 'file:///tmp/bb', 'https://bb.example.test?x=1', 'http://bb.example.test#x']) {
    assert.throws(() => runtimeEnvironment('/tmp/test', origin));
  }
  assert.equal(runtimeEnvironment('/tmp/test').BB_APP_URL, undefined);
});

test('supported runtime versions match released BB engines', () => {
  for (const v of ['22.19.0', '22.25.0', '24.0.0', '26.0.0']) assert.equal(supportedNode(v), true, v);
  for (const v of ['20.19.0', '22.18.0', '23.0.0', '25.0.0']) assert.equal(supportedNode(v), false, v);
});

test('released package integrity is pinned in lockfile, not a moving dist-tag', () => {
  const lock = JSON.parse(readFileSync(new URL('./package-lock.json', import.meta.url), 'utf8'));
  const pkg = lock.packages['node_modules/bb-app'];
  assert.equal(pkg.version, '0.48.1');
  assert.equal(pkg.resolved, 'https://registry.npmjs.org/bb-app/-/bb-app-0.48.1.tgz');
  assert.equal(pkg.integrity, 'sha512-9y1ixbNYoffrLDUT+g4ALjkI8DLgzpCdvpreM23WxzdEiOxvvkGEzyTqqKPhV5zWJsGrJeeBCh+J8Xf9TenHTg==');
});
