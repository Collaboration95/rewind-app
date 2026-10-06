import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { uploadFixture } from './helpers/fixture-upload.mjs';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';

const execFileAsync = promisify(execFile);
const { parseConfig } = await import('../dist/config.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { createRealAccount } = await import('../dist/auth/index.js');

const PASSWORD = 'a sufficiently long pilot password';

async function withRuntime(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-account-safety-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_FFMPEG_BIN: 'ffmpeg',
    REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true',
  });
  const database = openFixtureDatabase(config);
  const server = createRuntimeServer(config, database, {
    now: () => new Date('2026-09-29T00:00:00.000Z'),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ baseUrl, database, dataDir, server });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function login(baseUrl, username) {
  return fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD, clientType: 'native' }),
  });
}

async function provision(baseUrl, database, username) {
  const created = await createRealAccount(database, username, username, PASSWORD);
  assert.equal(created.ok, true);
  const response = await login(baseUrl, username);
  assert.equal(response.status, 200);
  const { token } = await response.json();
  return { account: created.account, headers: { Authorization: `Bearer ${token}` } };
}

function post(baseUrl, path, user, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { ...user.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createGroup(baseUrl, owner, name) {
  const response = await post(baseUrl, '/real/groups', owner, {
    name,
    prompt: 'A moment?',
    maxMembers: 5,
  });
  assert.equal(response.status, 201);
  return (await response.json()).group.id;
}

async function selectGroup(baseUrl, user, groupId) {
  const response = await post(baseUrl, '/real/groups/current', user, { groupId });
  assert.equal(response.status, 200);
}

async function joinGroup(baseUrl, owner, member, groupId) {
  const invite = await post(baseUrl, `/real/groups/${groupId}/invites`, owner, {}).then((r) =>
    r.json(),
  );
  const accepted = await post(baseUrl, '/real/invites/accept', member, {
    code: invite.invite.code,
  });
  assert.equal(accepted.status, 200);
}

async function sendMessage(baseUrl, user, groupId, body) {
  const response = await post(baseUrl, `/realtime/groups/${groupId}/messages`, user, { body });
  assert.equal(response.status, 201);
  return (await response.json()).event.message.id;
}

async function chatBodies(baseUrl, user, groupId) {
  const response = await fetch(`${baseUrl}/realtime/groups/${groupId}/messages`, {
    headers: user.headers,
  });
  assert.equal(response.status, 200);
  return (await response.json()).events.map((event) => event.message.body);
}

test('deleting an account needs the password, removes its data and media, and hands groups on', async () => {
  await withRuntime(async ({ baseUrl, database, dataDir, server }) => {
    const owner = await provision(baseUrl, database, 'deleting-owner');
    const member = await provision(baseUrl, database, 'staying-member');
    const soloGroup = await createGroup(baseUrl, owner, 'Only me');
    const sharedGroup = await createGroup(baseUrl, owner, 'Shared');
    await joinGroup(baseUrl, owner, member, sharedGroup);
    await sendMessage(baseUrl, owner, sharedGroup, 'owner message');
    await sendMessage(baseUrl, member, sharedGroup, 'member message');

    const imagePath = `${dataDir}/source.png`;
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x240',
      '-frames:v',
      '1',
      imagePath,
    ]);
    const staged = await uploadFixture(
      server,
      `${baseUrl}/contributions/upload/source?groupId=${sharedGroup}&idempotencyKey=delete-me`,
      {
        authorization: owner.headers.Authorization,
        mimeType: 'image/png',
        bytes: await readFile(imagePath),
      },
    );
    assert.equal(staged.status, 201);
    const source = (await staged.json()).source;
    const upload = await post(baseUrl, `/contributions/upload?groupId=${sharedGroup}`, owner, {
      mediaType: 'photo',
      idempotencyKey: 'delete-me',
      sourceUri: source.uri,
      mimeType: 'image/png',
      byteLength: source.byteLength,
      durationSeconds: 3,
      width: 320,
      height: 240,
      hasAudio: true,
      mode: 'soft-focus',
      trimStartSeconds: 0,
      trimEndSeconds: 3,
    });
    assert.equal(upload.status, 201);
    const { job } = (await upload.json()).upload;
    const sourcePath = database
      .prepare('SELECT source_path AS path FROM media_jobs WHERE id = ?')
      .get(job.id).path;
    await access(sourcePath);

    const wrong = await post(baseUrl, '/auth/account/delete', owner, { password: 'not it' });
    assert.equal(wrong.status, 403);
    const unauthenticated = await post(
      baseUrl,
      '/auth/account/delete',
      { headers: {} },
      {
        password: PASSWORD,
      },
    );
    assert.equal(unauthenticated.status, 401);

    const deleted = await post(baseUrl, '/auth/account/delete', owner, { password: PASSWORD });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: true });

    const session = await fetch(`${baseUrl}/auth/session`, { headers: owner.headers });
    assert.equal(session.status, 401);
    assert.equal((await login(baseUrl, 'deleting-owner')).status, 401);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS n FROM real_accounts WHERE id = ?').get(owner.account.id)
        .n,
      0,
    );
    assert.equal(database.prepare('SELECT 1 FROM groups WHERE id = ?').get(soloGroup), undefined);
    assert.equal(
      database
        .prepare('SELECT owner_account_id AS id FROM real_group_metadata WHERE group_id = ?')
        .get(sharedGroup).id,
      member.account.id,
    );
    const job_ = database
      .prepare('SELECT status, source_path AS sourcePath FROM media_jobs WHERE id = ?')
      .get(job.id);
    assert.equal(job_.status, 'deleted');
    assert.equal(job_.sourcePath, null);
    await assert.rejects(access(sourcePath));

    await selectGroup(baseUrl, member, sharedGroup);
    assert.deepEqual(await chatBodies(baseUrl, member, sharedGroup), ['member message']);
    const invite = await post(baseUrl, `/real/groups/${sharedGroup}/invites`, member, {});
    assert.equal(invite.status, 201);
    const again = await createRealAccount(database, 'deleting-owner', 'again', PASSWORD);
    assert.equal(again.ok, true);
  });
});

