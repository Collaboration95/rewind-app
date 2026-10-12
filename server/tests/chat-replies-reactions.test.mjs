import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';
import { REAL_AUTH_ENV, signInAs } from './helpers/real-http.mjs';

const { parseConfig } = await import('../dist/config.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { blockMember, reportContent } = await import('../dist/groups/safety.js');

async function withRuntime(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-chat-context-test-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    ...REAL_AUTH_ENV,
  });
  const database = openFixtureDatabase(config);
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

test('members can persist one-level replies and nested replies are rejected', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const first = await signInAs(database, 'demo-1');
    const response = await fetch(`${baseUrl}/realtime/groups/demo-group/messages`, {
      method: 'POST',
      headers: { ...first.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'A reply', replyToMessageId: 'demo-message' }),
    });
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

    const nested = await fetch(`${baseUrl}/realtime/groups/demo-group/messages`, {
      method: 'POST',
      headers: { ...first.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'No nested threads', replyToMessageId: payload.message.id }),
    });
    assert.equal(nested.status, 400);
    assert.equal((await nested.json()).error, 'message_nested_reply_not_allowed');
  });
});

test('supported reaction add/remove is idempotent and returns aggregate counts', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const first = await signInAs(database, 'demo-1');
    const url = `${baseUrl}/realtime/groups/demo-group/messages/demo-message/reactions`;
    const add = () =>
      fetch(url, {
        method: 'POST',
        headers: { ...first.headers, 'Content-Type': 'application/json' },
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

    const remove = () => fetch(url, { method: 'DELETE', headers: first.headers });
    assert.equal((await remove()).status, 200);
    assert.equal((await remove()).status, 200);
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM reactions WHERE message_id = ? AND member_id = ?')
        .get('demo-message', 'demo-1').count,
      0,
    );
    const final = await fetch(url, { headers: first.headers }).then((response) => response.json());
    assert.equal(final.message.reactionCounts['✨'] ?? 0, 1);

    // Omitting active is the viewer-safe toggle form used after a timeline remount.
    const toggle = () =>
      fetch(url, {
        method: 'POST',
        headers: { ...first.headers, 'Content-Type': 'application/json' },
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
    const outsider = await signInAs(database, 'demo-outside', { groupId: 'other-group' });
    const reply = await fetch(`${baseUrl}/realtime/groups/demo-group/messages`, {
      method: 'POST',
      headers: { ...outsider.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'private reply', replyToMessageId: 'demo-message' }),
    });
    assert.equal(reply.status, 403);
    const reaction = await fetch(
      `${baseUrl}/realtime/groups/demo-group/messages/demo-message/reactions`,
      {
        method: 'POST',
        headers: { ...outsider.headers, 'Content-Type': 'application/json' },
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

const REACTIONS_URL = (baseUrl, groupId = 'demo-group', messageId = 'demo-message') =>
  `${baseUrl}/realtime/groups/${groupId}/messages/${messageId}/reactions`;

function react(baseUrl, session, active, messageId = 'demo-message') {
  return fetch(REACTIONS_URL(baseUrl, 'demo-group', messageId), {
    method: 'POST',
    headers: { ...session.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ emoji: '✨', active }),
  });
}

/** Open an SSE stream; `next` resolves the next framed event or null after `ms`. */
async function openStream(baseUrl, session, query = 'sinceEventId=1') {
  const response = await fetch(`${baseUrl}/realtime/groups/demo-group/events?${query}`, {
    headers: session.headers,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let buffer = '';
  let pendingRead = null;
  const next = async (ms = 1500) => {
    const deadline = Date.now() + ms;
    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice('data: '.length))
          .join('\n');
        if (!data) continue;
        return {
          name: block.match(/^event: (.+)$/m)?.[1] ?? 'message',
          id: block.match(/^id: (.+)$/m)?.[1] ?? null,
          data: JSON.parse(data),
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      // Keep one read in flight across calls so a timed-out wait loses no bytes.
      pendingRead ??= reader.read();
      const chunk = await Promise.race([
        pendingRead,
        new Promise((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);
      if (chunk === null) return null;
      pendingRead = null;
      if (chunk.done) return null;
      buffer += new TextDecoder().decode(chunk.value);
    }
  };
  return { next, close: () => reader.cancel() };
}

test('a reaction change reaches other members as a reaction event, not a message', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    database.exec(`
      INSERT INTO profiles (id, display_name, avatar_label, is_synthetic)
        VALUES ('demo-outside', 'Outside', 'Outside', 1);
      INSERT INTO groups (id, name, current_cycle_id) VALUES ('other-group', 'Other', NULL);
      INSERT INTO memberships (group_id, member_id, role, accepted_at)
        VALUES ('other-group', 'demo-outside', 'member', '2026-09-13T00:00:00.000Z');
    `);
    const author = await signInAs(database, 'demo-1');
    const second = await signInAs(database, 'demo-2');
    const outsider = await signInAs(database, 'demo-outside', { groupId: 'other-group' });
    const timeline = await openStream(baseUrl, second);
    const unread = await openStream(baseUrl, second, 'startFromLatest=true&metadataOnly=true');
    assert.equal((await unread.next()).name, 'checkpoint');
    try {
      const before = Number(
        database.prepare('SELECT COUNT(*) AS count FROM realtime_events').get().count,
      );
      const addResponse = await react(baseUrl, author, true);
      const added = await addResponse.json();
      const addEvent = await timeline.next();
      assert.equal(addEvent.name, 'reaction');
      // No `id:` line: a reaction can never move a client's reconnect cursor.
      assert.equal(addEvent.id, null);
      assert.deepEqual(Object.keys(addEvent.data).sort(), [
        'groupId',
        'messageId',
        'occurredAt',
        'reactionCounts',
        'revision',
        'type',
      ]);
      assert.equal(addEvent.data.type, 'reaction');
      assert.equal(addEvent.data.groupId, 'demo-group');
      assert.equal(addEvent.data.messageId, 'demo-message');
      assert.equal(addEvent.data.reactionCounts['✨'], added.message.reactionCounts['✨']);
      assert.equal(addEvent.data.revision, added.reactionRevision);
      // The actor's own `active` state is never broadcast as another viewer's state.
      assert.equal('active' in addEvent.data, false);
      assert.equal('memberId' in addEvent.data, false);

      // Repeating the same add is idempotent: same absolute counts, newer revision.
      const repeat = await (await react(baseUrl, author, true)).json();
      const repeatEvent = await timeline.next();
      assert.equal(repeatEvent.data.reactionCounts['✨'], addEvent.data.reactionCounts['✨']);
      assert.ok(repeatEvent.data.revision > addEvent.data.revision);
      assert.equal(repeat.reactionRevision, repeatEvent.data.revision);

      const removed = await (await react(baseUrl, author, false)).json();
      const removeEvent = await timeline.next();
      assert.equal(removeEvent.name, 'reaction');
      assert.equal(
        removeEvent.data.reactionCounts['✨'] ?? 0,
        addEvent.data.reactionCounts['✨'] - 1,
      );
      assert.equal(removeEvent.data.revision, removed.reactionRevision);
      assert.ok(removeEvent.data.revision > repeatEvent.data.revision);

      // No message was created and the unread observer saw nothing: its next
      // event is the next real message, with the next persisted event id.
      assert.equal(
        Number(database.prepare('SELECT COUNT(*) AS count FROM realtime_events').get().count),
        before,
      );
      assert.equal(await unread.next(300), null);
      const sent = await fetch(`${baseUrl}/realtime/groups/demo-group/messages`, {
        method: 'POST',
        headers: { ...author.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'After the reactions' }),
      });
      assert.equal(sent.status, 201);
      const unreadMessage = await unread.next();
      assert.equal(unreadMessage.name, 'message');
      assert.equal(unreadMessage.data.eventId, before + 1);
      assert.deepEqual(Object.keys(unreadMessage.data.message).sort(), ['groupId', 'memberId']);
      assert.equal((await timeline.next()).name, 'message');

      // An outsider can neither watch the group, react, nor read its counts.
      const outsiderStream = await fetch(`${baseUrl}/realtime/groups/demo-group/events`, {
        headers: outsider.headers,
      });
      assert.equal(outsiderStream.status, 403);
      assert.equal((await react(baseUrl, outsider, true)).status, 403);
      const outsiderSnapshot = await fetch(
        `${baseUrl}/realtime/groups/demo-group/reaction-counts`,
        {
          method: 'POST',
          headers: { ...outsider.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageIds: ['demo-message'] }),
        },
      );
      assert.equal(outsiderSnapshot.status, 403);
      // A group member cannot reach a message through another group's path.
      const wrongGroup = await fetch(REACTIONS_URL(baseUrl, 'other-group'), {
        method: 'POST',
        headers: { ...second.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji: '✨', active: true }),
      });
      assert.equal(wrongGroup.status, 403);
    } finally {
      await timeline.close();
      await unread.close();
    }
  });
});

test('a foreign-group member never receives reaction events for this group', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    database.exec(`
      INSERT INTO profiles (id, display_name, avatar_label, is_synthetic)
        VALUES ('demo-outside', 'Outside', 'Outside', 1);
      INSERT INTO groups (id, name, current_cycle_id) VALUES ('other-group', 'Other', NULL);
      INSERT INTO memberships (group_id, member_id, role, accepted_at)
        VALUES ('other-group', 'demo-outside', 'member', '2026-09-13T00:00:00.000Z');
    `);
    const author = await signInAs(database, 'demo-1');
    const outsider = await signInAs(database, 'demo-outside', { groupId: 'other-group' });
    const foreign = await fetch(`${baseUrl}/realtime/groups/other-group/events?sinceEventId=0`, {
      headers: outsider.headers,
    });
    assert.equal(foreign.status, 200);
    const reader = foreign.body.getReader();
    try {
      assert.equal((await react(baseUrl, author, true)).status, 200);
      const read = await Promise.race([
        reader.read().then((chunk) => new TextDecoder().decode(chunk.value)),
        new Promise((resolve) => setTimeout(() => resolve(''), 400)),
      ]);
      assert.equal(read.includes('reaction'), false);
    } finally {
      await reader.cancel();
    }
  });
});

