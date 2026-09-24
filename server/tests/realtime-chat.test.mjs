import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const { createGroup } = await import('../dist/groups/index.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { RealtimeHub } = await import('../dist/realtime/index.js');

async function startRuntime(config, database, options = {}) {
  const server = createRuntimeServer(config, database, options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function readUntilClosed(reader, timeoutMs = 500) {
  return Promise.race([
    (async () => {
      while (true) {
        const result = await reader.read();
        if (result.done) return true;
      }
    })(),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function closeRuntime(server, database, dataDir) {
  await new Promise((resolve) => server.close(resolve));
  database.close();
  await rm(dataDir, { recursive: true, force: true });
}

async function createSession(baseUrl, memberId, groupId = 'demo-group') {
  const response = await fetch(`${baseUrl}/sessions/demo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, groupId }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).session;
}

function delayedMessageRequest(baseUrl, sessionId) {
  const url = new URL(
    `${baseUrl}/realtime/groups/demo-group/messages?sessionId=${encodeURIComponent(sessionId)}`,
  );
  let resolveResponse;
  let rejectResponse;
  let resolveStarted;
  const responsePromise = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const startedPromise = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const request = httpRequest(
    {
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Expect: '100-continue',
        'Transfer-Encoding': 'chunked',
      },
    },
    (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolveResponse({ status: response.statusCode, body }));
    },
  );
  request.on('error', rejectResponse);
  request.on('continue', () => {
    request.write('{"body":"message held open');
    resolveStarted();
  });
  request.flushHeaders();
  return { request, responsePromise, startedPromise };
}

async function readSseEvent(reader, pending = '') {
  let buffer = pending;
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
      if (data) {
        const eventName = block.match(/^event: (.+)$/m)?.[1] ?? 'message';
        const eventId = block.match(/^id: (.+)$/m)?.[1] ?? null;
        return { event: JSON.parse(data), eventName, eventId, pending: buffer };
      }
      continue;
    }
    const chunk = await reader.read();
    assert.equal(chunk.done, false, 'the realtime stream closed before an event arrived');
    buffer += new TextDecoder().decode(chunk.value);
  }
}

test('two authorised sessions receive a persisted group message over SSE', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-realtime-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  const { server, baseUrl } = await startRuntime(config, database);
  const first = await createSession(baseUrl, 'demo-1');
  const second = await createSession(baseUrl, 'demo-2');
  const streams = await Promise.all(
    [first, second].map((session) =>
      fetch(
        `${baseUrl}/realtime/groups/demo-group/events?sessionId=${encodeURIComponent(session.id)}&sinceEventId=1`,
      ),
    ),
  );
  const readers = streams.map((stream) => {
    assert.equal(stream.status, 200);
    return stream.body.getReader();
  });
  try {
    const sent = await fetch(
      `${baseUrl}/realtime/groups/demo-group/messages?sessionId=${encodeURIComponent(first.id)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'A message delivered to both sessions.' }),
      },
    );
    assert.equal(sent.status, 201);
    const sentPayload = await sent.json();
    assert.equal(sentPayload.event.message.body, 'A message delivered to both sessions.');
    const received = await Promise.all(readers.map((reader) => readSseEvent(reader)));
    assert.deepEqual(
      received.map(({ event }) => event.message.id),
      [sentPayload.event.message.id, sentPayload.event.message.id],
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM realtime_events').get().count, 2);
  } finally {
    for (const reader of readers) await reader.cancel();
    await closeRuntime(server, database, dataDir);
  }
});

test('a non-member cannot open a group realtime subscription or post', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-realtime-denial-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  const { server, baseUrl } = await startRuntime(config, database);
  const session = await createSession(baseUrl, 'demo-2');
  try {
    for (const request of [
      fetch(
        `${baseUrl}/realtime/groups/missing-group/events?sessionId=${encodeURIComponent(session.id)}`,
      ),
      fetch(
        `${baseUrl}/realtime/groups/missing-group/messages?sessionId=${encodeURIComponent(session.id)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: 'must not persist' }),
        },
      ),
    ]) {
      const response = await request;
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), {
        allowed: false,
        status: 403,
        error: 'forbidden',
        message: 'You do not have access to this resource.',
      });
    }
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE body = 'must not persist'")
        .get().count,
      0,
    );
  } finally {
    await closeRuntime(server, database, dataDir);
  }
});

test('an EventSource-compatible denial sends a terminal SSE event', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-realtime-sse-denial-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  const { server, baseUrl } = await startRuntime(config, database);
  const session = await createSession(baseUrl, 'demo-2');
  try {
    const response = await fetch(
      `${baseUrl}/realtime/groups/missing-group/events?sessionId=${encodeURIComponent(session.id)}`,
      { headers: { Accept: 'text/event-stream' } },
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /event: access-denied/);
    assert.match(body, /"status":403/);
  } finally {
    await closeRuntime(server, database, dataDir);
  }
});

test('a session invalidated while the request body is delayed cannot persist a message', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-realtime-delay-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  const { server, baseUrl } = await startRuntime(config, database);
  const session = await createSession(baseUrl, 'demo-1');
  try {
    const delayed = delayedMessageRequest(baseUrl, session.id);
    await delayed.startedPromise;
    const invalidated = await fetch(`${baseUrl}/sessions/${encodeURIComponent(session.id)}`, {
      method: 'DELETE',
    });
    assert.equal(invalidated.status, 200);
    delayed.request.end('"}');
    const result = await delayed.responsePromise;
    assert.equal(result.status, 403);
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE body LIKE 'message held open%'")
        .get().count,
      0,
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM realtime_events').get().count, 1);
  } finally {
    await closeRuntime(server, database, dataDir);
  }
});

test('realtime delivery is isolated to the subscribed group', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-realtime-isolation-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  database.exec(`
    INSERT INTO profiles (id, display_name, avatar_label, is_synthetic)
      VALUES ('demo-6', 'Fable', 'Fable, second-group member', 1);
    INSERT INTO groups (id, name, current_cycle_id)
      VALUES ('other-group', 'Other People', 'other-cycle');
    INSERT INTO cycles
      (id, group_id, prompt, starts_at, ends_at, status, lock_state,
       max_count, max_seconds, count_used, seconds_used)
      VALUES
      ('other-cycle', 'other-group', 'A private prompt',
       '2026-09-01T00:00:00.000Z', '2026-09-12T00:00:00.000Z',
       'collecting', 'locked', 5, 30, 0, 0);
    INSERT INTO memberships (group_id, member_id, role, accepted_at)
      VALUES ('other-group', 'demo-6', 'member', '2026-09-01T00:00:00.000Z');
  `);
  const { server, baseUrl } = await startRuntime(config, database);
  const first = await createSession(baseUrl, 'demo-1');
  const second = await createSession(baseUrl, 'demo-6', 'other-group');
  const firstStream = await fetch(
    `${baseUrl}/realtime/groups/demo-group/events?sessionId=${encodeURIComponent(first.id)}&sinceEventId=1`,
  );
  const secondStream = await fetch(
    `${baseUrl}/realtime/groups/other-group/events?sessionId=${encodeURIComponent(second.id)}`,
  );
  assert.equal(firstStream.status, 200);
  assert.equal(secondStream.status, 200);
  const firstReader = firstStream.body.getReader();
  const secondReader = secondStream.body.getReader();
  try {
    const sent = await fetch(
      `${baseUrl}/realtime/groups/demo-group/messages?sessionId=${encodeURIComponent(first.id)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'only the first group sees this' }),
      },
    );
    assert.equal(sent.status, 201);
    const received = await readSseEvent(firstReader);
    assert.equal(received.event.message.body, 'only the first group sees this');
    const noCrossGroupEvent = await Promise.race([
      readSseEvent(secondReader).then(() => false),
      new Promise((resolve) => setTimeout(() => resolve(true), 100)),
    ]);
    assert.equal(noCrossGroupEvent, true);
  } finally {
    await firstReader.cancel();
    await secondReader.cancel();
    await closeRuntime(server, database, dataDir);
  }
});

test('heartbeat closes and removes a subscription after its session is revoked', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-realtime-revocation-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  const hub = new RealtimeHub();
  const { server, baseUrl } = await startRuntime(config, database, {
    realtimeHeartbeatIntervalMs: 10,
    realtimeHub: hub,
  });
  const session = await createSession(baseUrl, 'demo-2');
  const stream = await fetch(
    `${baseUrl}/realtime/groups/demo-group/events?sessionId=${encodeURIComponent(session.id)}&sinceEventId=1`,
  );
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  try {
    const connected = await reader.read();
    assert.equal(connected.done, false);
    assert.equal(hub.subscriberCount('demo-group'), 1);
    const revoked = await fetch(`${baseUrl}/sessions/${encodeURIComponent(session.id)}`, {
      method: 'DELETE',
    });
    assert.equal(revoked.status, 200);
    assert.equal(await readUntilClosed(reader), true);
    assert.equal(hub.subscriberCount('demo-group'), 0);
  } finally {
    await reader.cancel();
    await closeRuntime(server, database, dataDir);
  }
});

test('persisted message events replay after the runtime and database are reopened', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-realtime-restart-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  const firstRuntime = await startRuntime(config, database);
  const session = await createSession(firstRuntime.baseUrl, 'demo-1');
  const sent = await fetch(
    `${firstRuntime.baseUrl}/realtime/groups/demo-group/messages?sessionId=${encodeURIComponent(session.id)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'survives a local runtime restart' }),
    },
  );
  assert.equal(sent.status, 201);
  const sentPayload = await sent.json();
  await new Promise((resolve) => firstRuntime.server.close(resolve));
  database.close();

  const reopened = openDatabase(config);
  const secondRuntime = await startRuntime(config, reopened);
  const stream = await fetch(
    `${secondRuntime.baseUrl}/realtime/groups/demo-group/events?sessionId=${encodeURIComponent(session.id)}&sinceEventId=1`,
  );
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  try {
    const { event } = await readSseEvent(reader);
    assert.equal(event.eventId, sentPayload.event.eventId);
    assert.equal(event.message.body, 'survives a local runtime restart');
  } finally {
    await reader.cancel();
    await closeRuntime(secondRuntime.server, reopened, dataDir);
  }
});

test('a zero checkpoint cursor replays messages after an unread stream replacement', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-realtime-zero-checkpoint-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  const { server, baseUrl } = await startRuntime(config, database);
  const created = createGroup(database, 'demo-1', {
    name: 'Zero checkpoint test',
    prompt: 'What is worth keeping?',
  });
  assert.equal(created.ok, true);
  const groupId = created.group.id;
  const session = await createSession(baseUrl, 'demo-1', groupId);
  try {
    const initial = await fetch(
      `${baseUrl}/realtime/groups/${encodeURIComponent(groupId)}/events?sessionId=${encodeURIComponent(session.id)}&startFromLatest=true`,
    );
    assert.equal(initial.status, 200);
    const initialReader = initial.body.getReader();
    try {
      const checkpoint = await readSseEvent(initialReader);
      assert.equal(checkpoint.eventName, 'checkpoint');
      assert.equal(checkpoint.event.eventId, 0);
    } finally {
      await initialReader.cancel();
    }

    const sent = await fetch(
      `${baseUrl}/realtime/groups/${encodeURIComponent(groupId)}/messages?sessionId=${encodeURIComponent(session.id)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'arrived during the replacement gap' }),
      },
    );
    assert.equal(sent.status, 201);
    const sentPayload = await sent.json();

    const resumed = await fetch(
      `${baseUrl}/realtime/groups/${encodeURIComponent(groupId)}/events?sessionId=${encodeURIComponent(session.id)}&sinceEventId=0`,
    );
    assert.equal(resumed.status, 200);
    const resumedReader = resumed.body.getReader();
    try {
      const replayed = await readSseEvent(resumedReader);
      assert.equal(replayed.eventName, 'message');
      assert.equal(replayed.event.eventId, sentPayload.event.eventId);
      assert.equal(replayed.event.message.body, 'arrived during the replacement gap');
    } finally {
      await resumedReader.cancel();
    }
  } finally {
    await closeRuntime(server, database, dataDir);
  }
});

