import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const COOKIE = '__Host-bb-owner';
const SESSION_MS = 60 * 60 * 1000;
const SAFE = new Set(['GET', 'HEAD']);
const REQUEST_HEADERS = new Set([
  'accept', 'accept-encoding', 'accept-language', 'content-type', 'content-length',
  'range', 'if-range', 'if-none-match', 'if-modified-since', 'prefer',
  'x-bb-app-surface', 'x-bb-plugin-token', 'x-bb-plugin-rpc-caller',
  'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol',
  'sec-websocket-extensions',
]);
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade']);
const digest = value => createHash('sha256').update(value).digest();

export function nativeRoute(method, path, upgrade = false) {
  if (upgrade) return method === 'GET' && path === '/internal/ws';
  if (method === 'POST') {
    return new Set([
      '/internal/hosts/enroll', '/internal/session/open', '/internal/session/events',
      '/internal/session/tool-call', '/internal/session/interactive-request',
      '/internal/session/interactive-request/interrupt',
    ]).has(path) || /^\/internal\/skills\/tree\/[a-f0-9]{64}\/content$/.test(path);
  }
  return method === 'GET' && (
    path === '/internal/session/project-attachment-content' ||
    /^\/internal\/skills\/tree\/[a-f0-9]{64}$/.test(path) ||
    /^\/internal\/plugins\/[a-zA-Z0-9._-]+\/host\/[a-f0-9]{64}$/.test(path)
  );
}

export function configFromEnv(env = process.env) {
  const port = (name, fallback) => {
    const raw = env[name] ?? fallback;
    if (!/^\d+$/.test(raw ?? '') || Number(raw) < 1 || Number(raw) > 65535) {
      throw new Error(`${name} must be a port in 1..65535`);
    }
    return Number(raw);
  };
  const origin = new URL(env.BB_GATEWAY_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== env.BB_GATEWAY_ORIGIN) {
    throw new Error('BB_GATEWAY_ORIGIN must be an exact HTTPS origin');
  }
  const password = env.BB_GATEWAY_OWNER_PASSWORD;
  if (typeof password !== 'string' || [...password].length < 12) {
    throw new Error('BB_GATEWAY_OWNER_PASSWORD must be a unique temporary password of at least 12 characters');
  }
  const corePort = port('BB_CORE_PORT');
  const listenPort = port('BB_GATEWAY_PORT', '8080');
  if (corePort === listenPort) throw new Error('Gateway and core ports must differ');
  return { origin: origin.origin, password, corePort, listenPort };
}

