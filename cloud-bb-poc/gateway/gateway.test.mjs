import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createGateway, configFromEnv, nativeRoute } from './gateway.mjs';

test('temporary human password policy and form Origin policy', async () => {
  const env = { BB_GATEWAY_ORIGIN: 'https://bb.example.test', BB_CORE_PORT: '38886', BB_GATEWAY_OWNER_PASSWORD: 'test-pass-1' };
  assert.throws(() => configFromEnv(env), /12 characters/);
  assert.equal(configFromEnv({ ...env, BB_GATEWAY_OWNER_PASSWORD: 'test-password-12' }).corePort, 38886);
  const page = await request('/_gateway/login');
  assert.equal(page.headers['referrer-policy'], 'same-origin');
});

test('native desktop root navigation reaches login without exposing owner APIs', async () => {
  const before = calls.length;
  const page = await request('/', { headers: { accept: 'text/html,application/xhtml+xml', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
  assert.equal(page.status, 303);
  assert.equal(page.headers.location, '/_gateway/login');
  assert.equal((await request('/')).status, 401);
  assert.equal((await request('/', { headers: { accept: 'text/html' } })).status, 401);
  assert.equal((await request('/api/v1/system/config', { headers: { accept: 'text/html' } })).status, 401);
  assert.equal((await request('/api/v1/hosts', { headers: { accept: 'text/html' } })).status, 401);
  assert.equal(calls.length, before);
});

const origin = 'https://bb.example.test';
const password = 'test-only-not-a-real-secret-'.repeat(2);
let core, gateway, port, corePort, cookie;
const calls = [];
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

function request(path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { host: 'bb.example.test', ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function ws(path, headers = {}, frame = null) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('WS timeout')); });
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: bb.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${Object.entries(headers).map(([k,v]) => `${k}: ${v}\r\n`).join('')}\r\n${frame ?? ''}`));
    socket.on('data', data => {
      response += data;
      if (response.includes('\r\n\r\n')) {
        if (frame && response.startsWith('HTTP/1.1 101')) {
          const payload = response.slice(response.indexOf('\r\n\r\n') + 4);
          if (!payload.includes(frame)) return;
        }
        socket.destroy(); resolve(response);
      }
    });
  });
}

before(async () => {
  core = http.createServer((req, res) => {
    calls.push({ path: req.url, headers: req.headers, method: req.method });
    if (req.url === '/install.sh' && req.headers['x-bb-enrollment'] !== 'test-enrollment-key') {
      res.writeHead(403); return res.end();
    }
    if (req.url.startsWith('/internal/') && req.url !== '/internal/hosts/enroll-key' && req.headers.authorization !== 'Bearer actual-test-host-key') {
      res.writeHead(401); return res.end();
    }
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'untrusted=core', 'access-control-allow-origin': '*', location: `http://127.0.0.1:${corePort}/next` });
    res.end(JSON.stringify({ ok: true }));
  });
  core.on('upgrade', (req, socket, head) => {
    calls.push({ path: req.url, headers: req.headers, method: req.method });
    if (req.url.startsWith('/internal/') && req.headers.authorization !== 'Bearer actual-test-host-key') return socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: test-accept\r\nSec-WebSocket-Protocol: bb-host-daemon.v1\r\n\r\n');
    if (head.length) socket.write(head);
    socket.on('data', c => socket.write(c));
    socket.on('error', () => {});
    socket.on('end', () => socket.destroy());
  });
  corePort = await listen(core);
  gateway = createGateway({ origin, password, corePort });
  port = await listen(gateway);
});

after(async () => {
  gateway.closeAllConnections(); core.closeAllConnections();
  await Promise.all([new Promise(r => gateway.close(r)), new Promise(r => core.close(r))]);
});

test('configuration pins HTTPS origin and loopback port only', () => {
  assert.throws(() => configFromEnv({ BB_GATEWAY_ORIGIN: 'http://evil.test', BB_CORE_PORT: '38886', BB_GATEWAY_OWNER_PASSWORD: password }));
  assert.throws(() => configFromEnv({ BB_GATEWAY_ORIGIN: origin + '/', BB_CORE_PORT: '38886', BB_GATEWAY_OWNER_PASSWORD: password }));
  assert.throws(() => configFromEnv({ BB_GATEWAY_ORIGIN: origin, BB_CORE_PORT: '0', BB_GATEWAY_OWNER_PASSWORD: password }));
  assert.equal(configFromEnv({ BB_GATEWAY_ORIGIN: origin, BB_CORE_PORT: '38886', BB_GATEWAY_OWNER_PASSWORD: password }).listenPort, 8080);
});

