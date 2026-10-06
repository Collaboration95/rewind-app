import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openFixtureDatabase } from './helpers/fixture-group.mjs';

const { parseConfig } = await import('../dist/config.js');
const { createRuntimeServer } = await import('../dist/http.js');
const { requestRoute } = await import('../dist/observability/index.js');

test('request routes drop queries and identifier-like segments (#321)', () => {
  assert.equal(
    requestRoute('/real/groups/real-group-30c9342b-32c4-4370-853a-1b8b1ee5b766/members?x=1'),
    '/real/groups/:id/members',
  );
  assert.equal(requestRoute(`/media/access/${'a'.repeat(43)}`), '/media/access/:id');
  assert.equal(requestRoute('/contributions?groupId=secret'), '/contributions');
  assert.equal(requestRoute('/health'), '/health');
  assert.equal(requestRoute('/groups/demo-group'), '/groups/:id');
  assert.equal(requestRoute('/alice@example.com'), '/:id');
  assert.equal(requestRoute('/real/groups/current'), '/real/groups/current');
});

async function serve(env, run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-request-timing-`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_PORT: '0', ...env });
  const database = openFixtureDatabase(config);
  const server = createRuntimeServer(config, database);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, lines);
  } finally {
    console.log = log;
    await new Promise((done) => server.close(done));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('REWIND_REQUEST_TIMING logs one JSON line per request; off by default', async () => {
  await serve({ REWIND_REQUEST_TIMING: 'true' }, async (base, lines) => {
    await (await fetch(`${base}/health?probe=1`)).text();
    await new Promise((done) => setTimeout(done, 20));
    const timing = lines
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === 'api.request');
    assert.ok(timing, 'no timing line was logged');
    assert.equal(timing.method, 'GET');
    assert.equal(timing.route, '/health');
    assert.equal(timing.statusCode, 200);
    assert.ok(Number.isInteger(timing.durationMs) && timing.durationMs >= 0);
  });
  await serve({}, async (base, lines) => {
    await (await fetch(`${base}/health`)).text();
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(lines.filter((line) => line.includes('api.request')).length, 0);
  });
});
