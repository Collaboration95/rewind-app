import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { parseConfig } from '../dist/config.js';
import { createRuntimeServer } from '../dist/http.js';
import { createRealAccount, revokeRealSession } from '../dist/auth/index.js';
import { purgeRealAccount } from '../dist/auth/deletion.js';
import { createRealGroup } from '../dist/groups/real.js';
import { createRealGroupInvite, acceptRealGroupInvite } from '../dist/groups/invites.js';
import { encodeMediaRef } from '../dist/media/store.js';
import {
  publishCycleRelease,
  publishCycleReleaseWithStore,
  advanceCycleLifecycleWithStore,
  PREMIERE_DURATION_MS,
} from '../dist/cycles/index.js';
import { s3Double, s3Store } from './helpers/private-media-store.mjs';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';
const NOW = new Date('2026-10-02T12:00:00Z');
const ORIGIN = 'https://archive-fixture.example';
const proxy = {
  'x-rewind-origin-auth': 'synthetic-archive-proxy-secret',
  'x-forwarded-proto': 'https',
  Origin: ORIGIN,
};

async function fixture(run, remote = false) {
  const root = await mkdtemp(`${tmpdir()}/rewind-real-archive-`);
  const config = parseConfig({
    REWIND_DATA_DIR: root,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
    REWIND_ORIGIN_AUTH_SECRET: proxy['x-rewind-origin-auth'],
    REWIND_ALLOW_ORIGIN: ORIGIN,
  });
  const database = openFixtureDatabase(config),
    double = s3Double(),
    store = s3Store(double);
  let clock = NOW;
  const server = createRuntimeServer(config, database, {
    now: () => clock,
    ...(remote ? { mediaStore: store, mediaEnvironment: 'test' } : {}),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function account(username, cookie = false) {
    const created = await createRealAccount(
      database,
      username,
      username,
      'synthetic archive fixture password',
      NOW,
    );
    assert.equal(created.ok, true);
    const response = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { ...proxy, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password: 'synthetic archive fixture password',
        clientType: cookie ? 'browser' : 'native',
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    return {
      account: created.account,
      token: body.token,
      headers: cookie
        ? { Cookie: response.headers.get('set-cookie').split(';')[0] }
        : { Authorization: `Bearer ${body.token}` },
    };
  }
  try {
    const owner = await account('archive-owner'),
      member = await account('archive-member', true),
      outsider = await account('archive-outsider');
    const group = createRealGroup(
      database,
      owner.account,
      { name: 'Private Archive', prompt: 'A memory', maxMembers: 3 },
      NOW,
    );
    const invite = createRealGroupInvite(
      database,
      group.group.id,
      owner.account.id,
      undefined,
      NOW,
    );
    assert.equal(invite.ok, true);
    const accepted = acceptRealGroupInvite(
      database,
      member.account,
      invite.invite.code,
      undefined,
      NOW,
    );
    assert.equal(accepted.ok, true);
    const memberId = database
      .prepare(
        'SELECT profile_id AS id FROM real_group_memberships WHERE account_id=? AND group_id=?',
      )
      .get(member.account.id, group.group.id).id;
    const bytes = await readFile(new URL('../fixtures/sample-clip.mp4', import.meta.url));
    const sha = createHash('sha256').update(bytes).digest('hex');
    await mkdir(root + '/media/processed', { recursive: true });
    async function output(name, prefix) {
      if (remote)
        return encodeMediaRef(
          await store.put(
            { environment: 'test', groupId: group.group.id },
            {
              prefix,
              name,
              body: Readable.from([bytes]),
              sha256: sha,
              byteLength: bytes.length,
              contentType: 'video/mp4',
            },
          ),
        );
      const path = root + '/media/processed/' + name + '.mp4';
      await writeFile(path, bytes);
      return path;
    }
    const filmPath = await output('archive-film', 'films');
    database
      .prepare(
        `INSERT INTO media_jobs(id,group_id,kind,status,cycle_id,output_path,created_at,output_sha256,output_bytes,output_verified_at) VALUES('archive-film',?,'film','ready',?,?,?,?,?,?)`,
      )
      .run(
        group.group.id,
        group.cycle.id,
        filmPath,
        NOW.toISOString(),
        sha,
        bytes.length,
        NOW.toISOString(),
      );
    for (const [id, profile] of [
      ['owner-clip', group.memberId],
      ['member-clip', memberId],
    ]) {
      const path = await output(id, 'processed');
      database
        .prepare(
          'INSERT INTO contributions(id,cycle_id,member_id,duration_seconds,created_at) VALUES(?,?,?,1,?)',
        )
        .run(id, group.cycle.id, profile, NOW.toISOString());
      database
        .prepare(
          `INSERT INTO media_jobs(id,group_id,kind,status,contribution_id,output_path,created_at,output_sha256,output_bytes,output_verified_at) VALUES(?,?,'clip','ready',?,?,?,?,?,?)`,
        )
        .run(id, group.group.id, id, path, NOW.toISOString(), sha, bytes.length, NOW.toISOString());
    }
    const request = (person, path, init = {}) =>
      fetch(base + path, { ...init, headers: { ...proxy, ...person?.headers, ...init.headers } });
    const scoped = (path) => path + '?groupId=' + group.group.id;
    const publish = () =>
      database
        .prepare(
          "UPDATE cycles SET status='revealing',release_status='published',release_published_at=? WHERE id=?",
        )
        .run(NOW.toISOString(), group.cycle.id);
    await run({
      database,
      root,
      base,
      group,
      owner,
      member,
      outsider,
      request,
      scoped,
      publish,
      bytes,
      filmPath,
      double,
      store,
      setClock: (value) => (clock = value),
    });
  } finally {
    await new Promise((done) => server.close(done));
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('real Archive seals media until release and scopes films/own clips to live selected membership', async () =>
  fixture(async (c) => {
    const { request, scoped, publish, group, owner, member, outsider, bytes, database, filmPath } =
      c;
    assert.equal((await request(owner, scoped('/films/archive-film/play'))).status, 404);
    assert.equal((await request(owner, scoped('/films/archive-film'))).status, 404);
    const receipt = await (await request(owner, scoped('/clips/owner-clip'))).json();
    assert.deepEqual(receipt, { clip: { id: 'owner-clip', status: 'ready' } });
    assert.equal((await request(member, scoped('/clips/owner-clip'))).status, 404);
    assert.equal((await request(member, scoped('/clips/member-clip/download'))).status, 404);
    assert.deepEqual((await (await request(owner, scoped('/archive'))).json()).archive, {
      films: [],
      clips: [],
    });
    assert.equal(
      (await (await request(owner, scoped(`/cycles/${group.cycle.id}/premiere`))).json()).premiere
        .state,
      'locked',
    );
    publish();
    for (const person of [owner, member]) {
      const response = await request(person, scoped('/archive'));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
      const body = await response.json();
      assert.equal(body.archive.films.length, 1);
      assert.equal(body.archive.clips.length, 1);
      assert.equal(body.archive.clips[0].id, person === owner ? 'owner-clip' : 'member-clip');
      const encoded = JSON.stringify(body);
      assert.equal(encoded.includes(filmPath), false);
      assert.equal(encoded.includes(owner.token), false);
      assert.equal(encoded.includes('sessionId'), false);
      const play = body.archive.films[0].playbackPath;
      assert.match(play, /^\/media\/access\/[A-Za-z0-9_-]{43}$/);
      const head = await request(null, play, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), String(bytes.length));
      assert.equal((await head.arrayBuffer()).byteLength, 0);
      const range = await request(null, play, { headers: { Range: 'bytes=0-15' } });
      assert.equal(range.status, 206);
      assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 16));
      assert.equal((await request(outsider, play)).status, 404);
      assert.equal(
        (await request(null, play, { headers: { Range: 'bytes=999999999-' } })).status,
        416,
      );
      const filmDownload = await request(person, body.archive.films[0].downloadPath);
      assert.equal(filmDownload.status, 200);
      assert.match(filmDownload.headers.get('content-disposition'), /rewind-group-film/);
      assert.equal(filmDownload.headers.get('content-length'), String(bytes.length));
      assert.equal(filmDownload.headers.get('cache-control'), 'no-store');
      assert.deepEqual(Buffer.from(await filmDownload.arrayBuffer()), bytes);
      const download = await request(person, body.archive.clips[0].downloadPath);
      assert.equal(download.status, 200);
      assert.match(download.headers.get('content-disposition'), /rewind-my-clip/);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    }
    assert.equal(
      (await request(member, scoped('/clips/owner-clip/download') + '&memberId=' + group.memberId))
        .status,
      404,
    );
    assert.equal((await request(outsider, scoped('/archive'))).status, 403);
    assert.equal((await request(outsider, scoped('/films/archive-film'))).status, 403);
    assert.equal((await request(owner, scoped('/archive') + '&filmCursor=malformed')).status, 400);
    const preflight = await request(null, scoped('/archive'), { method: 'OPTIONS' });
    assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
    assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
    const fresh = (await (await request(owner, scoped('/archive'))).json()).archive.films[0]
      .playbackPath;
    createRealGroup(
      database,
      owner.account,
      { name: 'Another selected group', prompt: 'Other cycle', maxMembers: 2 },
      NOW,
    );
    assert.equal((await request(null, fresh)).status, 404);
    database
      .prepare('UPDATE real_account_group_selections SET group_id=? WHERE account_id=?')
      .run(group.group.id, owner.account.id);
    revokeRealSession(database, owner.token, NOW);
    assert.equal((await request(null, fresh)).status, 404);
    assert.equal((await request(owner, scoped('/archive'))).status, 401);
  }));

test('capability expiry and corrupt retained bytes deny playback and remove Archive advertising', async () =>
  fixture(async (c) => {
    c.publish();
    const body = await (await c.request(c.owner, c.scoped('/archive'))).json();
    const path = body.archive.films[0].playbackPath;
    c.setClock(new Date(NOW.getTime() + 120000));
    assert.equal((await c.request(null, path)).status, 404);
    c.setClock(NOW);
    await writeFile(c.filmPath, Buffer.from('corrupted private media'));
    assert.equal((await c.request(null, path)).status, 404);
    const archive = await (await c.request(c.owner, c.scoped('/archive'))).json();
    assert.equal(archive.archive.films.length, 0);
    assert.equal(
      (await (await c.request(c.owner, c.scoped(`/cycles/${c.group.cycle.id}/premiere`))).json())
        .premiere.state,
      'delayed',
    );
  }));

test('private store Archive serves only pinned versions and discards materialized scratch bytes', async () =>
  fixture(async (c) => {
    c.publish();
    const body = await (await c.request(c.owner, c.scoped('/archive'))).json();
    assert.equal(body.archive.films.length, 1);
    const path = body.archive.films[0].playbackPath;
    const response = await c.request(null, path, { headers: { Range: 'bytes=0-15' } });
    assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), c.bytes.subarray(0, 16));
    assert.deepEqual(await readdir(c.root + '/media/serving'), []);
    const ref = JSON.parse(Buffer.from(c.filmPath.slice('media-object:'.length), 'base64url'));
    assert.equal(
      c.double.calls
        .filter(([method]) => method === 'get')
        .every(([, request]) => request.VersionId),
      true,
    );
    c.double.versions.delete(`${ref.key}:${ref.versionId}`);
    assert.equal((await c.request(null, path)).status, 404);
    assert.equal(
      (await (await c.request(c.owner, c.scoped('/archive'))).json()).archive.films.length,
      0,
    );
  }, true));

