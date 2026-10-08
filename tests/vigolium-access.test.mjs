import assert from 'node:assert/strict';
import test from 'node:test';
import { accessContext, accessMonitor, verifyAccessControls } from '../scripts/vigolium-access.mjs';
import { createRewindTarget } from '../scripts/vigolium-rewind-target.mjs';
import { disposableTarget, redact, scopedProxy } from '../scripts/vigolium-provider.mjs';

test('four-identity access controls exercise real backend boundaries through exact scoped routes', async () => {
  const target = await createRewindTarget({ endpoint: 'access' });
  const seed = disposableTarget({ ...target, disposable: true });
  const secrets = Object.values(seed.access.actors).map((actor) => actor.token);
  secrets.push(seed.access.usedCode, seed.access.freshCode);
  const monitor = accessMonitor(seed.access, secrets);
  const proxy = await scopedProxy(seed.origin, seed.access.paths, {
    interval: 0,
    observe: monitor.observe,
  });
  try {
    assert.equal(monitor.summary().complete, false);
    await verifyAccessControls(seed.access, proxy.origin);
    const summary = monitor.summary();
    assert.equal(summary.complete, true, JSON.stringify(summary.checks));
    assert.equal(summary.probes.length, 16);
    assert.equal((await fetch(proxy.origin + '/auth/login')).status, 403);
    assert.equal((await fetch(proxy.origin + seed.path + '?groupId=other')).status, 403);
    assert.equal(
      (await fetch(proxy.origin + seed.access.paths[2], { method: 'DELETE' })).status,
      403,
    );
    assert.ok(!JSON.stringify(summary).includes(seed.token));
    for (const secret of secrets)
      assert.ok(!redact(JSON.stringify(seed.access), secrets).includes(secret));
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('missing probes and unexpected successes cannot pass the coverage gate or be erased by a later denial', () => {
  const actors = Object.fromEntries(
    ['owner', 'member', 'outsider', 'invitee'].map((name) => [
      name,
      { token: name, accountId: name },
    ]),
  );
  const context = accessContext(
    {
      groupId: 'group-one',
      otherGroupId: 'group-two',
      actors,
      usedCode: 'USED-CODE',
      freshCode: 'FRESH-CODE',
    },
    '/realtime/groups/group-one/messages',
  );
  const monitor = accessMonitor(context, []);
  const probe = {
    method: 'GET',
    path: context.paths[0],
    authorization: 'Bearer outsider',
    requestBody: '',
    responseBody: '{}',
  };
  monitor.observe({ ...probe, status: 200 });
  monitor.observe({ ...probe, status: 403 });
  assert.equal(monitor.summary().checks.outsiderReadDenied.status, 'failed');
  assert.equal(monitor.summary().complete, false);
  assert.equal(monitor.summary().checks.wrongGroupAcceptanceDenied.status, 'not-tested');
  const spoof = {
    method: 'POST',
    path: context.paths[3],
    authorization: 'Bearer invitee',
    requestBody: JSON.stringify({
      code: context.freshCode,
      groupId: context.groupId,
      accountId: 'owner',
      role: 'owner',
    }),
    status: 200,
    responseBody: JSON.stringify({ status: 'accepted', group: { group: { role: 'owner' } } }),
  };
  monitor.observe(spoof);
  assert.equal(monitor.summary().checks.spoofedIdentityAndRoleRejected.status, 'failed');
  assert.throws(() => accessContext({ ...context, otherGroupId: 'group-one' }, context.paths[0]));
  assert.throws(() =>
    accessContext({ ...context, actors: { ...actors, member: actors.owner } }, context.paths[0]),
  );
});
