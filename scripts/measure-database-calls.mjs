// Count database work per API request on PostgreSQL (#261).
//
// Runs the real HTTP server against a throwaway PostgreSQL database, walks a
// typical two-member session (sign-up, group, invite, home, chat), and prints
// each request's statements, server round trips and database milliseconds
// from its Server-Timing header. Round trips are what network latency
// multiplies: hosted cost per request ~= round trips x the host-to-database
// round-trip time.
//
//   node scripts/measure-database-calls.mjs [--json]
//
// Uses REWIND_TEST_POSTGRES_URL (default: the `make postgres-test-db` server).
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import pg from 'pg';

const adminUrl =
  process.env.REWIND_TEST_POSTGRES_URL ?? 'postgres://postgres:devpass@127.0.0.1:55432/postgres';
const databaseName = `rewind_measure_${randomBytes(4).toString('hex')}`;
const admin = async (sql) => {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
};
await admin(`CREATE DATABASE ${databaseName} TEMPLATE template0`);
const url = new URL(adminUrl);
url.pathname = `/${databaseName}`;

const dataDir = await mkdtemp(join(tmpdir(), 'rewind-measure-'));
const { parseConfig } = await import(resolve('server/dist/config.js'));
const { openDatabase } = await import(resolve('server/dist/db.js'));
const { createRuntimeServer } = await import(resolve('server/dist/http.js'));
const config = parseConfig({
  REWIND_DATA_DIR: dataDir,
  REWIND_HOST: '127.0.0.1',
  REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true',
  REWIND_DATABASE_URL: url.toString(),
  REWIND_DATABASE_TLS: 'disable',
});
const database = openDatabase(config);
const server = createRuntimeServer(config, database);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
async function call(label, method, path, { token, body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const timing = /dur=([\d.]+);desc="(\d+) statements, (\d+) round trips"/.exec(
    response.headers.get('server-timing') ?? '',
  );
  results.push({
    request: label,
    status: response.status,
    statements: timing ? Number(timing[2]) : 0,
    roundTrips: timing ? Number(timing[3]) : 0,
    databaseMs: timing ? Number(timing[1]) : 0,
  });
  if (response.status >= 400) throw new Error(`${label}: ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const password = 'measurement password 2026';
try {
  await call('register owner', 'POST', '/auth/register', {
    body: { username: 'measure.owner', password, clientType: 'native' },
  });
  const owner = (
    await call('sign in', 'POST', '/auth/login', {
      body: { username: 'measure.owner', password, clientType: 'native' },
    })
  ).token;
  const created = await call('create group', 'POST', '/real/groups', {
    token: owner,
    body: { name: 'Measure', prompt: 'What moved you?', maxMembers: 4 },
  });
  const groupId = created.group.id;
  const invite = await call('create invite', 'POST', `/real/groups/${groupId}/invites`, {
    token: owner,
    body: {},
  });
  await call('register member', 'POST', '/auth/register', {
    body: { username: 'measure.member', password, clientType: 'native' },
  });
  const member = (
    await call('sign in', 'POST', '/auth/login', {
      body: { username: 'measure.member', password, clientType: 'native' },
    })
  ).token;
  await call('accept invite', 'POST', '/real/invites/accept', {
    token: member,
    body: { code: invite.invite.code, groupId },
  });
  for (let round = 0; round < 2; round += 1) {
    await call('GET /auth/session', 'GET', '/auth/session', { token: owner });
    await call('GET /real/groups/current', 'GET', '/real/groups/current', { token: owner });
    await call('GET /real/groups', 'GET', '/real/groups', { token: owner });
    await call('GET members', 'GET', `/real/groups/${groupId}/members`, { token: owner });
    await call('GET /contributions', 'GET', `/contributions?groupId=${groupId}`, {
      token: owner,
    });
    await call('GET /archive', 'GET', `/archive?groupId=${groupId}`, { token: owner });
    await call('GET chat history', 'GET', `/realtime/groups/${groupId}/messages?limit=50`, {
      token: owner,
    });
    await call('POST chat message', 'POST', `/realtime/groups/${groupId}/messages`, {
      token: owner,
      body: { body: `hello ${round}` },
    });
    await call('POST chat message', 'POST', `/realtime/groups/${groupId}/messages`, {
      token: member,
      body: { body: `reply ${round}` },
    });
  }
} finally {
  server.close();
  database.close();
  await rm(dataDir, { recursive: true, force: true });
  await admin(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
}

// Report the steady state: the last observation of each request.
const latest = new Map(results.map((row) => [row.request, row]));
if (process.argv.includes('--json')) console.log(JSON.stringify([...latest.values()]));
else console.table([...latest.values()]);