test('private stored film publication and full-day Archive require verified pinned bytes', async () =>
  fixture(async (c) => {
    const input = { groupId: c.group.group.id, cycleId: c.group.cycle.id, clock: () => NOW };
    c.database
      .prepare(
        "UPDATE cycles SET starts_at='2026-09-04T12:00:00Z',ends_at=?,status='revealing' WHERE id=?",
      )
      .run(NOW.toISOString(), c.group.cycle.id);
    const options = {
      mediaStore: c.store,
      mediaEnvironment: 'test',
      outputDir: c.root + '/media/processed',
    };
    assert.deepEqual(publishCycleRelease(c.database, input), { ok: false, reason: 'not_ready' });
    const result = await publishCycleReleaseWithStore(c.database, input, options);
    assert.equal(result.ok, true);
    assert.equal(result.action, 'published');
    assert.equal(
      (await publishCycleReleaseWithStore(c.database, input, options)).action,
      'already_published',
    );
    const premiere = await advanceCycleLifecycleWithStore(
      c.database,
      { ...input, clock: () => new Date(NOW.getTime() + PREMIERE_DURATION_MS - 1) },
      options,
    );
    assert.equal(premiere.action, 'premiere');
    const archived = await advanceCycleLifecycleWithStore(
      c.database,
      { ...input, clock: () => new Date(NOW.getTime() + PREMIERE_DURATION_MS) },
      options,
    );
    assert.equal(archived.action, 'archived');
    assert.equal(
      c.database
        .prepare('SELECT count(*) AS n FROM cycles WHERE previous_cycle_id=?')
        .get(c.group.cycle.id).n,
      1,
    );
    const ref = JSON.parse(Buffer.from(c.filmPath.slice('media-object:'.length), 'base64url'));
    c.double.versions.delete(`${ref.key}:${ref.versionId}`);
    assert.equal((await publishCycleReleaseWithStore(c.database, input, options)).ok, false);
  }, true));

