import { Sandbox } from '@vercel/sandbox';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function validateScope(scope) {
  for (const key of ['accountId', 'teamId', 'projectId']) {
    if (typeof scope[key] !== 'string' || !/^[A-Za-z0-9_]+$/.test(scope[key])) throw Error('Invalid pinned scope');
  }
  return scope;
}

export function validateClaims(token, scope) {
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  if (claims.owner_id !== scope.teamId || claims.project_id !== scope.projectId || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp * 1000 < Date.now() + 60000) throw Error('OIDC scope or expiry mismatch');
}

function vc(endpoint, method = 'GET') {
  const env = { ...process.env, CI: '1', NO_COLOR: '1', VERCEL_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' };
  for (const key of Object.keys(env)) {
    if (/^(VERCEL_TOKEN|VERCEL_AUTH_TOKEN|VERCEL_OIDC_TOKEN|VERCEL_AUTH_CONFIG_DIR|DEBUG|DEBUG_FETCH|NODE_OPTIONS|NODE_DEBUG|FORCE_TTY|AI_AGENT|CURSOR_TRACE_ID|CURSOR_AGENT|CODEX_SANDBOX|CODEX_CI|CODEX_THREAD_ID|CLAUDECODE|CLAUDE_CODE|OPENCODE_CLIENT)$/.test(key)) delete env[key];
  }
  const result = spawnSync('vc', ['api', endpoint, '--method', method, '--raw', '--api', 'https://api.vercel.com', '--non-interactive', '--no-color'], { env, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw Error(`Pinned Vercel CLI request failed (status ${result.status}, ${result.error?.code ?? 'process exit'}); no login attempted`);
  return JSON.parse(result.stdout);
}

export async function credentials(scope) {
  validateScope(scope);
  if (vc('/v2/user').user?.id !== scope.accountId) throw Error('Vercel account mismatch');
  const { token } = vc(`/v1/projects/${scope.projectId}/token?source=vercel-oidc-refresh&teamId=${scope.teamId}`, 'POST');
  validateClaims(token, scope);
  if (vc('/v2/user').user?.id !== scope.accountId) throw Error('Vercel account changed');
  return { token: 'poc-private-transport', teamId: scope.teamId, projectId: scope.projectId, fetch: scopedTransport(token, scope) };
}

export function scopedTransport(token, scope, send = fetch) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://vercel.com' || url.searchParams.get('teamId') !== scope.teamId) throw Error('Sandbox transport scope mismatch');
    const mutation = (init.method ?? 'GET') !== 'GET';
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    try {
      const response = await send(input, { ...init, headers, redirect: 'error' });
      if (mutation && (response.status === 429 || response.status >= 500)) throw Error('Uncertain mutation');
      return response;
    } catch (error) {
      if (mutation) throw new DOMException('Mutation outcome uncertain; inspect original allocation, never resubmit', 'AbortError');
      throw error;
    }
  };
}

export async function atomicSave(file, state) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    await rename(temporary, file);
    const directory = await open(dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function withJournalLock(file, run) {
  const lockPath = `${file}.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw Error('Allocation journal is locked; do not run concurrent operations or discard a live lock'); throw error; }
  try { await lock.writeFile(`${process.pid}\n`); return await run(); }
  finally { await lock.close(); await unlink(lockPath); }
}

export function assertIdentity(record, sandbox) {
  if (sandbox.name !== record.name || (record.sessionId && sandbox.currentSession().sessionId !== record.sessionId)) throw Error('Original allocation identity mismatch');
  if (!record.sessionId && (!record.allocationId || sandbox.tags?.allocation !== record.allocationId || sandbox.tags?.purpose !== 'cloud-bb-poc' || sandbox.tags?.role !== record.role)) throw Error('Uncertain allocation ownership could not be verified');
}

export async function stopOriginal(record, scope, transport, save) {
  if (!record.sessionId) throw Error('No original session; inspect named allocation first');
  const endpoint = `https://vercel.com/api/v2/sandboxes/sessions/${encodeURIComponent(record.sessionId)}`;
  const query = `?teamId=${scope.teamId}`;
  const request = async stop => {
    const res = await transport(`${endpoint}${stop ? '/stop' : ''}${query}`, { method: stop ? 'POST' : 'GET', ...(stop ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}), signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw Error('Original session stop/observation failed; 404 is not stop proof');
    const { session } = await res.json();
    if (session.id !== record.sessionId || session.projectId !== scope.projectId || session.sourceSandboxName !== record.name) throw Error('Original session ownership mismatch');
    return session;
  };
  record.stopIntentAt ??= new Date().toISOString(); await save();
  let session = await request(false);
  if (session.status !== 'stopped') {
    await request(true); record.stopAcknowledgedAt = new Date().toISOString(); await save();
    session = await request(false);
  }
  record.lastObservedStatus = session.status; record.lastObservedAt = new Date().toISOString(); await save();
  if (session.status !== 'stopped') throw Error('Stop requested but not observed stopped; retain journal and inspect original session');
  record.phase = 'stopped'; record.stoppedObservedAt = new Date().toISOString(); await save();
}

async function main() {
  const [action, statePath, role, ...args] = process.argv.slice(2);
  if (!statePath) throw Error('Usage: cloud.mjs init|create|inspect|upload|exec|stop|delete STATE [control|worker] [arguments]');
  const file = resolve(statePath);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const save = state => atomicSave(file, state);
  return withJournalLock(file, async () => {
  if (action === 'init') {
    const scope = validateScope(JSON.parse(await readFile(role, 'utf8')));
    const state = { scope: { accountId: scope.accountId, teamId: scope.teamId, projectId: scope.projectId }, createdAt: new Date().toISOString(), limits: { vcpusEach: 1, minutesEach: 60, replacement: false }, resources: {} };
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log('Initialized secret-free allocation journal'); return;
  }
  if (!['control', 'worker'].includes(role)) throw Error('Expected control or worker role');
  const state = JSON.parse(await readFile(file, 'utf8'));
  const auth = await credentials(state.scope);
  if (action === 'create') {
    if (state.resources[role]) throw Error('Allocation was already requested; inspect original, never retry create');
    const name = `cloud-bb-poc-${role}-${randomUUID().slice(0, 12)}`;
    const record = state.resources[role] = { name, role, allocationId: randomUUID(), phase: 'requested', requestedAt: new Date().toISOString(), vcpus: 1, timeoutMs: 3600000 };
    await save(state);
    try {
      const sandbox = await Sandbox.create({ ...auth, name, tags: { purpose: 'cloud-bb-poc', role, allocation: record.allocationId }, image: 'vercel/sandbox/universal:latest', persistent: false, resources: { vcpus: 1 }, timeout: 3600000, ports: role === 'control' ? [8080] : [], signal: AbortSignal.timeout(180000) });
      Object.assign(record, { phase: 'accepted', sessionId: sandbox.currentSession().sessionId, status: sandbox.status, image: sandbox.image, acceptedAt: new Date().toISOString(), expiresAt: sandbox.expiresAt?.toISOString() ?? null, url: role === 'control' ? sandbox.domain(8080) : null });
      await save(state);
      console.log(JSON.stringify(record));
    } catch {
      record.phase = 'uncertain'; await save(state);
      throw Error('Create did not return a verified identity. Inspect original named resource; no retry is authorized.');
    }
    return;
  }
  const record = state.resources[role];
  if (!record) throw Error('No original allocation recorded');
  if (action === 'stop') {
    await stopOriginal(record, state.scope, auth.fetch, () => save(state));
    console.log(JSON.stringify(record)); return;
  }
  if (action === 'delete' && (!record.stoppedObservedAt || record.phase !== 'stopped')) throw Error('Metadata deletion requires recorded original-session stop proof');
  const sandbox = await Sandbox.get({ ...auth, name: record.name, resume: false, signal: AbortSignal.timeout(60000) });
  assertIdentity(record, sandbox);
  if (!record.sessionId) {
    record.sessionId = sandbox.currentSession().sessionId;
    await save(state);
  }
  const session = sandbox.currentSession();
  if (action === 'delete') {
    await sandbox.delete({ signal: AbortSignal.timeout(60000) });
    record.phase = 'metadata-deleted'; record.metadataDeletedAt = new Date().toISOString();
    await save(state); console.log(JSON.stringify(record)); return;
  }
  if (action === 'inspect') {
    Object.assign(record, { phase: sandbox.status === 'running' ? 'live' : record.phase, lastObservedStatus: sandbox.status, lastObservedAt: new Date().toISOString(), expiresAt: sandbox.expiresAt?.toISOString() ?? null, url: role === 'control' ? sandbox.domain(8080) : null });
    await save(state); console.log(JSON.stringify(record)); return;
  }
  if (sandbox.status !== 'running') throw Error('Original session is not running; no implicit resume');
  if (action === 'upload') {
    if (args.length !== 2 || !args[1].startsWith('/')) throw Error('upload LOCAL_FILE ABSOLUTE_REMOTE_FILE');
    await session.writeFiles([{ path: args[1], content: await readFile(args[0]), mode: 0o600 }], { signal: AbortSignal.timeout(60000) });
    console.log('Uploaded private file without displaying contents'); return;
  }
  if (action === 'exec') {
    if (!args.length) throw Error('exec COMMAND [ARGS...]; never pass secret values');
    const command = await session.runCommand({ cmd: args[0], args: args.slice(1), timeoutMs: 300000, signal: AbortSignal.timeout(310000) });
    process.stdout.write(await command.stdout()); process.stderr.write(await command.stderr());
    process.exitCode = command.exitCode; return;
  }
  throw Error('Unknown action');
  });
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) main().catch(error => { console.error(error.message); process.exitCode = 1; });
