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
  const server = createRuntimeServer(config, database, {
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ baseUrl, database });
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
    'Real Owner',
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
    assert.match(body.invite.code, /^[A-Z0-9]{8}$/);
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
        code: body.invite.code,
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
