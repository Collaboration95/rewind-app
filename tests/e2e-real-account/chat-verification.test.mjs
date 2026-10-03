import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { installChatResponseLoss } from './chat-verification.mjs';

const targetPath = '/api/realtime/groups/fixture-group/messages';

test('response loss reaches the bound account fetch after persistence; retry preserves identity', async () => {
  const persisted = new Map();
  const requests = [];
  const window = {
    location: { href: 'https://fixture.example/' },
    fetch: async (input, init) => {
      requests.push({ input, init });
      const body = JSON.parse(init.body);
      const duplicate = persisted.has(body.messageId);
      if (!duplicate) {
        persisted.set(body.messageId, { eventId: 7, message: { id: body.messageId, ...body } });
      }
      return new Response(
        JSON.stringify({ event: persisted.get(body.messageId), deduplicated: duplicate }),
        {
          status: duplicate ? 200 : 201,
        },
      );
    },
  };
  runInNewContext(`(${installChatResponseLoss.toString()})()`, { window, URL });
  // RealAccountClient binds its fetcher during construction, before the fault is armed.
  const accountFetch = window.fetch.bind(window);
  window.__rewindChatResponseLoss.targetPath = targetPath;
  const init = {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messageId: 'fixture-reply',
      body: 'Synthetic reply',
      replyToMessageId: 'fixture-root',
    }),
  };
  await assert.rejects(
    accountFetch(`https://fixture.example${targetPath}`, init),
    /Fixture response lost after persistence/,
  );
  const fixture = window.__rewindChatResponseLoss;
  assert.equal(fixture.status, 201);
  assert.equal(fixture.firstRequestBody.messageId, 'fixture-reply');
  assert.equal(fixture.persistedReply.message.id, 'fixture-reply');
  const replay = await accountFetch(`https://fixture.example${targetPath}`, init);
  assert.equal(replay.status, 200);
  const payload = await replay.json();
  assert.equal(payload.deduplicated, true);
  assert.deepEqual(payload.event, fixture.persistedReply);
  assert.equal(persisted.size, 1);
  assert.equal(requests[0].init.body, requests[1].init.body);
  assert.equal(requests[0].init.credentials, 'include');
});

test('unarmed, unrelated paths and SSE reads retain the original fetch response', async () => {
  const response = new Response('{}');
  let calls = 0;
  const window = {
    location: { href: 'https://fixture.example/' },
    fetch: async () => {
      calls += 1;
      return response;
    },
  };
  runInNewContext(`(${installChatResponseLoss.toString()})()`, { window, URL });
  assert.equal(await window.fetch(targetPath, { method: 'POST' }), response);
  window.__rewindChatResponseLoss.targetPath = targetPath;
  assert.equal(await window.fetch('/api/other', { method: 'POST' }), response);
  assert.equal(await window.fetch(new Request(`https://fixture.example${targetPath}`)), response);
  assert.equal(window.__rewindChatResponseLoss.targetPath, targetPath);
  assert.equal(calls, 3);
});
