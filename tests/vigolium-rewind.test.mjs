import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { disposableTarget } from '../scripts/vigolium-provider.mjs';
import { createRewindTarget } from '../scripts/vigolium-rewind-target.mjs';

test('live Rewind wrapper refuses fixture-only sharing approval before starting Docker', () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, ['scripts/run-vigolium-rewind.mjs', '--run'], {
        env: { REWIND_AGENT_DATA_SHARING: 'approved' },
        stdio: 'pipe',
      }),
    (error) => error.stderr.toString().includes('REWIND_AGENT_REWIND_DATA_SHARING=approved'),
  );
});

test('external seed excludes arbitrary origins, endpoints and header injection', () => {
  const seed = {
    disposable: true,
    origin: 'http://127.0.0.1:32100',
    path: '/realtime/groups/test-group/messages',
    token: 'temporary-token',
  };
  assert.equal(disposableTarget(seed).origin, seed.origin);
  for (const invalid of [
    { disposable: false },
    { origin: 'https://example.com' },
    { origin: 'http://127.0.0.1:32100/private' },
    { origin: 'http://user:pass@127.0.0.1:32100' },
    { path: '/auth/login' },
    { path: seed.path + '?other=1' },
    { token: 'token\r\nInjected: header' },
  ])
    assert.throws(() => disposableTarget({ ...seed, ...invalid }));
});

test('disposable real backend validates owner, anonymous and outsider boundaries', async () => {
  const target = await createRewindTarget();
  try {
    assert.deepEqual(target.baselines, {
      login: 200,
      groupCreation: 201,
      ownerPost: 201,
      ownerRead: 200,
      anonymousRead: 401,
      outsiderRead: 403,
      outsiderPost: 403,
    });
    assert.ok(!JSON.stringify(target.baselines).includes(target.token));
    assert.deepEqual(target.accessChecks, {
      memberReadBeforeJoining: 403,
      memberPostBeforeJoining: 403,
      outsiderInviteCreation: 404,
      ownerInviteCreation: 201,
      anonymousInviteAcceptance: 401,
      memberInviteAcceptance: 200,
      sessionAccountJoinedDespiteSpoofedAccountId: true,
      memberReadAfterJoining: 200,
      memberPostAfterJoining: 201,
      outsiderReadAfterJoining: 403,
      outsiderPostAfterJoining: 403,
      inviteReplay: 400,
      memberInviteCreation: 403,
    });
    assert.ok(!JSON.stringify(target.accessChecks).includes(target.token));
    const response = await fetch(target.origin + target.path, {
      headers: { Authorization: `Bearer ${target.token}` },
    });
    assert.equal(response.status, 200);
    await response.text();
  } finally {
    await target.close();
  }
  await assert.rejects(fetch(target.origin + target.path));
});

test('group scan seed creates a disposable group and cannot select other API paths', async () => {
  const target = await createRewindTarget({ endpoint: 'groups' });
  try {
    const seed = disposableTarget({ ...target, disposable: true });
    assert.equal(seed.path, '/real/groups');
    const response = await fetch(seed.origin + seed.path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${seed.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(seed.requestBody),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).group.name, seed.requestBody.name);
    assert.throws(() => disposableTarget({ ...target, disposable: true, path: '/auth/login' }));
    assert.throws(() =>
      disposableTarget({ ...target, disposable: true, requestBody: { name: 'test' } }),
    );
  } finally {
    await target.close();
  }
});

test('offline scanner receives seed via stdin without a credential file', async () => {
  const target = await createRewindTarget({ endpoint: 'access' });
  const output = await mkdtemp(join(tmpdir(), 'rewind-stdin-test-'));
  try {
    const child = spawn(
      process.execPath,
      ['scripts/run-vigolium-agentic.mjs', '--verify', '--target-stdin'],
      { env: { REWIND_AGENT_REPORT_DIR: output }, stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += chunk.toString();
    });
    child.stdin.end(JSON.stringify({ ...target, disposable: true }));
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, errors);
    const report = JSON.parse(await readFile(join(output, 'scope.json'), 'utf8'));
    assert.equal(report.accessAssessment.complete, true);
    assert.equal(report.accessAssessment.discoveredByAI, false);
    assert.ok(!JSON.stringify(report).includes(target.token));
    await assert.rejects(readFile(join(output, 'target.json')));
  } finally {
    await target.close();
    await rm(output, { recursive: true, force: true });
  }
});