test('no metadata identity, public owner API, alternate host, URL credentials or absolute forwarding', async () => {
  const count = calls.length;
  for (const [path, headers, expected] of [
    ['/api/v1/hosts', {}, 401],
    ['/api/v1/hosts', { 'x-vercel-id': 'anything', 'x-bb-gate-auth': 'session', 'x-forwarded-for': '127.0.0.1' }, 401],
    ['/', { host: 'other.example.test' }, 421],
    ['/?token=secret', {}, 400],
    ['/?hostKey=secret', {}, 400],
    ['http://evil.example.test/', {}, 400],
    ['//evil.example.test/', {}, 400],
    ['/internal/../api/v1/hosts', {}, 400],
    ['/internal%2fhosts/enroll', {}, 400],
    ['/api/v1/hosts', { authorization: 'Bearer actual-test-host-key' }, 403],
    ['/internal/hosts/enroll-key', { authorization: 'Bearer actual-test-host-key' }, 403],
    ['/internal/server-move/pending', { authorization: 'Bearer actual-test-host-key' }, 403],
  ]) assert.equal((await request(path, { headers })).status, expected, path);
  assert.equal(calls.length, count);
});

test('owner login requires exact origin, password in body and hardened session cookie', async () => {
  assert.equal((await request('/_gateway/login')).status, 200);
  const body = new URLSearchParams({ password }).toString();
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  assert.equal((await request('/_gateway/login', { method: 'POST', body, headers })).status, 403);
  assert.equal((await request('/_gateway/login', { method: 'POST', body, headers: { ...headers, origin: 'https://evil.test' } })).status, 403);
  assert.equal((await request('/_gateway/login', { method: 'POST', body: 'password=wrong', headers: { ...headers, origin } })).status, 401);
  const response = await request('/_gateway/login', { method: 'POST', body, headers: { ...headers, origin } });
  assert.equal(response.status, 303);
  assert.match(response.headers['set-cookie'][0], /; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600$/);
  cookie = response.headers['set-cookie'][0].split(';')[0];
});

