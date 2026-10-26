import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function run(env) {
  const child = spawn(process.execPath, ['scripts/load/hosted.mjs'], {
    env: { ...process.env, FIXTURE_FILE: '', SAVE_FIXTURE: '', CONFIRMATION_ONLY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostic = '';
  child.stderr.on('data', (chunk) => (diagnostic += chunk));
  child.stdout.resume();
  const [code] = await once(child, 'close');
  return { code, diagnostic };
}

test('hosted harness reuses three sessions, bounds uploads, redacts secrets and fails on HTTP errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rewind-load-harness-'));
  let failHome = false;
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url.includes('/contributions/upload?')) {
      assert.equal(
        JSON.parse(body).hasAudio,
        true,
        'photo contract includes generated silent track',
      );
    }
    calls.push(req.url);
    let data = {};
    let status = 200;
    if (req.url === '/api/health') data = { ok: true };
    else if (req.url === '/api/auth/register') status = 201;
    else if (req.url === '/api/auth/login') data = { token: 'SECRET_TEST_TOKEN' };
    else if (req.url === '/api/real/groups' && req.method === 'POST') {
      status = 201;
      data = { group: { id: 'test-group' }, cycle: {} };
    } else if (req.url.endsWith('/invites')) {
      status = 201;
      data = { invite: { code: 'SECRET_INVITE' } };
    } else if (req.url.includes('/upload/source')) {
      status = 201;
      data = { source: { uri: 'staged://test' } };
    } else if (req.url.includes('/contributions/upload?')) {
      status = 201;
      data = { upload: { jobId: 'test-job' } };
    } else if (failHome && req.url === '/api/real/groups/test-group') {
      status = 503;
      data = { error: 'unavailable' };
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const env = {
      TARGET_URL: `http://127.0.0.1:${server.address().port}`,
      MAX_VUS: '1',
      STEADY_SECONDS: '1',
      RAMP_SECONDS: '0',
      OUTPUT: join(directory, 'results.json'),
    };
    assert.equal((await run({ ...env, SAVE_FIXTURE: join(directory, 'fixture.json') })).code, 0);
    const reportText = await readFile(env.OUTPUT, 'utf8');
    const report = JSON.parse(reportText);
    assert.equal(report.passed, true);
    assert.equal(calls.filter((p) => p === '/api/auth/login').length, 3);
    assert.equal(calls.filter((p) => p.includes('/upload/source')).length, 3);
    assert.equal(report.samples.filter((s) => s.operation === 'process-contribution').length, 3);
    assert.ok(!reportText.includes('SECRET_'));
    assert.ok(report.samples.every((s) => Number.isFinite(s.ms)));
    const callCount = calls.length;
    assert.equal(
      (
        await run({
          ...env,
          CONFIRMATION_ONLY: 'true',
          FIXTURE_FILE: join(directory, 'fixture.json'),
        })
      ).code,
      0,
    );
    const confirmation = JSON.parse(await readFile(env.OUTPUT, 'utf8'));
    assert.equal(confirmation.fixture.media.uploadAttempts, 0);
    assert.ok(!confirmation.samples.some((s) => s.operation === 'chat-send'));
    assert.ok(!calls.slice(callCount).some((p) => /auth\/login|upload|invites/.test(p)));
    failHome = true;
    assert.equal((await run(env)).code, 1);
    assert.equal(JSON.parse(await readFile(env.OUTPUT, 'utf8')).passed, false);
    assert.equal((await run({ ...env, MAX_VUS: '101' })).code, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