test('reaction events respect each viewer’s block and report rules', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const author = await signInAs(database, 'demo-1');
    const blocker = await signInAs(database, 'demo-2');
    const reporter = await signInAs(database, 'demo-3');
    const plain = await signInAs(database, 'demo-4');
    const streams = {
      blocker: await openStream(baseUrl, blocker),
      reporter: await openStream(baseUrl, reporter),
      plain: await openStream(baseUrl, plain),
    };
    try {
      // The block and the report land while the viewers' streams are already open.
      assert.equal(blockMember(database, blocker.account.id, 'demo-1'), 'blocked');
      assert.equal(
        reportContent(database, reporter.account.id, 'demo-group', {
          messageId: 'demo-message',
          reason: 'spam',
        }),
        'reported',
      );
      const reacted = await react(baseUrl, plain, true);
      assert.equal(reacted.status, 200);
      const delivered = await streams.plain.next();
      assert.equal(delivered.name, 'reaction');
      // Hidden content stays hidden: no event, and no count for that viewer.
      assert.equal(await streams.blocker.next(300), null);
      assert.equal(await streams.reporter.next(300), null);

      const snapshotFor = async (session) => {
        const response = await fetch(`${baseUrl}/realtime/groups/demo-group/reaction-counts`, {
          method: 'POST',
          headers: { ...session.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageIds: ['demo-message'] }),
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      assert.deepEqual((await snapshotFor(blocker)).messages, []);
      assert.deepEqual((await snapshotFor(reporter)).messages, []);
      assert.equal((await snapshotFor(plain)).messages.length, 1);
      assert.equal((await snapshotFor(author)).messages.length, 1);
      // The hidden viewers cannot react either (existing rule, kept).
      assert.equal((await react(baseUrl, blocker, true)).status, 404);
      assert.equal((await react(baseUrl, reporter, true)).status, 404);
    } finally {
      for (const stream of Object.values(streams)) await stream.close();
    }
  });
});