function parseTarget(raw) {
  if (!raw?.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x20\x7f#]/.test(raw)) throw new Error('Invalid target');
  const rawPath = raw.split('?')[0];
  const decoded = decodeURIComponent(rawPath);
  if (decoded.includes('\\') || decoded.includes('%') || decoded.split('/').some(p => p === '.' || p === '..') || /%2f/i.test(rawPath)) throw new Error('Ambiguous path');
  const url = new URL(raw, 'http://gateway.invalid');
  for (const key of url.searchParams.keys()) {
    if (/token|password|secret|credential|authorization|(?:^|[-_])key$|hostkey|enrollkey/i.test(key)) throw new Error('Credentials must not appear in URLs');
  }
  return url;
}

async function smallBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new Error('Body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createGateway(config) {
  const origin = new URL(config.origin);
  const coreOrigin = `http://127.0.0.1:${config.corePort}`;
  const passwordHash = digest(config.password);
  const sessions = new Map();
  const upgradedSockets = new Set();
  let loginWindow = 0;
  let loginAttempts = 0;
  const server = http.createServer({ maxHeaderSize: 32768, requestTimeout: 120000 });

  function sessionFor(req) {
    const cookies = (req.headers.cookie ?? '').split(';').map(c => c.trim()).filter(c => c.startsWith(`${COOKIE}=`));
    if (cookies.length !== 1) return null;
    const id = cookies[0].slice(COOKIE.length + 1);
    const session = sessions.get(id);
    if (!session || session.expires <= Date.now()) return null;
    return { ...session, id };
  }

  function browserAllowed(req, requireOrigin) {
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return false;
    return req.headers.origin === config.origin || (!requireOrigin && req.headers.origin === undefined);
  }

  function classify(req, upgrade) {
    const url = parseTarget(req.url);
    if (req.headers.host !== origin.host) return { status: 421 };
    if (url.pathname.startsWith('/_gateway/')) return { local: true, url };
    if (url.pathname === '/install.sh' && req.method === 'GET' && !upgrade && req.headers['x-bb-enrollment'] !== undefined) {
      if (req.headers.origin !== undefined || req.headers.cookie !== undefined || req.headers.authorization !== undefined) return { status: 403 };
      if (!/^\S{1,8192}$/.test(req.headers['x-bb-enrollment'])) return { status: 401 };
      return { role: 'enrollment', url };
    }
    const native = nativeRoute(req.method, url.pathname, upgrade);
    if (native) {
      if (req.headers.origin !== undefined || req.headers.cookie !== undefined) return { status: 403 };
      if (!/^Bearer \S+$/.test(req.headers.authorization ?? '')) return { status: 401 };
      if (upgrade && (req.headers['sec-websocket-protocol'] !== 'bb-host-daemon.v1' || !url.searchParams.get('sessionId'))) return { status: 400 };
      return { role: 'native', url };
    }
    if (req.headers.authorization !== undefined) return { status: 403 };
    const session = sessionFor(req);
    if (!session) return {
      status: 401,
      loginRedirect: !upgrade && req.method === 'GET' && url.pathname === '/' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document' && /\btext\/html\b/i.test(req.headers.accept ?? ''),
    };
    if (!browserAllowed(req, upgrade || !SAFE.has(req.method))) return { status: 403 };
    if (url.pathname.startsWith('/internal/') && !(req.method === 'POST' && url.pathname === '/internal/hosts/enroll-key' && !upgrade)) return { status: 403 };
    if (upgrade && !(url.pathname === '/ws' || /^\/ws\/terminals\/[a-zA-Z0-9_-]+$/.test(url.pathname) || /^\/api\/v1\/plugins\/[^/]+\/http(?:\/|$)/.test(url.pathname))) return { status: 403 };
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) return { status: 405 };
    return { role: 'owner', session, url };
  }

  function requestHeaders(req, role, upgrade) {
    const headers = { host: `127.0.0.1:${config.corePort}` };
    const nominated = new Set((req.headers.connection ?? '').toLowerCase().split(',').map(s => s.trim()));
    for (const [key, value] of Object.entries(req.headers)) {
      if (REQUEST_HEADERS.has(key) && !nominated.has(key)) headers[key] = value;
    }
    if (role === 'native') headers.authorization = req.headers.authorization;
    if (role === 'enrollment') headers['x-bb-enrollment'] = req.headers['x-bb-enrollment'];
    if (role === 'owner' && req.headers.origin) headers.origin = config.origin;
    if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
    return headers;
  }

  function responseHeaders(res, upgrade = false) {
    const nominated = new Set((res.headers.connection ?? '').toLowerCase().split(',').map(s => s.trim()));
    const headers = {};
    for (const [key, value] of Object.entries(res.headers)) {
      if (!HOP.has(key) && !nominated.has(key) && key !== 'set-cookie' && !key.startsWith('access-control-')) headers[key] = value;
    }
    headers['cache-control'] = 'no-store';
    headers['referrer-policy'] = 'no-referrer';
    headers['x-content-type-options'] = 'nosniff';
    if (headers.location?.startsWith(coreOrigin)) headers.location = config.origin + headers.location.slice(coreOrigin.length);
    if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
    return headers;
  }

  function reply(res, status, body = '') {
    res.writeHead(status, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
    res.end(body);
  }

  async function local(req, res, url) {
    if (url.search) return reply(res, 400);
    if (url.pathname === '/_gateway/login' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
      return res.end('<!doctype html><title>BB owner login</title><form method="post" action="/_gateway/login"><label>Temporary owner password <input type="password" name="password" autocomplete="current-password" required></label><button>Log in</button></form>');
    }
    if (req.method !== 'POST' || !browserAllowed(req, true)) return reply(res, 403);
    if (url.pathname === '/_gateway/logout') {
      const session = sessionFor(req);
      if (!session) return reply(res, 401);
      clearTimeout(session.timer);
      for (const socket of session.sockets) socket.destroy();
      sessions.delete(session.id);
      res.setHeader('set-cookie', `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
      return reply(res, 204);
    }
    if (url.pathname !== '/_gateway/login') return reply(res, 404);
    if (Date.now() - loginWindow > 60000) { loginWindow = Date.now(); loginAttempts = 0; }
    if (++loginAttempts > 10) return reply(res, 429);
    if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') return reply(res, 415);
    const params = new URLSearchParams(await smallBody(req));
    if (params.getAll('password').length !== 1 || !timingSafeEqual(digest(params.get('password')), passwordHash)) return reply(res, 401);
    if (sessions.size >= 32) return reply(res, 429);
    const id = randomBytes(32).toString('base64url');
    const sockets = new Set();
    const timer = setTimeout(() => { sessions.delete(id); for (const socket of sockets) socket.destroy(); }, SESSION_MS);
    timer.unref();
    sessions.set(id, { expires: Date.now() + SESSION_MS, sockets, timer });
    res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'set-cookie': `${COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600` });
    res.end();
  }

  server.on('request', async (req, res) => {
    try {
      const decision = classify(req, false);
      if (decision.loginRedirect) {
        res.writeHead(303, { location: '/_gateway/login', 'cache-control': 'no-store', 'referrer-policy': 'same-origin' });
        return res.end();
      }
      if (decision.status) return reply(res, decision.status);
      if (decision.local) return await local(req, res, decision.url);
      const upstream = http.request({ hostname: '127.0.0.1', port: config.corePort, method: req.method, path: req.url, headers: requestHeaders(req, decision.role, false) }, incoming => {
        res.writeHead(incoming.statusCode, responseHeaders(incoming));
        incoming.on('error', () => res.destroy());
        incoming.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) reply(res, 502); else res.destroy(); });
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    } catch { if (!res.headersSent) reply(res, 400); else res.destroy(); }
  });

  server.on('upgrade', (req, socket, head) => {
    upgradedSockets.add(socket);
    socket.on('close', () => upgradedSockets.delete(socket));
    const reject = status => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    try {
      const decision = classify(req, true);
      if (decision.status || decision.local || req.headers.upgrade?.toLowerCase() !== 'websocket') return reject(decision.status ?? 403);
      const upstream = http.request({ hostname: '127.0.0.1', port: config.corePort, method: 'GET', path: req.url, headers: requestHeaders(req, decision.role, true) });
      let peer;
      if (decision.session) decision.session.sockets.add(socket);
      const cleanup = () => { decision.session?.sockets.delete(socket); upstream.destroy(); peer?.destroy(); };
      socket.on('close', cleanup);
      socket.on('error', cleanup);
      upstream.on('error', () => { if (!socket.destroyed) reject(502); });
      upstream.on('response', incoming => {
        socket.write(`HTTP/1.1 ${incoming.statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        incoming.resume(); socket.end();
      });
      upstream.on('upgrade', (incoming, remote, remoteHead) => {
        peer = remote;
        if (socket.destroyed) return remote.destroy();
        const headers = responseHeaders(incoming, true);
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
        if (remoteHead.length) socket.write(remoteHead);
        if (head.length) remote.write(head);
        remote.on('error', () => socket.destroy());
        remote.on('close', () => socket.destroy());
        socket.pipe(remote).pipe(socket);
      });
      upstream.end();
    } catch { reject(400); }
  });
  server.on('close', () => { for (const s of sessions.values()) { clearTimeout(s.timer); for (const socket of s.sockets) socket.destroy(); } });
  server.shutdown = () => {
    server.close();
    server.closeAllConnections();
    for (const socket of upgradedSockets) socket.destroy();
  };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configFromEnv();
  const server = createGateway(config);
  server.listen(config.listenPort, '0.0.0.0', () => console.log(`BB gateway listening on :${config.listenPort}; fixed core 127.0.0.1:${config.corePort}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.shutdown());
}