test('authenticated owner dispatch rewrites trusted target, strips identities and controls mutations', async () => {
  const headers = { cookie, origin, 'x-bb-gate-auth': 'machine', 'x-vercel-forwarded-for': 'spoof', 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'http', 'x-bb-gate-machine-id': 'spoof' };
  const response = await request('/api/v1/hosts', { headers });
  assert.equal(response.status, 200);
  const call = calls.at(-1);
  assert.equal(call.headers.host, `127.0.0.1:${corePort}`);
  assert.equal(call.headers.origin, origin);
  for (const key of ['cookie', 'x-bb-gate-auth', 'x-bb-gate-machine-id', 'x-vercel-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']) assert.equal(call.headers[key], undefined);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers.location, `${origin}/next`);
  assert.equal((await request('/api/v1/hosts', { method: 'POST', headers: { cookie } })).status, 403);
  assert.equal((await request('/api/v1/hosts', { method: 'POST', headers: { cookie, origin: 'null' } })).status, 403);
  assert.equal((await request('/api/v1/hosts', { headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await request('/api/v1/hosts', { method: 'POST', headers })).status, 200);
  assert.equal((await request('/internal/hosts/enroll-key', { method: 'POST', headers })).status, 200);
  assert.equal((await request('/internal/hosts/enroll-key/', { method: 'POST', headers })).status, 403);
});

test('exact native methods/routes preserve real core Bearer verification including both skill operations', async () => {
  const hash = 'a'.repeat(64);
  const cases = [
    ['POST', '/internal/hosts/enroll'], ['POST', '/internal/session/open'],
    ['POST', '/internal/session/events'], ['POST', '/internal/session/tool-call'],
    ['POST', '/internal/session/interactive-request'], ['POST', '/internal/session/interactive-request/interrupt'],
    ['GET', '/internal/session/project-attachment-content?sessionId=test&path=file'],
    ['GET', `/internal/skills/tree/${hash}`], ['POST', `/internal/skills/tree/${hash}/content`],
    ['GET', `/internal/plugins/example/host/${hash}`],
  ];
  for (const [method, path] of cases) {
    assert.equal((await request(path, { method })).status, 401, path);
    assert.equal((await request(path, { method, headers: { authorization: 'Bearer invalid' } })).status, 401, path);
    assert.equal((await request(path, { method, headers: { authorization: 'Bearer actual-test-host-key', 'x-bb-gate-auth': 'session' } })).status, 200, path);
    assert.equal(calls.at(-1).headers.authorization, 'Bearer actual-test-host-key');
    assert.equal(calls.at(-1).headers['x-bb-gate-auth'], undefined);
    assert.equal((await request(path, { method, headers: { cookie, authorization: 'Bearer actual-test-host-key' } })).status, 403, path);
  }
  assert.equal(nativeRoute('GET', `/internal/skills/tree/${hash}/content`), false);
  assert.equal(nativeRoute('POST', `/internal/skills/tree/${hash}`), false);
  assert.equal(nativeRoute('GET', `/internal/skills/tree/${hash}/extra`), false);
});

test('installer bootstrap requires actual core-validated enrollment and artifacts are not public', async () => {
  for (const path of ['/install.sh', '/install/version', '/install/bb-app.tgz']) {
    assert.equal((await request(path)).status, 401);
  }
  assert.equal((await request('/install.sh', { headers: { 'x-bb-enrollment': 'wrong' } })).status, 403);
  assert.equal((await request('/install.sh', { headers: { 'x-bb-enrollment': 'test-enrollment-key' } })).status, 200);
  assert.equal(calls.at(-1).headers['x-bb-enrollment'], 'test-enrollment-key');
  assert.equal((await request('/install.sh', { headers: { 'x-bb-enrollment': 'test-enrollment-key', cookie } })).status, 403);
  assert.equal((await request('/install/bb-app.tgz', { headers: { 'x-bb-enrollment': 'test-enrollment-key' } })).status, 401);
});

test('real UI and native websocket headers survive while unauthorized upgrades never reach core', async () => {
  const before = calls.length;
  assert.match(await ws('/ws'), /^HTTP\/1.1 401/);
  assert.match(await ws('/ws', { cookie }), /^HTTP\/1.1 403/);
  assert.match(await ws('/ws', { cookie, origin: 'https://evil.test' }), /^HTTP\/1.1 403/);
  assert.match(await ws('/unknown', { cookie, origin }), /^HTTP\/1.1 403/);
  assert.match(await ws('/internal/ws?sessionId=test', { authorization: 'Bearer actual-test-host-key' }), /^HTTP\/1.1 400/);
  assert.equal(calls.length, before);
  assert.match(await ws('/ws', { cookie, origin }), /^HTTP\/1.1 101/);
  assert.equal(calls.at(-1).headers.origin, origin);
  assert.equal(calls.at(-1).headers['sec-websocket-key'], 'dGhlIHNhbXBsZSBub25jZQ==');
  assert.match(await ws('/ws/terminals/term_example?sinceSeq=0&outputAcks=1', { cookie, origin }), /^HTTP\/1.1 101/);
  assert.match(await ws('/internal/ws?sessionId=test', { authorization: 'Bearer invalid', 'sec-websocket-protocol': 'bb-host-daemon.v1' }), /^HTTP\/1.1 401/);
  const response = await ws('/internal/ws?sessionId=test', { authorization: 'Bearer actual-test-host-key', 'sec-websocket-protocol': 'bb-host-daemon.v1' });
  assert.match(response, /^HTTP\/1.1 101/);
  assert.match(response, /sec-websocket-protocol: bb-host-daemon.v1/);
  const echoed = await ws('/ws', { cookie, origin }, 'test-upgrade-head-bytes');
  assert.match(echoed, /test-upgrade-head-bytes$/);
});

test('logout revokes owner session', async () => {
  assert.equal((await request('/_gateway/logout', { method: 'POST', headers: { cookie, origin } })).status, 204);
  assert.equal((await request('/', { headers: { cookie } })).status, 401);
});