test('a revoked session’s open stream is denied instead of receiving reactions', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const author = await signInAs(database, 'demo-1');
    const leaving = await signInAs(database, 'demo-2');
    const stream = await openStream(baseUrl, leaving);
    try {
      const revoked = await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: leaving.headers,
      });
      assert.equal(revoked.status, 200);
      assert.equal((await react(baseUrl, author, true)).status, 200);
      const denied = await stream.next();
      assert.equal(denied.name, 'access-denied');
      assert.equal(await stream.next(200), null);
    } finally {
      await stream.close();
    }
  });
});

test('reaction snapshots reconcile missed changes for any loaded message', async () => {
  await withRuntime(async ({ baseUrl, database }) => {
    const author = await signInAs(database, 'demo-1');
    const away = await signInAs(database, 'demo-2');
    // An older message, far behind the latest history page.
    for (let index = 0; index < 120; index += 1) {
      const eventId = `old-${index}`;
      database
        .prepare(
          'INSERT INTO messages (id, group_id, member_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(eventId, 'demo-group', 'demo-1', `Old ${index}`, '2026-09-02T00:00:00.000Z');
      database
        .prepare(
          `INSERT INTO realtime_events (group_id, message_id, event_type, occurred_at)
           VALUES ('demo-group', ?, 'message', '2026-09-02T00:00:00.000Z')`,
        )
        .run(eventId);
    }
    const snapshot = async (messageIds, session = away) => {
      const response = await fetch(`${baseUrl}/realtime/groups/demo-group/reaction-counts`, {
        method: 'POST',
        headers: { ...session.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIds }),
      });
      return { status: response.status, body: await response.json() };
    };
    const history = await fetch(`${baseUrl}/realtime/groups/demo-group/messages?limit=100`, {
      headers: away.headers,
    }).then((response) => response.json());
    assert.ok(Number.isSafeInteger(history.reactionRevision));
    const loadedIds = history.events.map(({ message }) => message.id);
    assert.equal(loadedIds.includes('old-0'), false);

    // While `away` is disconnected, the author reacts to an old and a newer message.
    await react(baseUrl, author, true, 'old-0');
    await react(baseUrl, author, true, 'old-119');
    const last = await (await react(baseUrl, author, false, 'old-119')).json();

    const result = await snapshot(['old-0', 'old-119', 'demo-message', 'missing-message']);
    assert.equal(result.status, 200);
    assert.ok(result.body.revision >= last.reactionRevision);
    assert.ok(result.body.revision >= history.reactionRevision);
    const counts = Object.fromEntries(
      result.body.messages.map(({ messageId, reactionCounts }) => [messageId, reactionCounts]),
    );
    assert.deepEqual(Object.keys(counts).sort(), ['demo-message', 'old-0', 'old-119']);
    assert.equal(counts['old-0']['✨'], 1);
    assert.equal(counts['old-119']['✨'] ?? 0, 0);
    assert.equal(Object.keys(result.body.messages[0]).includes('memberId'), false);
    // Reading a snapshot does not create events or change unread counts.
    assert.equal(
      Number(database.prepare('SELECT COUNT(*) AS count FROM realtime_events').get().count),
      121,
    );
    assert.equal(
      (await snapshot(Array.from({ length: 101 }, (_, index) => `m-${index}`))).status,
      400,
    );
    assert.equal((await snapshot('demo-message')).status, 400);
  });
});
