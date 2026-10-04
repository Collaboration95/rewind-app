import assert from 'node:assert/strict';
import test from 'node:test';
import { disposableTarget } from '../scripts/vigolium-provider.mjs';
import { createRewindTarget } from '../scripts/vigolium-rewind-target.mjs';

test('external seed excludes arbitrary origins, endpoints and header injection', () => {
  const seed = {
    disposable: true,
    origin: 'http://127.0.0.1:32100',
    path: '/realtime/groups/test-group/messages',
    token: 'temporary-token',
  };
  assert.equal(disposableTarget(seed).origin, seed.origin);
  for (const invalid of [
    { disposable: false },
    { origin: 'https://example.com' },
    { origin: 'http://127.0.0.1:32100/private' },
    { origin: 'http://user:pass@127.0.0.1:32100' },
    { path: '/auth/login' },
    { path: seed.path + '?other=1' },
    { token: 'token\r\nInjected: header' },
  ])
    assert.throws(() => disposableTarget({ ...seed, ...invalid }));
});

test('disposable real backend validates owner, anonymous and outsider boundaries', async () => {
  const target = await createRewindTarget();
  try {
    assert.deepEqual(target.baselines, {
      login: 200,
      groupCreation: 201,
      ownerPost: 201,
      ownerRead: 200,
      anonymousRead: 401,
      outsiderRead: 403,
      outsiderPost: 403,
    });
    assert.ok(!JSON.stringify(target.baselines).includes(target.token));
    const response = await fetch(target.origin + target.path, {
      headers: { Authorization: `Bearer ${target.token}` },
    });
    assert.equal(response.status, 200);
    await response.text();
  } finally {
    await target.close();
  }
  await assert.rejects(fetch(target.origin + target.path));
});