test('members can report and block, which hides that chat from them only', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const owner = await provision(baseUrl, database, 'safety-owner');
    const member = await provision(baseUrl, database, 'safety-member');
    const outsider = await provision(baseUrl, database, 'safety-outsider');
    const groupId = await createGroup(baseUrl, owner, 'Safety');
    await createGroup(baseUrl, outsider, 'Elsewhere');
    await joinGroup(baseUrl, owner, member, groupId);
    const first = await sendMessage(baseUrl, owner, groupId, 'first');
    await sendMessage(baseUrl, owner, groupId, 'second');
    await sendMessage(baseUrl, member, groupId, 'mine');
    assert.equal(
      (
        await post(baseUrl, `/realtime/groups/${groupId}/messages`, owner, {
          body: 'reply',
          replyToMessageId: first,
        })
      ).status,
      201,
    );

    const reports = `/real/groups/${groupId}/reports`;
    assert.equal((await post(baseUrl, reports, member, {})).status, 400);
    assert.equal(
      (await post(baseUrl, reports, member, { messageId: first, reason: 'x'.repeat(501) })).status,
      400,
    );
    assert.equal((await post(baseUrl, reports, outsider, { messageId: first })).status, 404);
    assert.equal(
      (await post(baseUrl, reports, member, { messageId: first, contributionId: '' })).status,
      400,
    );
    assert.equal(
      (await post(baseUrl, reports, member, { messageId: first, reason: 'rude' })).status,
      201,
    );
    assert.equal((await post(baseUrl, reports, member, { messageId: first })).status, 201);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM content_reports').get().n, 1);
    assert.deepEqual(await chatBodies(baseUrl, member, groupId), ['second', 'mine', 'reply']);
    assert.deepEqual(await chatBodies(baseUrl, owner, groupId), [
      'first',
      'second',
      'mine',
      'reply',
    ]);
    const history = await fetch(`${baseUrl}/realtime/groups/${groupId}/messages`, {
      headers: member.headers,
    }).then((r) => r.json());
    assert.equal(history.events.at(-1).message.replyTo, null);

    const ownerProfile = database
      .prepare('SELECT id FROM real_profiles WHERE account_id = ?')
      .get(owner.account.id).id;
    const outsiderProfile = database
      .prepare('SELECT id FROM real_profiles WHERE account_id = ?')
      .get(outsider.account.id).id;
    assert.equal(
      (await post(baseUrl, '/real/blocks', member, { profileId: outsiderProfile })).status,
      404,
    );
    assert.equal(
      (await post(baseUrl, '/real/blocks', member, { profileId: ownerProfile })).status,
      201,
    );
    assert.deepEqual(await chatBodies(baseUrl, member, groupId), ['mine']);
    const blocked = await fetch(`${baseUrl}/real/blocks`, { headers: member.headers }).then((r) =>
      r.json(),
    );
    assert.deepEqual(
      blocked.blocked.map((entry) => entry.profileId),
      [ownerProfile],
    );

    const unblocked = await fetch(`${baseUrl}/real/blocks/${ownerProfile}`, {
      method: 'DELETE',
      headers: member.headers,
    });
    assert.equal(unblocked.status, 200);
    assert.deepEqual(await chatBodies(baseUrl, member, groupId), ['second', 'mine', 'reply']);
  });
});

