// Run the server test suite against PostgreSQL. Creates a disposable database
// on the server named by REWIND_TEST_POSTGRES_URL (default: the local Docker
// container from `make postgres-test-db`), points REWIND_TEST_DATABASE_URL at
// it, runs the given test files (default: all server tests; arguments that
// start with -- go to node --test), then drops the database.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';

import pg from 'pg';

const adminUrl =
  process.env.REWIND_TEST_POSTGRES_URL ?? 'postgres://postgres:devpass@127.0.0.1:55432/postgres';
const database = `rewind_test_${randomBytes(6).toString('hex')}`;
const nodeOptions = process.argv.slice(2).filter((arg) => arg.startsWith('--'));
const files = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const tests = files.length
  ? files
  : readdirSync('server/tests')
      .filter((name) => name.endsWith('.test.mjs'))
      .sort()
      .map((name) => `server/tests/${name}`);

async function admin(sql) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

await admin(`CREATE DATABASE ${database} TEMPLATE template0 ENCODING 'UTF8'`);
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${database}`;
let status = 1;
try {
  status = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--test', '--test-timeout=120000', ...nodeOptions, ...tests],
      {
        stdio: 'inherit',
        env: { ...process.env, REWIND_TEST_DATABASE_URL: testUrl.toString() },
      },
    );
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
} finally {
  await admin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
}
process.exit(status);
