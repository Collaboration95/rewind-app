import assert from 'node:assert/strict';
import test from 'node:test';
import { withRuntime as withSharedRuntime } from './helpers/runtime.mjs';

const { createRealAccount } = await import('../dist/auth/index.js');

const withRuntime = (run) => {
  const now = new Date('2026-09-28T00:00:00.000Z');
  return withSharedRuntime(
    {
      prefix: 'rewind-real-group-profiles-test-',
      env: { REWIND_PORT: '0', REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true' },
      serverOptions: { now: () => now },
    },
    run,
  );
};

async function provision(baseUrl, database, username) {
  const created = await createRealAccount(
    database,
    username,
    username,
    'a sufficiently long pilot password',
    new Date('2026-09-28T00:00:00.000Z'),
  );
  assert.equal(created.ok, true);
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'a sufficiently long pilot password',
      clientType: 'native',
    }),
  });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  return { account: created.account, authorization: `Bearer ${token}` };
}

async function createGroup(baseUrl, owner, name) {
  const response = await fetch(`${baseUrl}/real/groups`, {
    method: 'POST',
    headers: { Authorization: owner.authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, prompt: 'A moment?', maxMembers: 5 }),
  });
  assert.equal(response.status, 201);
  return await response.json();
}

async function invite(baseUrl, owner, groupId) {
  const response = await fetch(`${baseUrl}/real/groups/${groupId}/invites`, {
    method: 'POST',
    headers: { Authorization: owner.authorization, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 201);
  return (await response.json()).invite;
}

async function accept(baseUrl, member, code) {
  const response = await fetch(`${baseUrl}/real/invites/accept`, {
    method: 'POST',
    headers: { Authorization: member.authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(response.status, 200);
}

test('member summaries follow the selected group and include only joined profiles', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const ownerA = await provision(baseUrl, database, 'profile-owner-ada');
    const ownerB = await provision(baseUrl, database, 'profile-owner-cy');
    const member = await provision(baseUrl, database, 'profile-member-bea');
    const groupA = await createGroup(baseUrl, ownerA, 'Saturday table');
    const groupB = await createGroup(baseUrl, ownerB, 'Garden circle');
    const groupAInvite = await invite(baseUrl, ownerA, groupA.group.id);
    const groupBInvite = await invite(baseUrl, ownerB, groupB.group.id);
    const pendingAInvite = await invite(baseUrl, ownerA, groupA.group.id);
    await accept(baseUrl, member, groupAInvite.code);
    await accept(baseUrl, member, groupBInvite.code);

    const groupBMembers = await fetch(`${baseUrl}/real/groups/${groupB.group.id}/members`, {
      headers: { Authorization: member.authorization },
    });
    assert.equal(groupBMembers.status, 200);
    assert.deepEqual(await groupBMembers.json(), {
      group: { id: groupB.group.id, name: 'Garden circle' },
      members: [
        {
          memberId: database
            .prepare(
              'SELECT profile_id AS id FROM real_group_memberships WHERE account_id = ? AND group_id = ?',
            )
            .get(ownerB.account.id, groupB.group.id).id,
          displayName: 'profile-owner-cy',
          role: 'owner',
          joinedAt: '2026-09-28T00:00:00.000Z',
        },
        {
          memberId: database
            .prepare(
              'SELECT profile_id AS id FROM real_group_memberships WHERE account_id = ? AND group_id = ?',
            )
            .get(member.account.id, groupB.group.id).id,
          displayName: 'profile-member-bea',
          role: 'member',
          joinedAt: '2026-09-28T00:00:00.000Z',
        },
      ],
      pendingInviteCount: 0,
    });

    const switchGroup = await fetch(`${baseUrl}/real/groups/current`, {
      method: 'POST',
      headers: { Authorization: member.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: groupA.group.id }),
    });
    assert.equal(switchGroup.status, 200);
    assert.equal((await switchGroup.json()).group.group.id, groupA.group.id);
    const groupAMembers = await fetch(`${baseUrl}/real/groups/${groupA.group.id}/members`, {
      headers: { Authorization: member.authorization },
    });
    assert.equal(groupAMembers.status, 200);
    assert.deepEqual(await groupAMembers.json(), {
      group: { id: groupA.group.id, name: 'Saturday table' },
      members: [
        {
          memberId: database
            .prepare(
              'SELECT profile_id AS id FROM real_group_memberships WHERE account_id = ? AND group_id = ?',
            )
            .get(ownerA.account.id, groupA.group.id).id,
          displayName: 'profile-owner-ada',
          role: 'owner',
          joinedAt: '2026-09-28T00:00:00.000Z',
        },
        {
          memberId: database
            .prepare(
              'SELECT profile_id AS id FROM real_group_memberships WHERE account_id = ? AND group_id = ?',
            )
            .get(member.account.id, groupA.group.id).id,
          displayName: 'profile-member-bea',
          role: 'member',
          joinedAt: '2026-09-28T00:00:00.000Z',
        },
      ],
      pendingInviteCount: 1,
    });
    assert.equal(pendingAInvite.status, 'active');
  });
});

test('an unrelated or unauthenticated account cannot read real group member summaries', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const owner = await provision(baseUrl, database, 'profile-private-owner');
    const outsider = await provision(baseUrl, database, 'profile-private-outsider');
    const group = await createGroup(baseUrl, owner, 'Private table');

    const denied = await fetch(
      `${baseUrl}/real/groups/${group.group.id}/members?accountId=${owner.account.id}`,
      { headers: { Authorization: outsider.authorization } },
    );
    assert.equal(denied.status, 404);
    assert.equal((await denied.json()).error, 'forbidden');

    const signedOut = await fetch(`${baseUrl}/real/groups/${group.group.id}/members`);
    assert.equal(signedOut.status, 401);
  });
});
