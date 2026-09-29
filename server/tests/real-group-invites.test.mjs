import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { createRealAccount } = await import('../dist/auth/index.js');

async function withRuntime(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-real-group-invite-test-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
    REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true',
  });
  const database = openDatabase(config);
  let clock = new Date('2026-09-28T00:00:00.000Z');
  const server = createRuntimeServer(config, database, { now: () => new Date(clock) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ baseUrl, database, setNow: (value) => (clock = new Date(value)) });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

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
  const auth = await response.json();
  return { account: created.account, authorization: `Bearer ${auth.token}`, token: auth.token };
}

async function createGroupAndInvite(baseUrl, owner) {
  const createdGroup = await fetch(`${baseUrl}/real/groups`, {
    method: 'POST',
    headers: { Authorization: owner.authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Private group', prompt: 'A moment?', maxMembers: 4 }),
  });
  assert.equal(createdGroup.status, 201);
  const { group } = await createdGroup.json();
  const createdInvite = await fetch(`${baseUrl}/real/groups/${group.id}/invites`, {
    method: 'POST',
    headers: { Authorization: owner.authorization, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(createdInvite.status, 201);
  return { group, invite: (await createdInvite.json()).invite };
}

test('real owner can create an expiring invite through an authenticated real-group session', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const owner = await provision(baseUrl, database, 'real-invite-owner');
    const createdGroup = await fetch(`${baseUrl}/real/groups`, {
      method: 'POST',
      headers: { Authorization: owner.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Private group', prompt: 'A moment?', maxMembers: 4 }),
    });
    assert.equal(createdGroup.status, 201);
    const { group } = await createdGroup.json();

    const signedOut = await fetch(`${baseUrl}/real/groups/${group.id}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(signedOut.status, 401);

    const response = await fetch(`${baseUrl}/real/groups/${group.id}/invites`, {
      method: 'POST',
      headers: { Authorization: owner.authorization, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.match(body.invite.code, /^[A-Z]{3}-[A-Z]{3}$/);
    assert.equal(body.invite.groupId, group.id);
    assert.equal(body.invite.status, 'active');
    assert.equal(
      Date.parse(body.invite.expiresAt) - Date.parse(body.invite.createdAt),
      24 * 60 * 60 * 1000,
    );
    assert.equal(JSON.stringify(body).includes(owner.token), false);
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT group_id AS groupId, owner_account_id AS ownerAccountId, code, created_at AS createdAt,
                  expires_at AS expiresAt FROM real_group_invites WHERE id = ?`,
          )
          .get(body.invite.id),
      },
      {
        groupId: group.id,
        ownerAccountId: owner.account.id,
        code: body.invite.code.replace('-', ''),
        createdAt: body.invite.createdAt,
        expiresAt: body.invite.expiresAt,
      },
    );

    const invalidExpiry = await fetch(`${baseUrl}/real/groups/${group.id}/invites`, {
      method: 'POST',
      headers: { Authorization: owner.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresInSeconds: 60 }),
    });
    assert.equal(invalidExpiry.status, 400);
  });
});

test('only the owner can revoke an active short code; revoked codes cannot be accepted', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const owner = await provision(baseUrl, database, 'revoke-owner');
    const recipient = await provision(baseUrl, database, 'revoke-recipient');
    const { group, invite } = await createGroupAndInvite(baseUrl, owner);
    const path = `${baseUrl}/real/groups/${group.id}/invites/${invite.id}`;

    const unauthorized = await fetch(path, {
      method: 'DELETE',
      headers: { Authorization: recipient.authorization },
    });
    assert.equal(unauthorized.status, 404);

    const revoked = await fetch(path, {
      method: 'DELETE',
      headers: { Authorization: owner.authorization },
    });
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json()).revoked, true);

    const accepted = await fetch(`${baseUrl}/real/invites/accept`, {
      method: 'POST',
      headers: { Authorization: recipient.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: invite.code }),
    });
    assert.equal(accepted.status, 400);
    assert.equal((await accepted.json()).status, 'expired');
    assert.equal(
      database
        .prepare('SELECT 1 FROM real_group_memberships WHERE group_id = ? AND account_id = ?')
        .get(group.id, recipient.account.id),
      undefined,
    );
  });
});

