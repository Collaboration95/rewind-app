import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');

async function withRuntime(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-chat-context-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  const server = createRuntimeServer(config, database);
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

async function session(baseUrl, memberId, groupId = 'demo-group') {
  const response = await fetch(`${baseUrl}/sessions/demo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, groupId }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).session;
}

test('members can persist one-level replies and nested replies are rejected', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const first = await session(baseUrl, 'demo-1');
    const response = await fetch(
      `${baseUrl}/realtime/groups/demo-group/messages?sessionId=${first.id}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'A reply', replyToMessageId: 'demo-message' }),
      },
    );
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.equal(payload.event.message.replyTo.id, 'demo-message');
    assert.equal(payload.event.message.replyTo.body, 'A synthetic message for policy checks.');
    assert.equal(
      database
        .prepare('SELECT reply_to_message_id AS parent FROM messages WHERE id = ?')
        .get(payload.message.id).parent,
      'demo-message',
    );

    const nested = await fetch(
      `${baseUrl}/realtime/groups/demo-group/messages?sessionId=${first.id}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'No nested threads', replyToMessageId: payload.message.id }),
      },
    );
    assert.equal(nested.status, 400);
    assert.equal((await nested.json()).error, 'message_nested_reply_not_allowed');
  });
});

test('supported reaction add/remove is idempotent and returns aggregate counts', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const first = await session(baseUrl, 'demo-1');
    const url = `${baseUrl}/realtime/groups/demo-group/messages/demo-message/reactions?sessionId=${first.id}`;
    const add = () =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji: '✨', active: true }),
      });
    assert.equal((await add()).status, 200);
    const addedResponse = await add();
    assert.equal(addedResponse.status, 200);
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM reactions WHERE message_id = ? AND member_id = ?')
        .get('demo-message', 'demo-1').count,
      1,
    );
    const added = await addedResponse.json();
    assert.equal(added.message.reactionCounts['✨'], 2);

    const remove = () => fetch(url, { method: 'DELETE' });
    assert.equal((await remove()).status, 200);
    assert.equal((await remove()).status, 200);
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM reactions WHERE message_id = ? AND member_id = ?')
        .get('demo-message', 'demo-1').count,
      0,
    );
    const final = await fetch(url).then((response) => response.json());
    assert.equal(final.message.reactionCounts['✨'] ?? 0, 1);

    // Omitting active is the viewer-safe toggle form used after a timeline remount.
    const toggle = () =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji: '✨' }),
      });
    const toggledOn = await toggle();
    assert.equal(toggledOn.status, 200);
    assert.equal((await toggledOn.json()).reaction.active, true);
    const toggledOff = await toggle();
    assert.equal(toggledOff.status, 200);
    assert.equal((await toggledOff.json()).reaction.active, false);
  });
});

test('a member outside the group cannot reply or react to its messages', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    database.exec(`
      INSERT INTO profiles (id, display_name, avatar_label, is_synthetic)
        VALUES ('demo-outside', 'Outside', 'Outside', 1);
      INSERT INTO groups (id, name, current_cycle_id)
        VALUES ('other-group', 'Other', NULL);
      INSERT INTO memberships (group_id, member_id, role, accepted_at)
        VALUES ('other-group', 'demo-outside', 'member', '2026-09-13T00:00:00.000Z');
    `);
    const outsider = await session(baseUrl, 'demo-outside', 'other-group');
    const reply = await fetch(
      `${baseUrl}/realtime/groups/demo-group/messages?sessionId=${outsider.id}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'private reply', replyToMessageId: 'demo-message' }),
      },
    );
    assert.equal(reply.status, 403);
    const reaction = await fetch(
      `${baseUrl}/realtime/groups/demo-group/messages/demo-message/reactions?sessionId=${outsider.id}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji: '✨', active: true }),
      },
    );
    assert.equal(reaction.status, 403);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM messages WHERE body = 'private reply'").get()
        .count,
      0,
    );
  });
});
