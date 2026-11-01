import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicSave, withJournalLock, scopedTransport, stopOriginal, validateClaims } from './cloud.mjs';

const scope = { teamId: 'team_test', projectId: 'prj_test' };
const record = () => ({ name: 'original-name', sessionId: 'original-session', phase: 'live' });
const response = (status, original = record()) => Response.json({ session: { id: original.sessionId, sourceSandboxName: original.name, projectId: scope.projectId, status } });

test('journal updates are atomic and concurrent operations are refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloud-poc-journal-'));
  const file = join(root, 'state.json');
  try {
    await atomicSave(file, { resources: { control: 'original' } });
    await withJournalLock(file, async () => {
      await assert.rejects(withJournalLock(file, async () => assert.fail('must not enter')), /locked/);
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { resources: { control: 'original' } });
      await atomicSave(file, { resources: { control: 'original', worker: 'original-worker' } });
    });
    await withJournalLock(file, async () => assert.equal(JSON.parse(await readFile(file, 'utf8')).resources.worker, 'original-worker'));
    await assert.rejects(withJournalLock(file, async () => { throw Error('interrupted operation'); }), /interrupted/);
    await withJournalLock(file, async () => {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('credential-bearing transport forbids redirects, preserves scope, never retries mutations', async () => {
  let calls = 0;
  const send = async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.get('authorization'), 'Bearer synthetic-token');
    return new Response('', { status: 503 });
  };
  const transport = scopedTransport('synthetic-token', scope, send);
  await assert.rejects(transport('https://vercel.com/api/test?teamId=team_test', { method: 'POST' }), { name: 'AbortError' });
  assert.equal(calls, 1);
  await assert.rejects(transport('https://other.invalid/api?teamId=team_test'), /scope mismatch/);
  await assert.rejects(transport('https://vercel.com/api?teamId=wrong'), /scope mismatch/);
  assert.equal(calls, 1);
});

test('missing and nonnumeric OIDC expiries are rejected', () => {
  for (const exp of [undefined, null, 'invalid', '999999999999']) {
    const token = 'h.' + Buffer.from(JSON.stringify({ owner_id: scope.teamId, project_id: scope.projectId, exp })).toString('base64url') + '.s';
    assert.throws(() => validateClaims(token, scope), /expiry mismatch/);
  }
});

test('stop acknowledgement cannot replace a separate stopped observation', async () => {
  const original = record();
  const methods = [];
  const snapshots = [];
  const states = ['running', 'stopped', 'stopping'];
  const transport = async (url, options) => { methods.push(options.method); return response(states.shift()); };
  await assert.rejects(stopOriginal(original, scope, transport, async () => snapshots.push(structuredClone(original))), /not observed stopped/);
  assert.deepEqual(methods, ['GET', 'POST', 'GET']);
  assert.ok(original.stopAcknowledgedAt);
  assert.equal(original.stoppedObservedAt, undefined);
  assert.equal(original.phase, 'live');
  assert.ok(snapshots[0].stopIntentAt);
});

test('fresh stopped proof retains original identity and is durable before cleanup', async () => {
  const original = record();
  const states = ['running', 'stopping', 'stopped'];
  const saves = [];
  await stopOriginal(original, scope, async () => response(states.shift()), async () => saves.push(structuredClone(original)));
  assert.equal(original.phase, 'stopped');
  assert.equal(original.sessionId, 'original-session');
  assert.ok(saves.at(-1).stoppedObservedAt);
});

test('a missing session or different generation never establishes stopped proof', async () => {
  for (const transport of [async () => new Response('', { status: 404 }), async () => response('stopped', { name: 'original-name', sessionId: 'replacement-session' })]) {
    const original = record();
    await assert.rejects(stopOriginal(original, scope, transport, async () => {}));
    assert.equal(original.phase, 'live');
    assert.equal(original.stoppedObservedAt, undefined);
    assert.equal(original.sessionId, 'original-session');
  }
});
