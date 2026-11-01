import test from 'node:test';
import assert from 'node:assert/strict';
import { validateScope, validateClaims, assertIdentity } from './cloud.mjs';
const scope = { accountId: 'user_a', teamId: 'team_b', projectId: 'prj_c' };
const token = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
test('pinned scope rejects query/path injection and missing identity', () => {
  assert.equal(validateScope(scope), scope);
  for (const key of Object.keys(scope)) for (const value of [undefined, '', 'bad/name', 'a?teamId=other']) assert.throws(() => validateScope({ ...scope, [key]: value }));
});
test('issued token must match project/team and remain usable', () => {
  const claims = { owner_id: scope.teamId, project_id: scope.projectId, exp: Date.now() / 1000 + 600 };
  validateClaims(token(claims), scope);
  for (const changed of [{ owner_id: 'other' }, { project_id: 'other' }, { exp: 0 }]) assert.throws(() => validateClaims(token({ ...claims, ...changed }), scope));
});
test('operations fence the original named resource and session', () => {
  const record = { name: 'original', sessionId: 'session-a' };
  assertIdentity(record, { name: 'original', currentSession: () => ({ sessionId: 'session-a' }) });
  assert.throws(() => assertIdentity(record, { name: 'different', currentSession: () => ({ sessionId: 'session-a' }) }));
  assert.throws(() => assertIdentity(record, { name: 'original', currentSession: () => ({ sessionId: 'replacement' }) }));
  const uncertain = { name: 'original', role: 'control', allocationId: 'generation-a' };
  const owned = { name: 'original', tags: { purpose: 'cloud-bb-poc', role: 'control', allocation: 'generation-a' } };
  assertIdentity(uncertain, owned);
  assert.throws(() => assertIdentity(uncertain, { ...owned, tags: { ...owned.tags, allocation: 'other-generation' } }));
  assert.throws(() => assertIdentity({ name: 'original' }, owned));
});
