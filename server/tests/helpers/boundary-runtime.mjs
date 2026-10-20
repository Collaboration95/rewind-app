import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseConfig } from '../../dist/config.js';
import { openDatabase } from '../../dist/db.js';
import { createRuntimeServer } from '../../dist/http.js';
import { realAccount, REAL_AUTH_ENV } from './real-http.mjs';

export const BOUNDARY_NOW = new Date('2026-10-18T08:00:00.000Z');

/** Empty, migrated runtime: every account and group belongs to this test. */
export async function withBoundaryRuntime(run, { env = {}, options = {} } = {}) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-boundary-`);
  const config = parseConfig({
    REWIND_DATA_DIR: dataDir,
    REWIND_HOST: '127.0.0.1',
    REWIND_PORT: '0',
    ...REAL_AUTH_ENV,
    ...env,
  });
  const database = openDatabase(config);
  let now = new Date(BOUNDARY_NOW);
  const server = createRuntimeServer(config, database, { now: () => now, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { actor, body, headers, ...init } = {}) =>
    fetch(baseUrl + path, {
      ...init,
      headers: {
        ...actor?.headers,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const post = (path, actor, body = {}) => request(path, { method: 'POST', actor, body });
  const group = async (owner, fields = {}) => {
    const response = await post('/real/groups', owner, {
      name: 'Boundary group',
      prompt: 'A private moment?',
      maxMembers: 5,
      ...fields,
    });
    assert.equal(response.status, 201);
    return response.json();
  };
  const invite = async (owner, groupId, fields = {}) => {
    const response = await post(`/real/groups/${groupId}/invites`, owner, fields);
    assert.equal(response.status, 201);
    return (await response.json()).invite;
  };
  const join = async (owner, member, groupId) => {
    const invitation = await invite(owner, groupId);
    const response = await post('/real/invites/accept', member, { code: invitation.code });
    assert.equal(response.status, 200);
    return (await response.json()).group;
  };
  try {
    await run({
      config,
      database,
      dataDir,
      baseUrl,
      request,
      post,
      group,
      invite,
      join,
      account: (username) => realAccount(database, username, now),
      now: () => now,
      setNow: (value) => (now = new Date(value)),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
