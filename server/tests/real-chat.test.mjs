import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';

const { parseConfig } = await import('../dist/config.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { createRealAccount } = await import('../dist/auth/index.js');

async function withRuntime(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-real-chat-test-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
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
    username,
    'a sufficiently long pilot password',
    new Date('2026-09-29T00:00:00.000Z'),
  );
  assert.equal(created.ok, true);
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'a sufficiently long pilot password',
      clientType: 'native',
    }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  return { account: created.account, headers: { Authorization: `Bearer ${token}` } };
}

async function createGroup(baseUrl, owner, name) {
  const response = await fetch(`${baseUrl}/real/groups`, {
    method: 'POST',
    headers: { ...owner.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, prompt: 'A moment?', maxMembers: 5 }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function joinGroup(baseUrl, owner, member, groupId) {
  const invite = await fetch(`${baseUrl}/real/groups/${groupId}/invites`, {
    method: 'POST',
    headers: { ...owner.headers, 'Content-Type': 'application/json' },
    body: '{}',
  }).then((response) => response.json());
  const accepted = await fetch(`${baseUrl}/real/invites/accept`, {
    method: 'POST',
    headers: { ...member.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: invite.invite.code }),
  });
  assert.equal(accepted.status, 200);
}

test('real members can read, subscribe, reply and react while another group is denied every route', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const owner = await provision(baseUrl, database, 'real-chat-owner');
    const member = await provision(baseUrl, database, 'real-chat-member');
    const outsider = await provision(baseUrl, database, 'real-chat-outsider');
    const group = await createGroup(baseUrl, owner, 'Private chat group');
    const otherGroup = await createGroup(baseUrl, outsider, 'Other private group');
    await joinGroup(baseUrl, owner, member, group.group.id);

    const prefix = `${baseUrl}/realtime/groups/${group.group.id}`;
    const streamResponse = await fetch(`${prefix}/events?sinceEventId=0`, {
      headers: { ...member.headers, Accept: 'text/event-stream' },
    });
    assert.equal(streamResponse.status, 200);
    const reader = streamResponse.body.getReader();
    try {
      const sent = await fetch(`${prefix}/messages`, {
        method: 'POST',
        headers: { ...owner.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'A real member message', messageId: 'real-chat-root' }),
      });
      assert.equal(sent.status, 201);
      const root = (await sent.json()).event;
      let streamText = '';
      while (!streamText.includes('A real member message')) {
        const receivedChunk = await reader.read();
        assert.equal(receivedChunk.done, false);
        streamText += new TextDecoder().decode(receivedChunk.value);
      }

      const replyResponse = await fetch(`${prefix}/messages`, {
        method: 'POST',
        headers: { ...member.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'A real reply', replyToMessageId: root.message.id }),
      });
      assert.equal(replyResponse.status, 201);
      const reply = (await replyResponse.json()).event;
      assert.equal(reply.message.replyTo.id, root.message.id);
      const reaction = await fetch(`${prefix}/messages/${root.message.id}/reactions`, {
        method: 'POST',
        headers: { ...member.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji: '✨', active: true }),
      });
      assert.equal(reaction.status, 200);
      assert.equal((await reaction.json()).message.reactionCounts['✨'], 1);

      const history = await fetch(`${prefix}/messages`, { headers: member.headers });
      assert.equal(history.status, 200);
      const messages = (await history.json()).events;
      assert.equal(messages.length, 2);
      assert.equal(messages[0].message.body, 'A real member message');
      assert.equal(messages[1].message.body, 'A real reply');

      const outsiderRoot = await fetch(`${prefix}/messages`, {
        method: 'POST',
        headers: { ...outsider.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'must not persist' }),
      });
      assert.equal(outsiderRoot.status, 403);
      const outsiderHistory = await fetch(`${prefix}/messages`, { headers: outsider.headers });
      assert.equal(outsiderHistory.status, 403);
      const outsiderReply = await fetch(`${prefix}/messages`, {
        method: 'POST',
        headers: { ...outsider.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'private reply', replyToMessageId: root.message.id }),
      });
      assert.equal(outsiderReply.status, 403);
      const outsiderReaction = await fetch(`${prefix}/messages/${root.message.id}/reactions`, {
        method: 'POST',
        headers: { ...outsider.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji: '✨', active: true }),
      });
      assert.equal(outsiderReaction.status, 403);
      const outsiderReactionRead = await fetch(`${prefix}/messages/${root.message.id}/reactions`, {
        headers: outsider.headers,
      });
      assert.equal(outsiderReactionRead.status, 403);
      const outsiderReactionRemove = await fetch(
        `${prefix}/messages/${root.message.id}/reactions`,
        { method: 'DELETE', headers: outsider.headers },
      );
      assert.equal(outsiderReactionRemove.status, 403);
      const outsiderStream = await fetch(`${prefix}/events`, {
        headers: { ...outsider.headers, Accept: 'text/event-stream' },
      });
      assert.equal(outsiderStream.status, 200);
      assert.match(await outsiderStream.text(), /event: access-denied/);
      assert.equal(
        database
          .prepare("SELECT COUNT(*) AS count FROM messages WHERE body = 'must not persist'")
          .get().count,
        0,
      );

      await reader.cancel();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const preflight = await fetch(`${prefix}/events`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost', 'Access-Control-Request-Headers': 'authorization' },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
    assert.equal(otherGroup.group.id === group.group.id, false);
  });
});
