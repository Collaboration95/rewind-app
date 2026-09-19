import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');

const SAFE_DENIAL = {
  allowed: false,
  status: 403,
  error: 'forbidden',
  message: 'You do not have access to this resource.',
};

const SESSION_REQUIRED = {
  error: 'session_required',
  message: 'Choose Demo access before changing local Demo data.',
};

async function withRuntime(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-session-http-policy-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
  });
  const database = openDatabase(config);
  const server = createRuntimeServer(config, database);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await run({ baseUrl, database });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function createSession(baseUrl, memberId = 'demo-1', groupId) {
  const response = await fetch(`${baseUrl}/sessions/demo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, ...(groupId ? { groupId } : {}) }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).session;
}

async function jsonRequest(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { response, body: await response.json().catch(() => null) };
}

test('protected route classes reject caller-supplied identity without a session', async () => {
  await withRuntime(async ({ baseUrl }) => {
    const cases = [
      { name: 'group', path: '/groups/demo-group?memberId=demo-1' },
      { name: 'current group', path: '/groups/current?memberId=demo-1' },
      {
        name: 'contribution',
        path: '/contributions/demo-contribution?groupId=demo-group&memberId=demo-1',
      },
      { name: 'media', path: '/clips/demo-clip?groupId=demo-group&memberId=demo-1' },
      { name: 'film', path: '/films/demo-film?groupId=demo-group&memberId=demo-1' },
      { name: 'archive', path: '/archive?groupId=demo-group&memberId=demo-1' },
      {
        name: 'owner-only',
        path: '/cycles/demo/advance?groupId=demo-group&memberId=demo-1&advanceSeconds=60',
        method: 'POST',
      },
      { name: 'reset', path: '/demo/reset?memberId=demo-1', method: 'POST' },
      {
        name: 'invite',
        path: '/invites?groupId=demo-group&memberId=demo-1',
        method: 'POST',
        body: { memberId: 'demo-1', groupId: 'demo-group', expiresInSeconds: 600 },
      },
      {
        name: 'realtime message',
        path: '/realtime/groups/demo-group/messages?memberId=demo-1&groupId=demo-group',
        method: 'POST',
        body: { memberId: 'demo-1', groupId: 'demo-group', body: 'must not be accepted' },
      },
      {
        name: 'realtime events',
        path: '/realtime/groups/demo-group/events?memberId=demo-1',
        headers: { 'x-member-id': 'demo-1', 'x-group-id': 'demo-group' },
      },
    ];

    for (const item of cases) {
      const result = await jsonRequest(baseUrl, item.path, {
        method: item.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...(item.body ? { 'Content-Type': 'application/json' } : {}),
          ...item.headers,
        },
        ...(item.body ? { body: JSON.stringify(item.body) } : {}),
      });
      assert.equal(result.response.status, 401, item.name);
      assert.deepEqual(result.body, SESSION_REQUIRED, item.name);
    }
  });
});

test('valid session identity authorises group, contribution, media, film, archive, owner, invite, and realtime routes', async () => {
  await withRuntime(async ({ baseUrl }) => {
    const session = await createSession(baseUrl, 'demo-1');
    const query = `groupId=demo-group&sessionId=${encodeURIComponent(session.id)}&memberId=demo-2`;

    const readable = [
      [
        '/groups/demo-group?sessionId=' + encodeURIComponent(session.id) + '&memberId=demo-2',
        'group',
      ],
      [
        '/groups/current?sessionId=' + encodeURIComponent(session.id) + '&memberId=demo-2',
        'current group',
      ],
      [`/contributions/demo-contribution?${query}`, 'contribution'],
      [`/clips/demo-clip?${query}`, 'media'],
      [`/films/demo-film?${query}`, 'film'],
      [`/archive?${query}`, 'archive'],
    ];
    for (const [path, name] of readable) {
      const result = await jsonRequest(baseUrl, path);
      assert.equal(result.response.status, 200, name);
    }

    const ownerControl = await jsonRequest(
      baseUrl,
      `/cycles/demo/advance?groupId=demo-group&sessionId=${encodeURIComponent(session.id)}&advanceSeconds=0`,
      { method: 'POST' },
    );
    assert.equal(ownerControl.response.status, 400);
    assert.equal(ownerControl.body.error, 'invalid_request');

    const reveal = await jsonRequest(
      baseUrl,
      `/demo/reveal?groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`,
      { method: 'POST' },
    );
    assert.equal(reveal.response.status, 200);
    assert.equal(reveal.body.reveal.state, 'compiling');

    const invite = await jsonRequest(
      baseUrl,
      `/invites?groupId=demo-group&sessionId=${encodeURIComponent(session.id)}&memberId=demo-2`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memberId: 'demo-2',
          groupId: 'not-the-session-group',
          expiresInSeconds: 600,
        }),
      },
    );
    assert.equal(invite.response.status, 201);

    const message = await jsonRequest(
      baseUrl,
      `/realtime/groups/demo-group/messages?sessionId=${encodeURIComponent(session.id)}&memberId=demo-2`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memberId: 'demo-2',
          groupId: 'not-the-session-group',
          body: 'session identity wins',
        }),
      },
    );
    assert.equal(message.response.status, 201);
    assert.equal(message.body.message.memberId, 'demo-1');
  });
});

test('expired, invalid, and cross-group sessions fail before protected resource lookup', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const session = await createSession(baseUrl, 'demo-1');
    const protectedRoutes = [
      `/groups/demo-group?sessionId=${encodeURIComponent(session.id)}`,
      `/contributions/demo-contribution?groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`,
      `/clips/demo-clip?groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`,
      `/films/demo-film?groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`,
      `/archive?groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`,
      `/invites?groupId=demo-group&sessionId=${encodeURIComponent(session.id)}`,
    ];

    database
      .prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', session.id);
    for (const path of protectedRoutes) {
      const result = await jsonRequest(baseUrl, path, {
        method: path.startsWith('/invites') ? 'POST' : 'GET',
      });
      assert.equal(result.response.status, 401, path);
      assert.deepEqual(result.body, SESSION_REQUIRED, path);
    }

    const invalid = await jsonRequest(
      baseUrl,
      '/groups/demo-group?sessionId=missing-session&memberId=demo-1',
    );
    assert.equal(invalid.response.status, 401);
    assert.deepEqual(invalid.body, SESSION_REQUIRED);

    const invalidated = await createSession(baseUrl, 'demo-1');
    database
      .prepare('UPDATE sessions SET invalidated_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', invalidated.id);
    const invalidatedResult = await jsonRequest(
      baseUrl,
      `/groups/demo-group?sessionId=${encodeURIComponent(invalidated.id)}&memberId=demo-1`,
    );
    assert.equal(invalidatedResult.response.status, 401);
    assert.deepEqual(invalidatedResult.body, SESSION_REQUIRED);

    const fresh = await createSession(baseUrl, 'demo-1');
    const mismatch = await jsonRequest(
      baseUrl,
      `/archive?groupId=other-group&sessionId=${encodeURIComponent(fresh.id)}&memberId=demo-1`,
    );
    assert.equal(mismatch.response.status, 403);
    assert.deepEqual(mismatch.body, SAFE_DENIAL);

    const realtimeMismatch = await fetch(
      `${baseUrl}/realtime/groups/other-group/events?sessionId=${encodeURIComponent(fresh.id)}`,
      { headers: { Accept: 'text/event-stream' } },
    );
    assert.equal(realtimeMismatch.status, 200);
    const realtimeBody = await realtimeMismatch.text();
    assert.match(realtimeBody, /event: access-denied/);
    assert.doesNotMatch(realtimeBody, /other-group/);
  });
});

test('owner-only reset accepts the session owner and rejects a valid non-owner', async () => {
  await withRuntime(async ({ baseUrl }) => {
    const owner = await createSession(baseUrl, 'demo-1');
    const nonOwner = await createSession(baseUrl, 'demo-2');
    const denied = await jsonRequest(
      baseUrl,
      `/demo/reset?sessionId=${encodeURIComponent(nonOwner.id)}&memberId=demo-1`,
      { method: 'POST' },
    );
    assert.equal(denied.response.status, 403);
    assert.deepEqual(denied.body, SAFE_DENIAL);

    const reset = await jsonRequest(
      baseUrl,
      `/demo/reset?sessionId=${encodeURIComponent(owner.id)}&memberId=demo-2`,
      { method: 'POST' },
    );
    assert.equal(reset.response.status, 200);
    assert.deepEqual(reset.body, { reset: true });
  });
});
