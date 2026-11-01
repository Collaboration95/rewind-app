import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatMessage, listChatEvents, toggleChatReaction } from '../dist/chat/index.js';
import { withBoundaryRuntime } from './helpers/boundary-runtime.mjs';

async function scenario(run) {
  await withBoundaryRuntime(async (c) => {
    const owner = await c.account('chat-contract-owner');
    const member = await c.account('chat-contract-member');
    const group = await c.group(owner);
    const joined = await c.join(owner, member, group.group.id);
    const path = `/realtime/groups/${group.group.id}/messages`;
    await run({ ...c, makeGroup: c.group, owner, member, group, joined, path });
  });
}

test('chat validates body type, trimmed emptiness and the 2000-character boundary without writing events', async () => {
  await scenario(async (c) => {
    for (const [body, error] of [
      [null, 'message_empty_body'],
      [42, 'message_empty_body'],
      [' \n\t ', 'message_empty_body'],
      ['x'.repeat(2001), 'message_body_too_long'],
    ]) {
      const response = await c.post(c.path, c.owner, { body });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, error);
    }
    assert.deepEqual((await (await c.request(c.path, { actor: c.member })).json()).events, []);
    const accepted = await c.post(c.path, c.owner, { body: `  ${'x'.repeat(2000)}  ` });
    assert.equal(accepted.status, 201);
    assert.equal((await accepted.json()).message.body, 'x'.repeat(2000));
  });
});

test('message retry keys reject changed text, changed authors and changed reply targets', async () => {
  await scenario(async (c) => {
    const original = { body: 'A private original', messageId: 'contract-root' };
    const sent = await c.post(c.path, c.owner, original);
    assert.equal(sent.status, 201);
    const event = (await sent.json()).event;
    const retry = await c.post(c.path, c.owner, { ...original, body: '  A private original  ' });
    assert.equal(retry.status, 200);
    const replay = await retry.json();
    assert.equal(replay.deduplicated, true);
    assert.deepEqual(replay.event, event);
    for (const [actor, body] of [
      [c.owner, { ...original, body: 'changed' }],
      [c.member, original],
      [c.owner, { ...original, replyToMessageId: 'contract-root' }],
    ]) {
      const response = await c.post(c.path, actor, body);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, 'message_duplicate_message');
    }
    const events = (await (await c.request(c.path, { actor: c.member })).json()).events;
    assert.deepEqual(events, [event]);
  });
});

test('replies reject absent, foreign-group and nested parents without leaking their contents', async () => {
  await scenario(async (c) => {
    const other = await c.account('chat-contract-other');
    const foreignGroup = await c.makeGroup(other);
    const foreignPath = `/realtime/groups/${foreignGroup.group.id}/messages`;
    assert.equal(
      (await c.post(foreignPath, other, { messageId: 'foreign-root', body: 'Foreign secret' }))
        .status,
      201,
    );
    assert.equal(
      (await c.post(c.path, c.owner, { messageId: 'local-root', body: 'Local root' })).status,
      201,
    );
    const reply = await c.post(c.path, c.member, {
      messageId: 'local-reply',
      body: 'Reply',
      replyToMessageId: 'local-root',
    });
    assert.equal(reply.status, 201);
    assert.equal((await reply.json()).message.replyTo.body, 'Local root');
    for (const replyToMessageId of ['absent-root', 'foreign-root']) {
      const response = await c.post(c.path, c.member, {
        body: 'Must not persist',
        replyToMessageId,
      });
      assert.equal(response.status, 404);
      assert.doesNotMatch(await response.text(), /Foreign secret|foreign-root/);
    }
    const nested = await c.post(c.path, c.member, {
      body: 'Nested',
      replyToMessageId: 'local-reply',
    });
    assert.equal(nested.status, 400);
    assert.equal((await nested.json()).error, 'message_nested_reply_not_allowed');
    const events = (await (await c.request(c.path, { actor: c.owner })).json()).events;
    assert.deepEqual(
      events.map((event) => event.message.id),
      ['local-root', 'local-reply'],
    );
  });
});

test('invalid service clocks roll back chat writes and leave the next valid transaction usable', async () => {
  await scenario(async (c) => {
    const input = {
      groupId: c.group.group.id,
      memberId: c.group.memberId,
      body: 'Valid body',
      messageId: 'clock-message',
    };
    for (const now of [new Date(NaN), () => new Date(NaN)]) {
      assert.deepEqual(createChatMessage(c.database, { ...input, now }), {
        ok: false,
        reason: 'invalid_timestamp',
      });
      assert.deepEqual(toggleChatReaction(c.database, { ...input, emoji: '✨', now }), {
        ok: false,
        reason: 'invalid_timestamp',
      });
    }
    assert.deepEqual(listChatEvents(c.database, c.group.group.id), []);
    assert.equal(createChatMessage(c.database, { ...input, now: c.now }).ok, true);
    const reaction = await c.post(`${c.path}/clock-message/reactions`, c.member, {
      emoji: 'unsupported',
    });
    assert.equal(reaction.status, 400);
    assert.equal((await reaction.json()).error, 'reaction_unsupported_reaction');
    const missing = await c.post(`${c.path}/missing/reactions`, c.member, { emoji: '✨' });
    assert.equal(missing.status, 404);
    assert.deepEqual(listChatEvents(c.database, c.group.group.id)[0].message.reactionCounts, {});
  });
});
