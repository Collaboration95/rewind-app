import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { openFixtureDatabase } from './fixture-group.mjs';

const { parseConfig } = await import('../../dist/config.js');
const { createRuntimeServer } = await import('../../dist/http.js');

async function tempConfig(prefix, env) {
  const dataDir = await mkdtemp(`${tmpdir()}/${prefix}`);
  const config = parseConfig({ REWIND_DATA_DIR: dataDir, REWIND_HOST: '127.0.0.1', ...env });
  return { dataDir, config };
}

/**
 * Run `run({ config, database, dataDir })` against a temp data dir holding a
 * migrated fixture database, then close the database and remove the dir.
 * - prefix: temp directory name prefix.
 * - env: extra environment passed to `parseConfig`.
 * - setup(database): runs once the fixture database is open, before `run`.
 * - tolerateClosed: ignore an error from closing a handle `run` already closed.
 */
export async function withDatabase({ prefix, env = {}, setup, tolerateClosed = false } = {}, run) {
  const { dataDir, config } = await tempConfig(prefix, env);
  const database = openFixtureDatabase(config);
  try {
    await setup?.(database);
    return await run({ config, database, dataDir });
  } finally {
    try {
      database.close();
    } catch (error) {
      if (!tolerateClosed) throw error;
      // A restart test may already have closed this handle.
    }
    await rm(dataDir, { recursive: true, force: true });
  }
}

/**
 * Like `withDatabase`, plus a runtime HTTP server on 127.0.0.1 (ephemeral
 * port); `run` gets `{ baseUrl, config, database, dataDir, server }`.
 * - seedNow: fixture seed time passed to `openFixtureDatabase`.
 * - serverOptions: second argument of `createRuntimeServer` (clock, providers).
 */
export async function withRuntime({ prefix, env = {}, seedNow, serverOptions } = {}, run) {
  const { dataDir, config } = await tempConfig(prefix, env);
  const database = openFixtureDatabase(config, { seedNow });
  const server = createRuntimeServer(config, database, serverOptions);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run({ baseUrl, config, database, dataDir, server });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
