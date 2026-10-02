import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createRuntimeServer } from '../dist/http.js';
import { createRealAccount } from '../dist/auth/index.js';
import { createRealGroup } from '../dist/groups/real.js';
import { migrateDatabase, schemaReadiness } from '../dist/db.js';
import { withIntentFixture } from './helpers/upload-intents.mjs';

async function apiFixture(run) {
  await withIntentFixture(async (c) => {
    const origin = 'https://intent-fixture.example',
      secret = 'synthetic-intent-proxy-secret';
    const config = {
      ...c.config,
      host: '127.0.0.1',
      port: 0,
      allowOrigin: origin,
      originAuthSecret: secret,
    };
    const proxy = { Origin: origin, 'x-rewind-origin-auth': secret, 'x-forwarded-proto': 'https' };
    const server = createRuntimeServer(config, c.database, {
      now: () => c.now,
      mediaStore: c.deps.store,
      mediaEnvironment: 'test',
      uploadIntents: c.deps,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      async function account(username) {
        const created = await createRealAccount(
          c.database,
          username,
          username,
          'synthetic upload intent password',
          c.now,
        );
        assert.equal(created.ok, true);
        const login = await fetch(base + '/auth/login', {
          method: 'POST',
          headers: { ...proxy, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username,
            password: 'synthetic upload intent password',
            clientType: 'native',
          }),
        });
        assert.equal(login.status, 200);
        return { account: created.account, token: (await login.json()).token };
      }
      const owner = await account('http-intent-owner'),
        outsider = await account('http-intent-outsider');
      const group = createRealGroup(
        c.database,
        owner.account,
        { name: 'HTTP intent group', prompt: 'Live media', maxMembers: 3 },
        c.now,
      );
      const path = `/real/groups/${group.group.id}/upload-intents`;
      const request = (person, suffix = '', method = 'GET', body, headers = {}) =>
        fetch(base + path + suffix, {
          method,
          headers: {
            ...proxy,
            Authorization: `Bearer ${person.token}`,
            'Content-Type': 'application/json',
            ...headers,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      await run({ ...c, base, owner, outsider, group, path, request, proxy });
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
}

test('real HTTPS-policy JSON request→direct PUT→complete→process is idempotent and denies outsider/forged identity', async () =>
  apiFixture(async (c) => {
    const input = c.input('http-intent-key');
    assert.equal((await c.request(c.outsider, '', 'POST', input)).status, 403);
    assert.equal(
      (await c.request(c.owner, '', 'POST', { ...input, accountId: c.outsider.account.id })).status,
      400,
    );
    assert.equal((await c.request(c.owner, '?sessionId=forged', 'POST', input)).status, 403);
    assert.equal(
      (await c.request(c.owner, '', 'POST', input, { Origin: 'https://outsider.example' })).status,
      403,
    );
    assert.equal(
      (await c.request(c.owner, '', 'POST', input, { 'x-rewind-origin-auth': 'wrong' })).status,
      403,
    );
    const response = await c.request(c.owner, '', 'POST', input);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const first = await response.json();
    assert.equal(first.intent.state, 'open');
    assert.equal(JSON.stringify(first).includes(c.owner.token), false);
    const replay = await (await c.request(c.owner, '', 'POST', input)).json();
    assert.equal(replay.intent.id, first.intent.id);
    assert.equal((await c.request(c.outsider, '/' + first.intent.id)).status, 403);
    assert.equal(
      (await c.request(c.owner, '/' + first.intent.id + '/complete', 'POST', { versionId: 'null' }))
        .status,
      400,
    );
    const version = await c.put(first.upload);
    const complete = await c.request(c.owner, '/' + first.intent.id + '/complete', 'POST', {
      versionId: version,
    });
    assert.equal(complete.status, 200);
    const registered = (await complete.json()).intent;
    assert.equal(registered.state, 'completed');
    assert.equal(registered.versionId, version);
    const duplicate = await (
      await c.request(c.owner, '/' + first.intent.id + '/complete', 'POST', { versionId: version })
    ).json();
    assert.equal(duplicate.intent.jobId, registered.jobId);
    const replacementVersion = await c.put(first.upload);
    assert.equal(
      (
        await c.request(c.owner, '/' + first.intent.id + '/complete', 'POST', {
          versionId: replacementVersion,
        })
      ).status,
      409,
    );
    const processed = await fetch(
      c.base + `/contributions/jobs/${registered.jobId}/process?groupId=${c.group.group.id}`,
      { method: 'POST', headers: { ...c.proxy, Authorization: `Bearer ${c.owner.token}` } },
    );
    assert.equal(processed.status, 200);
    assert.equal(
      c.database.prepare('SELECT status FROM media_jobs WHERE id=?').get(registered.jobId).status,
      'ready',
    );
    const status = await (await c.request(c.owner, '/' + first.intent.id)).json();
    assert.equal(status.intent.jobId, registered.jobId);
    assert.equal(JSON.stringify(status).includes('media-object:'), false);
    assert.equal(
      c.database
        .prepare('SELECT count(*) AS n FROM contributions WHERE id=?')
        .get(registered.contributionId).n,
      1,
    );
    assert.equal(
      c.database
        .prepare('SELECT count_used AS n FROM contribution_quota_windows WHERE member_id=?')
        .get(registered.profileId).n,
      1,
    );
  }));

test('upload-intent HTTP rechecks closure/quota and uses actual canonical fresh/repair migration', async () =>
  apiFixture(async (c) => {
    const originalEnds = c.group.cycle.endsAt;
    c.database.prepare('UPDATE cycles SET max_count=1 WHERE id=?').run(c.group.cycle.id);
    const first = await (await c.request(c.owner, '', 'POST', c.input('http-quota-key-1'))).json();
    assert.equal(first.intent.state, 'open');
    assert.equal((await c.request(c.owner, '', 'POST', c.input('http-quota-key-2'))).status, 409);
    const version = await c.put(first.upload);
    c.database.prepare("UPDATE cycles SET status='revealing' WHERE id=?").run(c.group.cycle.id);
    assert.equal(
      (
        await c.request(c.owner, '/' + first.intent.id + '/complete', 'POST', {
          versionId: version,
        })
      ).status,
      409,
    );
    assert.equal(
      c.database
        .prepare('SELECT count(*) AS n FROM contributions WHERE cycle_id=?')
        .get(c.group.cycle.id).n,
      0,
    );
    assert.equal(
      c.database.prepare('SELECT ends_at AS endsAt FROM cycles WHERE id=?').get(c.group.cycle.id)
        .endsAt,
      originalEnds,
    );
    assert.equal(schemaReadiness(c.database).expectedMigrationVersion, 27);
    assert.equal(schemaReadiness(c.database).ready, true);
    c.database.prepare('DELETE FROM upload_intents WHERE group_id=?').run(c.group.group.id);
    c.database.exec('DROP TABLE upload_intents');
    migrateDatabase(c.database);
    assert.equal(schemaReadiness(c.database).ready, true);
    assert.equal(c.database.prepare('SELECT count(*) AS n FROM upload_intents').get().n, 0);
  }));