test('members can report a person in their group, once, but not themselves or outsiders', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const owner = await provision(baseUrl, database, 'person-owner');
    const member = await provision(baseUrl, database, 'person-member');
    const outsider = await provision(baseUrl, database, 'person-outsider');
    const groupId = await createGroup(baseUrl, owner, 'People');
    await createGroup(baseUrl, outsider, 'Apart');
    await joinGroup(baseUrl, owner, member, groupId);
    const profile = (user) =>
      database.prepare('SELECT id FROM real_profiles WHERE account_id = ?').get(user.account.id).id;
    const reports = `/real/groups/${groupId}/reports`;
    const message = await sendMessage(baseUrl, owner, groupId, 'hello');

    assert.equal(
      (await post(baseUrl, reports, member, { memberId: profile(owner), messageId: message }))
        .status,
      400,
    );
    assert.equal((await post(baseUrl, reports, member, { memberId: '' })).status, 400);
    assert.equal(
      (await post(baseUrl, reports, member, { memberId: profile(owner), reason: 'x'.repeat(501) }))
        .status,
      400,
    );
    assert.equal((await post(baseUrl, reports, member, { memberId: profile(member) })).status, 404);
    assert.equal(
      (await post(baseUrl, reports, member, { memberId: profile(outsider) })).status,
      404,
    );
    assert.equal(
      (await post(baseUrl, reports, outsider, { memberId: profile(owner) })).status,
      404,
    );
    const reported = await post(baseUrl, reports, member, {
      memberId: profile(owner),
      reason: ' abusive ',
    });
    assert.equal(reported.status, 201);
    assert.deepEqual(await reported.json(), { reported: true });
    assert.equal((await post(baseUrl, reports, member, { memberId: profile(owner) })).status, 201);
    assert.deepEqual(
      database
        .prepare(
          'SELECT reporter_account_id AS reporter, reported_account_id AS reported, reason FROM member_reports',
        )
        .all()
        .map((row) => ({ ...row })),
      [{ reporter: member.account.id, reported: owner.account.id, reason: 'abusive' }],
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM content_reports').get().n, 0);
  });
});

test('moderation records retain reporter, reason and time after the target account and group disappear', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const target = await provision(baseUrl, database, 'reported-target');
    const reporter = await provision(baseUrl, database, 'surviving-reporter');
    const groupId = await createGroup(baseUrl, target, 'Preserve reports');
    await joinGroup(baseUrl, target, reporter, groupId);
    const messageId = await sendMessage(baseUrl, target, groupId, 'reported message');
    const memberId = database
      .prepare('SELECT id FROM real_profiles WHERE account_id = ?')
      .get(target.account.id).id;
    const reports = `/real/groups/${groupId}/reports`;
    assert.equal(
      (await post(baseUrl, reports, reporter, { memberId, reason: 'abusive person' })).status,
      201,
    );
    assert.equal(
      (await post(baseUrl, reports, reporter, { messageId, reason: 'abusive message' })).status,
      201,
    );
    const before = database.prepare('SELECT created_at FROM member_reports').get().created_at;
    assert.equal(
      (await post(baseUrl, '/auth/account/delete', target, { password: PASSWORD })).status,
      200,
    );
    const member = database.prepare('SELECT * FROM member_reports').get();
    assert.equal(member.reported_account_id, null);
    assert.equal(member.reporter_account_id, reporter.account.id);
    assert.equal(member.reason, 'abusive person');
    assert.equal(member.created_at, before);
    const content = database.prepare('SELECT * FROM content_reports').get();
    assert.equal(content.message_id, null);
    assert.equal(content.reporter_account_id, reporter.account.id);
    assert.equal(content.reason, 'abusive message');
    assert.equal(content.created_at, before);
    database.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
    assert.equal(database.prepare('SELECT group_id FROM member_reports').get().group_id, null);
    assert.equal(database.prepare('SELECT group_id FROM content_reports').get().group_id, null);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  });
});
