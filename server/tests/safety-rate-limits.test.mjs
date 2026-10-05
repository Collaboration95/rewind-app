import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { createRealAccount } = await import('../dist/auth/index.js');
const { createRealGroup } = await import('../dist/groups/real.js');
const PASSWORD = 'a sufficiently long test password';

async function runtime(run, env = {}) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-safety-limits-`);
  const config = parseConfig({
    REWIND_HOST: '127.0.0.1',
    REWIND_DATA_DIR: dataDir,
    REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true',
    ...env,
  });
  const database = openDatabase(config);
  let time = new Date('2026-09-10T12:00:00Z');
  const server = createRuntimeServer(config, database, { now: () => time });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body = {}, headers = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const user = async (name) => {
    const created = await createRealAccount(database, name, name, PASSWORD, time);
    assert.equal(created.ok, true);
    const login = await post('/auth/login', {
      username: name,
      password: PASSWORD,
      clientType: 'native',
    });
    assert.equal(login.status, 200);
    return {
      account: created.account,
      headers: { Authorization: `Bearer ${(await login.json()).token}` },
    };
  };
  const group = async (user) => {
    const response = await post(
      '/real/groups',
      { name: 'Test group', prompt: 'A moment?', maxMembers: 5 },
      user.headers,
    );
    assert.equal(response.status, 201);
    return (await response.json()).group.id;
  };
  try {
    await run({
      base,
      post,
      user,
      group,
      database,
      config,
      advance: (ms) => {
        time = new Date(time.getTime() + ms);
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
async function limited(response) {
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.error, 'rate_limited');
  assert.ok(body.message.length > 0);
}

test('chat token buckets allow thirty messages, refuse the next and refill independently by account', async () => {
  await runtime(async ({ post, user, group, advance }) => {
    const first = await user('chat-rate-one');
    const groupId = await group(first);
    const path = `/realtime/groups/${groupId}/messages`;
    for (let i = 0; i < 30; i++)
      assert.equal((await post(path, { body: `message ${i}` }, first.headers)).status, 201);
    await limited(await post(path, { body: 'too soon' }, first.headers));
    const second = await user('chat-rate-two');
    const otherGroup = await group(second);
    assert.equal(
      (
        await post(
          `/realtime/groups/${otherGroup}/messages`,
          { body: 'independent' },
          second.headers,
        )
      ).status,
      201,
    );
    advance(2000);
    assert.equal((await post(path, { body: 'refilled' }, first.headers)).status, 201);
  });
});

test('group creation has a five/day bucket and a durable maximum of twenty owned groups', async () => {
  await runtime(async ({ post, user, group, database }) => {
    const owner = await user('group-rate-owner');
    for (let i = 0; i < 5; i++) await group(owner);
    await limited(
      await post('/real/groups', { name: 'Sixth', prompt: '?', maxMembers: 5 }, owner.headers),
    );
    const capped = await user('group-cap-owner');
    for (let i = 0; i < 20; i++)
      assert.ok(
        createRealGroup(
          database,
          capped.account,
          { name: `Group ${i}`, prompt: '?', maxMembers: 5 },
          new Date('2026-09-10T12:00:00Z'),
        ),
      );
    const response = await post(
      '/real/groups',
      { name: 'Twenty first', prompt: '?', maxMembers: 5 },
      capped.headers,
    );
    await limited(response);
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS n FROM real_group_metadata WHERE owner_account_id = ?')
        .get(capped.account.id).n,
      20,
    );
  });
});

test('reports and blocks share twenty requests per ten minutes for one account', async () => {
  await runtime(async ({ post, user, group, database, advance }) => {
    const owner = await user('safety-rate-owner');
    const member = await user('safety-rate-member');
    const groupId = await group(owner);
    const invite = await post(`/real/groups/${groupId}/invites`, {}, owner.headers).then((r) =>
      r.json(),
    );
    assert.equal(
      (await post('/real/invites/accept', { code: invite.invite.code }, member.headers)).status,
      200,
    );
    const profileId = database
      .prepare('SELECT id FROM real_profiles WHERE account_id = ?')
      .get(owner.account.id).id;
    for (let i = 0; i < 10; i++)
      assert.equal(
        (await post(`/real/groups/${groupId}/reports`, { memberId: profileId }, member.headers))
          .status,
        201,
      );
    for (let i = 0; i < 10; i++)
      assert.equal((await post('/real/blocks', { profileId }, member.headers)).status, 201);
    await limited(await post('/real/blocks', { profileId }, member.headers));
    advance(30_000);
    assert.equal(
      (await post(`/real/groups/${groupId}/reports`, { memberId: profileId }, member.headers))
        .status,
      201,
    );
  });
});

test('five chat streams per account, sixth refused, disconnected stream releases its slot', async () => {
  await runtime(async ({ base, user, group }) => {
    const owner = await user('stream-rate-owner');
    const groupId = await group(owner);
    const url = `${base}/realtime/groups/${groupId}/events?startFromLatest=true`;
    const streams = [];
    try {
      for (let i = 0; i < 5; i++) {
        const response = await fetch(url, { headers: owner.headers });
        assert.equal(response.status, 200);
        streams.push(response);
      }
      await limited(await fetch(url, { headers: owner.headers }));
      await streams.shift().body.cancel();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const replacement = await fetch(url, { headers: owner.headers });
      assert.equal(replacement.status, 200);
      streams.push(replacement);
    } finally {
      await Promise.all(streams.map((r) => r.body.cancel()));
    }
  });
});
