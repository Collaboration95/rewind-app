import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  providerSettings,
  redact,
  scopedProxy,
  summarizeFindings,
  summaryHtml,
} from '../scripts/vigolium-provider.mjs';

test('informational authentication findings do not establish SQL injection detection', () => {
  const info = { type: 'finding', data: { module_id: 'auth-headers-detect', severity: 'info' } };
  const sql = { type: 'finding', data: { module_id: 'sqli-error-based', severity: 'critical' } };
  assert.equal(summarizeFindings(JSON.stringify(info)).sqlInjectionReported, false);
  assert.equal(summarizeFindings(JSON.stringify(info)).vulnerabilityCount, 0);
  const summary = summarizeFindings([info, sql].map(JSON.stringify).join('\n'));
  assert.equal(summary.sqlInjectionReported, true);
  assert.equal(summary.informationalCount, 1);
  assert.equal(summary.vulnerabilityCount, 1);
  assert.equal(summarizeFindings('').findingCount, 0);
  assert.equal(
    summarizeFindings(
      JSON.stringify({
        type: 'finding',
        data: { module_id: 'generated-fixture-probe', tags: ['sqli'], severity: 'high' },
      }),
    ).sqlInjectionReported,
    true,
  );
});

test('live provider requires explicit data approval, model and matching key', () => {
  assert.throws(
    () => providerSettings({ OPENAI_API_KEY: 'key', REWIND_AGENT_MODEL: 'model' }, true),
    /DATA_SHARING/,
  );
  assert.throws(
    () => providerSettings({ REWIND_AGENT_DATA_SHARING: 'approved', OPENAI_API_KEY: 'key' }, true),
    /MODEL/,
  );
  assert.throws(
    () => providerSettings({ REWIND_AGENT_PROVIDER: 'openai-compatible' }),
    /Unsupported/,
  );
  assert.equal(
    providerSettings(
      {
        REWIND_AGENT_PROVIDER: 'anthropic-api-key',
        REWIND_AGENT_DATA_SHARING: 'approved',
        REWIND_AGENT_MODEL: 'model',
        ANTHROPIC_API_KEY: 'key',
      },
      true,
    ).keyName,
    'ANTHROPIC_API_KEY',
  );
  assert.equal(providerSettings({}).provider, 'openai-responses');
});

test('report escapes untrusted errors and redacts overlapping secrets', () => {
  assert.equal(redact('token-long token', ['token', 'token-long']), '[REDACTED] [REDACTED]');
  const html = summaryHtml({ status: 'incomplete', message: '<script>alert(1)</script>' });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('proxy rejects other paths, methods and excess requests and enforces pacing', async () => {
  let reached = 0;
  const backend = createServer((request, response) => {
    reached++;
    request.resume();
    response.writeHead(200).end('{}');
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const proxy = await scopedProxy(`http://127.0.0.1:${backend.address().port}`, '/chat', {
    limit: 2,
    interval: 100,
  });
  try {
    assert.equal((await fetch(`${proxy.origin}/admin`)).status, 403);
    assert.equal((await fetch(`${proxy.origin}/chat`, { method: 'DELETE' })).status, 403);
    const responses = await Promise.all([
      fetch(`${proxy.origin}/chat`),
      fetch(`${proxy.origin}/chat`),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.equal((await fetch(`${proxy.origin}/chat`)).status, 429);
    assert.equal(reached, 2);
    assert.ok(proxy.evidence.timestamps[1] - proxy.evidence.timestamps[0] >= 90);
  } finally {
    await proxy.close();
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
  }
});

test('SDK absolute-form POST preserves auth/body while foreign origins and query paths stay denied', async () => {
  const observed = [];
  const backend = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    observed.push({ authorization: req.headers.authorization, body, path: req.url });
    res.writeHead(201).end('{}');
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const proxy = await scopedProxy(`http://127.0.0.1:${backend.address().port}`, '/chat', {
    interval: 0,
  });
  const send = (path) =>
    new Promise((resolve, reject) => {
      const req = request(
        proxy.origin,
        {
          method: 'POST',
          path,
          headers: { Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/json' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ body: 'changed JSON value' }));
    });
  try {
    assert.equal(await send(`${proxy.origin}/chat`), 201);
    assert.equal(await send('http://example.invalid/chat'), 403);
    assert.equal(await send(`${proxy.origin}/chat?other=1`), 403);
    assert.deepEqual(observed, [
      {
        authorization: 'Bearer synthetic-token',
        body: '{"body":"changed JSON value"}',
        path: '/chat',
      },
    ]);
  } finally {
    await proxy.close();
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
  }
});
test('live entry point refuses unapproved execution before runtime imports', () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('../scripts/run-vigolium-agentic.mjs', import.meta.url)), '--run'],
        { env: {}, stdio: 'pipe' },
      ),
    (error) =>
      error.status !== 0 && error.stderr.toString().includes('REWIND_AGENT_DATA_SHARING=approved'),
  );
});

test('proxy rejects non-loopback backends and URL-like scope entries before listening', async () => {
  await assert.rejects(scopedProxy('http://example.com:8080', '/chat'), /loopback/);
  await assert.rejects(scopedProxy('http://127.0.0.1:8080', ['//example.com', '/chat']), /route/);
  await assert.rejects(scopedProxy('http://127.0.0.1:8080', ['/chat?other=1']), /route/);
});
