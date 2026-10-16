import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateSummary } from '../scripts/vigolium-summary.mjs';
import { sourceDetails } from '../scripts/vigolium-source-details.mjs';

test('report escapes untrusted scanner evidence and flags an unexpected access response', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vigolium-report-test-'));
  try {
    await writeFile(
      join(dir, 'scope.json'),
      JSON.stringify({ completedAt: '2026-09-30T16:40:24Z' }),
    );
    const payload = '<script>alert("scanner evidence")</script>';
    const records = [
      { type: 'scan', data: { status: 'completed' } },
      { type: 'http_record', data: { path: '/health', method: 'GET', status_code: 500 } },
      {
        type: 'finding',
        data: {
          module_name: payload,
          severity: 'low',
          extracted_results: [payload],
          matched_at: ['http://localhost/health'],
        },
      },
    ];
    await writeFile(join(dir, 'report.jsonl'), records.map(JSON.stringify).join('\n'));
    for (const identity of ['owner', 'outsider'])
      await writeFile(join(dir, `${identity}.jsonl`), '');
    const summary = await generateSummary(dir);
    assert.deepEqual(summary, { requestCount: 1, findingCount: 1 });
    const html = await readFile(join(dir, 'summary.html'), 'utf8');
    assert.ok(!html.includes(payload));
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /Unexpected/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('source correlation reports missing markers instead of claiming a complete code trace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vigolium-source-test-'));
  try {
    const detail = await sourceDetails('cors-headers-detect', dir);
    assert.equal(detail.complete, false);
    assert.deepEqual(detail.snippets, []);
    assert.equal(await sourceDetails('unknown-module', dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('report uses explicit outsider chat status and includes joined-member coverage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vigolium-role-test-'));
  try {
    const path = '/realtime/groups/fixture/messages';
    await writeFile(
      join(dir, 'scope.json'),
      JSON.stringify({
        completedAt: '2026-10-01T00:00:00Z',
        contexts: [
          { file: 'member', identity: 'Joined member' },
          { file: 'outsider', identity: 'Outsider' },
        ],
        expectedStatuses: { outsider: { [path]: 403 } },
      }),
    );
    for (const [file, status] of [
      ['member', 200],
      ['outsider', 403],
    ]) {
      await writeFile(
        join(dir, `${file}.jsonl`),
        JSON.stringify({
          type: 'http_record',
          data: { path, method: 'GET', status_code: status },
        }),
      );
    }
    await generateSummary(dir);
    const html = await readFile(join(dir, 'summary.html'), 'utf8');
    assert.match(html, /Joined member/);
    assert.equal((html.match(/>Matches</g) || []).length, 2);
    assert.ok(!html.includes('>Unexpected<'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
