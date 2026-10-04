import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';

import {
  assertOwnedPortsAvailable,
  createCleanupStack,
  localOnlyEnv,
  portsForRealAccountRun,
  redactRealAccountDiagnostic,
  runOwnedCommand,
} from './real-account-e2e-utils.mjs';
import { createProductionWebServer, runtimeProxyHeaders } from './production-web-proxy.mjs';

test('assigns each sequential run a distinct pair inside the owned port range', () => {
  assert.deepEqual(portsForRealAccountRun(1), { runtimePort: 5431, webPort: 5432 });
  assert.deepEqual(portsForRealAccountRun(2), { runtimePort: 5433, webPort: 5434 });
  assert.deepEqual(portsForRealAccountRun(4), { runtimePort: 5437, webPort: 5438 });
  assert.throws(() => portsForRealAccountRun(0), /from 1 to 4/);
  assert.throws(() => portsForRealAccountRun(5), /from 1 to 4/);
});

test('an occupied owned port fails closed without closing the existing listener', async () => {
  const port = 5438;
  const listener = createServer();
  listener.listen(port, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));
  try {
    await assert.rejects(assertOwnedPortsAvailable([port]), /port 5438 is unavailable/);
    assert.equal(listener.listening, true);
  } finally {
    await new Promise((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('fixture cleanup runs in reverse acquisition order after a failed operation', async () => {
  const cleanup = createCleanupStack();
  const disposed = [];
  cleanup.defer(() => disposed.push('database'));
  cleanup.defer(() => disposed.push('server'));
  try {
    await assert.rejects(
      (async () => {
        try {
          throw new Error('fixture startup failed');
        } finally {
          await cleanup.dispose();
        }
      })(),
      /fixture startup failed/,
    );
  } finally {
    await cleanup.dispose();
  }
  assert.deepEqual(disposed, ['server', 'database']);
});

test('owned command runner preserves a child failure exit code', async () => {
  assert.equal(
    await runOwnedCommand(process.execPath, ['-e', 'process.exit(37)'], { stdio: 'ignore' }),
    37,
  );
});

test('fixture environment strips cloud credentials and keeps owned local settings', () => {
  assert.deepEqual(
    localOnlyEnv(
      { PATH: '/bin', AWS_REGION: 'us-east-1', AWS_SECRET_ACCESS_KEY: 'must-not-leak', CI: '1' },
      { REWIND_DATA_DIR: '/private/tmp/owned-fixture' },
    ),
    { PATH: '/bin', CI: '1', REWIND_DATA_DIR: '/private/tmp/owned-fixture' },
  );
});

test('TLS proxy overwrites browser-supplied forwarding credentials with its fixture secret', () => {
  assert.deepEqual(
    runtimeProxyHeaders(
      {
        'x-forwarded-proto': 'http',
        'x-rewind-origin-auth': 'attacker-value',
        cookie: 'rewind=opaque',
      },
      'fixture-only-secret',
    ),
    {
      'x-forwarded-proto': 'https',
      'x-rewind-origin-auth': 'fixture-only-secret',
      cookie: 'rewind=opaque',
    },
  );
  assert.deepEqual(runtimeProxyHeaders({ 'x-forwarded-proto': 'http' }, null), {
    'x-forwarded-proto': 'http',
  });
});

test('fixture origin authentication cannot be enabled on an HTTP web boundary', () => {
  assert.throws(
    () =>
      createProductionWebServer({
        staticDir: process.cwd(),
        runtimeOrigin: 'http://127.0.0.1:5431',
        originAuthSecret: 'fixture-only-secret',
      }),
    /requires a TLS web boundary/,
  );
});

test('failure diagnostics redact credentials, invite codes, local paths, and URLs', () => {
  const redacted = redactRealAccountDiagnostic(
    'password=secret token=opaque inviteCode=ABCDEF groupId=real-id code=ABC-DEF at /private/tmp/run https://127.0.0.1:5432 /api/media/access/private_capability',
  );
  for (const secret of [
    'secret',
    'opaque',
    'ABCDEF',
    'ABC-DEF',
    'real-id',
    '/private/tmp/run',
    '5432',
    'private_capability',
  ]) {
    assert.equal(redacted.includes(secret), false, `diagnostic still contains ${secret}`);
  }
  assert.match(redacted, /password=<redacted>/);
  assert.match(redacted, /<local-path>/);
  assert.match(redacted, /<local-url>/);
});
