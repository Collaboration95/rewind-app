import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { uploadFixture } from './helpers/fixture-upload.mjs';

const fixture = {
  authorization: 'Bearer synthetic-test-token',
  mimeType: 'video/mp4',
  bytes: Buffer.from('synthetic fixture bytes'),
};

async function withServer(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('fixture upload sends unchanged bytes and authority only to its owned test server', async (t) => {
  const { server, origin } = await withServer(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.writeHead(201, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        mimeType: request.headers['content-type'],
        bytes: Buffer.concat(chunks).toString(),
      }),
    );
  });
  const response = await uploadFixture(server, `${origin}/upload?groupId=synthetic`, fixture);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    method: 'POST',
    path: '/upload?groupId=synthetic',
    authorization: fixture.authorization,
    mimeType: fixture.mimeType,
    bytes: fixture.bytes.toString(),
  });
});

test('fixture upload rejects other origins and URL credentials before sending bytes', async (t) => {
  let requests = 0;
  const handler = (_request, response) => {
    requests += 1;
    response.end('{}');
  };
  const owned = await withServer(t, handler);
  const other = await withServer(t, handler);
  for (const destination of [
    `${other.origin}/upload`,
    'https://example.invalid/upload',
    owned.origin.replace('127.0.0.1', 'localhost') + '/upload',
    owned.origin.replace('http:', 'https:') + '/upload',
    owned.origin.replace('127.0.0.1', '127.0.0.2') + '/upload',
    owned.origin.replace('http://', 'http://user:password@') + '/upload',
    `${owned.origin}/upload#fragment`,
    'not a URL',
  ]) {
    await assert.rejects(uploadFixture(owned.server, destination, fixture));
  }
  assert.equal(requests, 0);
});

test('fixture upload requires a live server explicitly bound to IPv4 loopback', async () => {
  for (const server of [
    createServer(),
    { listening: true, address: () => ({ address: '0.0.0.0', port: 12345 }) },
    { listening: true, address: () => ({ address: '::', port: 12345 }) },
    { listening: true, address: () => '/tmp/test.socket' },
  ]) {
    await assert.rejects(
      uploadFixture(server, 'http://127.0.0.1:12345/upload', fixture),
      /listening IPv4 loopback test server/,
    );
  }
});

test('fixture upload never replays bytes or authority to redirect targets', async (t) => {
  let targetRequests = 0;
  const target = await withServer(t, (_request, response) => {
    targetRequests += 1;
    response.end('{}');
  });
  const owned = await withServer(t, (request, response) => {
    request.resume();
    response.writeHead(Number(request.url.slice(1)), { Location: `${target.origin}/upload` });
    response.end();
  });
  for (const status of [301, 302, 303, 307, 308]) {
    await assert.rejects(
      uploadFixture(owned.server, `${owned.origin}/${status}`, fixture),
      /must not follow redirects/,
    );
  }
  assert.equal(targetRequests, 0);
});
