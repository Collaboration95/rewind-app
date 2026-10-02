import assert from 'node:assert/strict';
import test from 'node:test';
import { createScanFixture } from '../scripts/vigolium-fixture.mjs';
import { fixtureContainerArgs } from '../scripts/vigolium-container.mjs';

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