test('stored publication refuses an asset changed during its verified read', async () =>
  fixture(async (c) => {
    const input = { groupId: c.group.group.id, cycleId: c.group.cycle.id, clock: () => NOW };
    c.database
      .prepare(
        "UPDATE cycles SET starts_at='2026-09-04T12:00:00Z',ends_at=?,status='revealing' WHERE id=?",
      )
      .run(NOW.toISOString(), c.group.cycle.id);
    const read = c.store.read.bind(c.store);
    c.store.read = async function* (scope, ref) {
      for await (const chunk of read(scope, ref)) yield chunk;
      c.database
        .prepare("UPDATE media_jobs SET output_sha256=? WHERE id='archive-film'")
        .run('b'.repeat(64));
    };
    const result = await publishCycleReleaseWithStore(c.database, input, {
      mediaStore: c.store,
      mediaEnvironment: 'test',
      outputDir: c.root + '/media/processed',
    });
    assert.deepEqual(result, { ok: false, reason: 'not_ready' });
    assert.equal(
      c.database
        .prepare('SELECT release_status AS state FROM cycles WHERE id=?')
        .get(c.group.cycle.id).state,
      'unpublished',
    );
  }, true));

test('film segments hide blocked, reported and owner-removed moments per viewer', async () =>
  fixture(async (c) => {
    const { request, scoped, publish, group, owner, member, outsider, database } = c;
    database
      .prepare(
        "UPDATE media_jobs SET trim_start_seconds=1, trim_end_seconds=3.5 WHERE id='owner-clip'",
      )
      .run();
    database.prepare("UPDATE media_jobs SET media_type='photo' WHERE id='member-clip'").run();
    for (const [position, id] of ['owner-clip', 'member-clip'].entries())
      database
        .prepare(
          "INSERT INTO compilation_job_inputs(job_id,clip_job_id,contribution_id,position) VALUES('archive-film',?,?,?)",
        )
        .run(id, id, position);
    publish();
    const post = (person, path, body) =>
      request(person, path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const segments = async (person) => {
      const premiere = (
        await (await request(person, scoped(`/cycles/${group.cycle.id}/premiere`))).json()
      ).premiere;
      assert.equal(premiere.state, 'ready');
      const archive = (await (await request(person, scoped('/archive'))).json()).archive;
      assert.deepEqual(archive.films[0].segments, premiere.segments);
      return premiere.segments;
    };
    const segment = (contributionId, startSeconds, durationSeconds, hidden, mine) => ({
      contributionId,
      startSeconds,
      durationSeconds,
      hidden,
      mine,
    });
    assert.deepEqual(await segments(member), [
      segment('owner-clip', 0, 2.5, false, false),
      segment('member-clip', 2.5, 3, false, true),
    ]);
    const ownerProfile = group.memberId;
    assert.equal((await post(member, '/real/blocks', { profileId: ownerProfile })).status, 201);
    assert.equal((await segments(member))[0].hidden, true);
    assert.equal((await segments(owner))[0].hidden, false);
    assert.equal(
      (await request(member, `/real/blocks/${ownerProfile}`, { method: 'DELETE' })).status,
      200,
    );
    assert.equal(
      (
        await post(owner, `/real/groups/${group.group.id}/reports`, {
          contributionId: 'member-clip',
        })
      ).status,
      201,
    );
    assert.deepEqual(
      (await segments(owner)).map((entry) => entry.hidden),
      [false, true],
    );
    assert.equal((await segments(member))[1].hidden, false);

    const remove = (person, groupId, id) =>
      post(person, `/real/groups/${groupId}/contributions/${id}/remove`, {});
    const memberRemove = await remove(member, group.group.id, 'owner-clip');
    assert.equal(memberRemove.status, 403);
    assert.equal((await memberRemove.json()).error, 'forbidden');
    assert.equal((await remove(outsider, group.group.id, 'owner-clip')).status, 404);
    assert.equal((await remove(owner, group.group.id, 'missing')).status, 404);
    const elsewhere = createRealGroup(
      database,
      outsider.account,
      { name: 'Elsewhere', prompt: 'Other', maxMembers: 3 },
      new Date('2026-10-02T12:00:00Z'),
    );
    database
      .prepare(
        "INSERT INTO contributions(id,cycle_id,member_id,duration_seconds,created_at) VALUES('foreign-clip',?,?,1,?)",
      )
      .run(elsewhere.cycle.id, elsewhere.memberId, '2026-10-02T12:00:00Z');
    assert.equal((await remove(owner, group.group.id, 'foreign-clip')).status, 404);
    const allowance = () =>
      database
        .prepare('SELECT count_used AS count, seconds_used AS seconds FROM cycles WHERE id=?')
        .get(group.cycle.id);
    const before = allowance();
    const removed = await remove(owner, group.group.id, 'owner-clip');
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { removed: true });
    assert.deepEqual(allowance(), before);
    const row = database
      .prepare(
        "SELECT deleted_at AS deletedAt, removed_at AS removedAt, removed_by_account_id AS removedBy FROM contributions WHERE id='owner-clip'",
      )
      .get();
    assert.equal(row.deletedAt, null);
    assert.equal(row.removedBy, owner.account.id);
    assert.ok(row.removedAt);
    for (const person of [owner, member]) assert.equal((await segments(person))[0].hidden, true);
    const encoded = JSON.stringify(await segments(member));
    assert.equal(encoded.includes('/media/'), false);
    assert.equal(encoded.includes(ownerProfile), false);

    // Deleting an author's account keeps the film's offsets in place.
    purgeRealAccount(database, member.account.id);
    const afterDelete = (
      await (await request(owner, scoped(`/cycles/${group.cycle.id}/premiere`))).json()
    ).premiere.segments;
    assert.deepEqual(
      afterDelete.map((entry) => [entry.startSeconds, entry.durationSeconds, entry.hidden]),
      [
        [0, 2.5, true],
        [2.5, 3, true],
      ],
    );
  }));