test('a new unread observer skips persisted history but receives messages after its checkpoint', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-realtime-latest-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  const { server, baseUrl } = await startRuntime(config, database);
  const session = await createSession(baseUrl, 'demo-1');
  try {
    const historical = await fetch(
      `${baseUrl}/realtime/groups/demo-group/messages?sessionId=${encodeURIComponent(session.id)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'already present before unread subscription' }),
      },
    );
    assert.equal(historical.status, 201);
    const historicalEvent = (await historical.json()).event;

    const response = await fetch(
      `${baseUrl}/realtime/groups/demo-group/events?sessionId=${encodeURIComponent(session.id)}&startFromLatest=true`,
    );
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    try {
      const checkpoint = await readSseEvent(reader);
      assert.equal(checkpoint.eventName, 'checkpoint');
      assert.equal(Number(checkpoint.eventId), historicalEvent.eventId);
      assert.deepEqual(checkpoint.event, { eventId: historicalEvent.eventId });

      const next = await fetch(
        `${baseUrl}/realtime/groups/demo-group/messages?sessionId=${encodeURIComponent(session.id)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: 'arrived after unread subscription' }),
        },
      );
      assert.equal(next.status, 201);
      const nextEvent = (await next.json()).event;
      const received = await readSseEvent(reader);
      assert.equal(received.eventName, 'message');
      assert.equal(received.event.eventId, nextEvent.eventId);
      assert.equal(received.event.message.body, 'arrived after unread subscription');
    } finally {
      await reader.cancel();
    }
  } finally {
    await closeRuntime(server, database, dataDir);
  }
});