test('real invite joins the session account, changes selected group, and rejects replay', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const owner = await provision(baseUrl, database, 'invite-accept-owner');
    const recipient = await provision(baseUrl, database, 'invite-accept-recipient');
    const { group, invite } = await createGroupAndInvite(baseUrl, owner);

    const response = await fetch(`${baseUrl}/real/invites/accept`, {
      method: 'POST',
      headers: { Authorization: recipient.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: ` ${invite.code.toLowerCase()} `,
        groupId: group.id,
        accountId: owner.account.id,
      }),
    });
    assert.equal(response.status, 200);
    const accepted = await response.json();
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.group.group.id, group.id);
    assert.equal(accepted.group.group.role, 'member');
    assert.equal(
      database
        .prepare(
          'SELECT account_id AS accountId FROM real_group_memberships WHERE group_id = ? AND role = ?',
        )
        .get(group.id, 'member').accountId,
      recipient.account.id,
      'the bearer session, not body.accountId, determines the new member',
    );
    assert.equal(
      database
        .prepare(
          'SELECT group_id AS groupId FROM real_account_group_selections WHERE account_id = ?',
        )
        .get(recipient.account.id).groupId,
      group.id,
    );
    const listing = await fetch(`${baseUrl}/real/groups`, {
      headers: { Authorization: recipient.authorization },
    });
    assert.deepEqual(
      (await listing.json()).groups.map((entry) => entry.group.id),
      [group.id],
    );
    const metadata = await fetch(`${baseUrl}/real/groups/${group.id}`, {
      headers: { Authorization: recipient.authorization },
    });
    assert.equal(metadata.status, 200);

    const secondGroupResponse = await fetch(`${baseUrl}/real/groups`, {
      method: 'POST',
      headers: { Authorization: owner.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Another group', prompt: 'Another moment?', maxMembers: 4 }),
    });
    assert.equal(secondGroupResponse.status, 201);
    const secondGroup = (await secondGroupResponse.json()).group;
    const secondInviteResponse = await fetch(`${baseUrl}/real/groups/${secondGroup.id}/invites`, {
      method: 'POST',
      headers: { Authorization: owner.authorization, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const secondInvite = (await secondInviteResponse.json()).invite;
    const secondJoin = await fetch(`${baseUrl}/real/invites/accept`, {
      method: 'POST',
      headers: { Authorization: recipient.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: secondInvite.code }),
    });
    assert.equal(secondJoin.status, 200);
    const switchBack = await fetch(`${baseUrl}/real/groups/current`, {
      method: 'POST',
      headers: { Authorization: recipient.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: group.id }),
    });
    assert.equal(switchBack.status, 200);
    assert.equal((await switchBack.json()).group.group.id, group.id);

    const replay = await fetch(`${baseUrl}/real/invites/accept`, {
      method: 'POST',
      headers: { Authorization: recipient.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: invite.code }),
    });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).status, 'replayed');
  });
});

test('real invite acceptance keeps legacy eight-character codes working', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const owner = await provision(baseUrl, database, 'legacy-invite-owner');
    const recipient = await provision(baseUrl, database, 'legacy-invite-recipient');
    const { group } = await createGroupAndInvite(baseUrl, owner);
    const legacyCode = 'A1B2C3D4';
    database
      .prepare(
        `INSERT INTO real_group_invites
          (id, group_id, owner_account_id, code, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-real-invite',
        group.id,
        owner.account.id,
        legacyCode,
        '2026-09-28T00:00:00.000Z',
        '2026-09-29T00:00:00.000Z',
      );
    const accepted = await fetch(`${baseUrl}/real/invites/accept`, {
      method: 'POST',
      headers: { Authorization: recipient.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: ' a1b2 c3d4 ' }),
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).group.group.id, group.id);
  });
});

test('real invite acceptance reports malformed and expired invitations safely', async () => {
  await withRuntime(async ({ baseUrl, database, setNow }) => {
    const owner = await provision(baseUrl, database, 'invite-status-owner');
    const recipient = await provision(baseUrl, database, 'invite-status-recipient');
    const { group } = await createGroupAndInvite(baseUrl, owner);
    const malformed = await fetch(`${baseUrl}/real/invites/accept`, {
      method: 'POST',
      headers: { Authorization: recipient.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'bad!' }),
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).status, 'malformed');

    const response = await fetch(`${baseUrl}/real/groups/${group.id}/invites`, {
      method: 'POST',
      headers: { Authorization: owner.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresInSeconds: 300 }),
    });
    assert.equal(response.status, 201);
    const expiredInvite = (await response.json()).invite;
    setNow('2026-09-28T00:05:00.000Z');
    const expired = await fetch(`${baseUrl}/real/invites/accept`, {
      method: 'POST',
      headers: { Authorization: recipient.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: expiredInvite.code }),
    });
    assert.equal(expired.status, 400);
    assert.equal((await expired.json()).status, 'expired');
    assert.equal(
      database
        .prepare('SELECT status FROM real_group_invites WHERE code = ?')
        .get(expiredInvite.code.replace('-', '')).status,
      'expired',
    );
  });
});

test('real invite code guessing is durably rate limited by account and source', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const recipient = await provision(baseUrl, database, 'invite-throttle-recipient');
    const guess = () =>
      fetch(`${baseUrl}/real/invites/accept`, {
        method: 'POST',
        headers: { Authorization: recipient.authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'AAAAAAAA' }),
      });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await guess();
      assert.equal(response.status, 400);
      assert.equal((await response.json()).status, 'malformed');
    }
    const limited = await guess();
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).status, 'throttled');
    assert.deepEqual(
      database
        .prepare('SELECT scope, attempts FROM real_invite_guess_throttles ORDER BY scope')
        .all()
        .map((row) => ({ ...row })),
      [
        { scope: 'account', attempts: 10 },
        { scope: 'source', attempts: 10 },
      ],
    );
  });
});

test('an unrelated real account cannot read or select a private group by changing group IDs', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const owner = await provision(baseUrl, database, 'invite-scope-owner');
    const stranger = await provision(baseUrl, database, 'invite-scope-stranger');
    const { group } = await createGroupAndInvite(baseUrl, owner);

    const metadata = await fetch(`${baseUrl}/real/groups/${group.id}?groupId=${group.id}`, {
      headers: { Authorization: stranger.authorization },
    });
    assert.equal(metadata.status, 404);
    assert.equal((await metadata.json()).error, 'forbidden');

    const selected = await fetch(`${baseUrl}/real/groups/current?groupId=${group.id}`, {
      method: 'POST',
      headers: { Authorization: stranger.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: group.id, accountId: owner.account.id }),
    });
    assert.equal(selected.status, 404);
    assert.equal((await selected.json()).error, 'forbidden');
    assert.equal(
      database
        .prepare('SELECT 1 FROM real_group_memberships WHERE group_id = ? AND account_id = ?')
        .get(group.id, stranger.account.id),
      undefined,
    );
  });
});
