import assert from 'node:assert/strict';
import test from 'node:test';
import { createScanFixture, verifyFixturePayloads } from '../scripts/vigolium-fixture.mjs';
import { fixtureContainerArgs } from '../scripts/vigolium-container.mjs';

test('independent replay distinguishes real predicate manipulation from benign values and errors', async () => {
  const checked = await verifyFixturePayloads([
    'ordinary unmatched text',
    "Disposable agentic trial message'",
    "Disposable agentic trial message' AND 1=1 -- ",
    "Disposable agentic trial message' AND 1=2 -- ",
  ]);
  assert.equal(checked.confirmed, true);
  assert.deepEqual(
    checked.checks.map((check) => check.confirmed),
    [false, false, true, false],
  );
  assert.equal((await verifyFixturePayloads(['ordinary unmatched text'])).confirmed, false);
});

test('real SQL injection exposes synthetic canary; parameterized control rejects it', async () => {
  for (const vulnerable of [true, false]) {
    const target = await createScanFixture({ vulnerable });
    try {
      const query = async (body) => {
        const response = await fetch(`${target.origin}${target.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.token}` },
          body: JSON.stringify({ body }),
        });
        assert.equal(response.status, 201);
        return (await response.json()).messages;
      };
      assert.equal((await fetch(`${target.origin}${target.path}`)).status, 401);
      const normal = await query('Disposable agentic trial message');
      assert.equal(normal.length, 1);
      assert.ok(!JSON.stringify(normal).includes('SYNTHETIC_PRIVATE_CANARY'));
      const injected = await query("' OR 1=1 --");
      assert.equal(
        injected.some((row) => row.body === 'SYNTHETIC_PRIVATE_CANARY'),
        vulnerable,
      );
      if (!vulnerable) assert.deepEqual(injected, []);
      const probe = target.evidence.find((entry) => entry.body === "' OR 1=1 --");
      assert.equal(probe.authenticated, true);
      assert.equal(probe.canaryExposed, vulnerable);
      assert.ok(!JSON.stringify(target.evidence).includes(target.token));
      assert.ok(target.evidence.some((entry) => !entry.authenticated && entry.status === 401));
    } finally {
      await target.close();
    }
  }
});

test('offline container disables network and only mounts the report directory', () => {
  const args = fixtureContainerArgs({ output: '/reports-only', name: 'rewind-agentic-test' });
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('--security-opt=no-new-privileges'));
  assert.equal(args.filter((value) => value === '--mount').length, 1);
  assert.ok(args.includes('type=bind,source=/reports-only,target=/reports'));
  assert.ok(!args.includes('--env'));
  assert.ok(!args.includes('--privileged'));
  assert.ok(!args.some((value) => value.includes('docker.sock')));
});

test('CI report sharing preserves non-root UID while selecting the host group', () => {
  const args = fixtureContainerArgs({
    output: '/reports-only',
    name: 'rewind-agentic-test',
    reportGroup: 1001,
  });
  assert.equal(args[args.indexOf('--user') + 1], '1000:1001');
  assert.throws(
    () =>
      fixtureContainerArgs({
        output: '/reports-only',
        name: 'rewind-agentic-test',
        reportGroup: '1001;command',
      }),
    /Invalid report group/,
  );
});

test('live container cannot start without approval; it passes key names, not values', () => {
  const options = { output: '/reports-only', name: 'rewind-agentic-test' };
  assert.throws(() => fixtureContainerArgs({ ...options, live: true }), /DATA_SHARING/);
  const args = fixtureContainerArgs({
    ...options,
    live: true,
    env: {
      REWIND_AGENT_DATA_SHARING: 'approved',
      REWIND_AGENT_MODEL: 'model',
      OPENAI_API_KEY: 'secret-canary',
      AWS_SECRET_ACCESS_KEY: 'unrelated',
    },
  });
  assert.ok(args.includes('OPENAI_API_KEY'));
  assert.ok(!args.includes('secret-canary'));
  assert.ok(!args.includes('AWS_SECRET_ACCESS_KEY'));
  assert.ok(!args.includes('unrelated'));
  assert.deepEqual(args.slice(-2), ['--run', '--fixture']);
});

test('fixture retry policy allows one transient generation retry without hiding detection failures', async () => {
  const { retryableFixtureFailure } = await import('../scripts/vigolium-container.mjs');
  assert.equal(
    retryableFixtureFailure({ status: 'incomplete', message: 'olium: context deadline exceeded' }),
    true,
  );
  assert.equal(
    retryableFixtureFailure({
      status: 'scanner-completed',
      message: 'SQL injection detection was not independently verified',
    }),
    false,
  );
  assert.equal(
    retryableFixtureFailure({ status: 'incomplete', message: 'HTTP 401 invalid API key' }),
    false,
  );
});