test('retrying the same client message id replays one persisted event', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-realtime-idempotency-test-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1' });
  const database = openDatabase(config);
  const hub = new RealtimeHub();
  const { server, baseUrl } = await startRuntime(config, database, { realtimeHub: hub });
  const session = await createSession(baseUrl, 'demo-1');
  try {
    const messageId = 'client-retry-message';
    const request = () =>
      fetch(
        `${baseUrl}/realtime/groups/demo-group/messages?sessionId=${encodeURIComponent(session.id)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: 'retry this safely', messageId }),
        },
      );
    const first = await request();
    assert.equal(first.status, 201);
    const firstPayload = await first.json();
    const retry = await request();
    assert.equal(retry.status, 200);
    const retryPayload = await retry.json();
    assert.equal(retryPayload.deduplicated, true);
    assert.deepEqual(retryPayload.event, firstPayload.event);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM messages WHERE id = ?').get(messageId).count,
      1,
    );
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM realtime_events WHERE message_id = ?')
        .get(messageId).count,
      1,
    );

    const conflict = await fetch(
      `${baseUrl}/realtime/groups/demo-group/messages?sessionId=${encodeURIComponent(session.id)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'different text', messageId }),
      },
    );
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error, 'message_duplicate_message');
  } finally {
    await closeRuntime(server, database, dataDir);
  }
});
