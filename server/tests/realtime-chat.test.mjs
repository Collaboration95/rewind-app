import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const { createRuntimeServer } = await import('../dist/http.js');

async function startRuntime(config, database) {
  const server = createRuntimeServer(config, database);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
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
      if (data) return { event: JSON.parse(data), pending: buffer };
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
