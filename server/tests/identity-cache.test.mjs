// The identity cache (#261): signed-in requests stop re-reading their session,
// selected group and membership, while the server's own changes apply at once.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { openFixtureDatabase } from './helpers/fixture-group.mjs';
import { onPostgres } from './helpers/dialect.mjs';

const { parseConfig } = await import('../dist/config.js');
const {
  authenticateRealAccount,
  createRealAccount,
  revokeRealSession,
  validateRealSession,
  SESSION_TOUCH_MS,
} = await import('../dist/auth/index.js');
const { IDENTITY_CACHE_TTL_MS } = await import('../dist/auth/identity-cache.js');
const { newDatabaseTiming, withDatabaseTiming } =
  await import('../dist/observability/database-timing.js');

const PASSWORD = 'identity cache password';
const T0 = new Date('2026-10-07T00:00:00.000Z');
const later = (ms) => new Date(T0.getTime() + ms);

async function withSignedIn(run) {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-identity-cache-`);
  const database = openFixtureDatabase(parseConfig({ REWIND_DATA_DIR: dataDir }));
  try {
    const created = await createRealAccount(database, 'cache.user', 'Cache User', PASSWORD, T0);
    const login = await authenticateRealAccount(database, 'cache.user', PASSWORD, 'client', T0);
    assert.equal(login.status, 'authenticated');
    await run({ database, account: created.account, token: login.token });
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const storedIdle = (database) =>
  database.prepare('SELECT idle_expires_at AS idle FROM real_account_sessions').get().idle;

test('a validated session is answered from memory until it changes', () =>
  withSignedIn(async ({ database, token }) => {
    assert.equal(validateRealSession(database, token, T0).status, 'valid');
    const timing = newDatabaseTiming();
    const again = withDatabaseTiming(timing, () =>
      validateRealSession(database, token, later(1000)),
    );
    assert.equal(again.status, 'valid');
    if (onPostgres) assert.equal(timing.statements, 0, 'no database work for a cached session');

    // A revocation outside the server applies once the cache entry lapses.
    database.prepare('UPDATE real_account_sessions SET revoked_at = ?').run(T0.toISOString());
    assert.equal(validateRealSession(database, token, later(2000)).status, 'valid');
    assert.equal(
      validateRealSession(database, token, later(IDENTITY_CACHE_TTL_MS + 2000)).status,
      'invalid',
    );
  }));

test("the server's own sign-out applies immediately", () =>
  withSignedIn(async ({ database, token }) => {
    assert.equal(validateRealSession(database, token, T0).status, 'valid');
    revokeRealSession(database, token, later(1000));
    assert.equal(validateRealSession(database, token, later(2000)).status, 'invalid');
  }));

test('the idle expiry slides in memory and is written at most every ten minutes', () =>
  withSignedIn(async ({ database, token }) => {
    validateRealSession(database, token, T0);
    const first = storedIdle(database);
    const minute = validateRealSession(database, token, later(60_000));
    assert.equal(storedIdle(database), first, 'no write one minute later');
    assert.ok(Date.parse(minute.idleExpiresAt) > Date.parse(first), 'the reported expiry slides');
    validateRealSession(database, token, later(SESSION_TOUCH_MS + 60_000));
    assert.ok(Date.parse(storedIdle(database)) > Date.parse(first), 'written after ten minutes');
  }));
