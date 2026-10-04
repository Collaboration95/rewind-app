import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const workflow = readFileSync(
  new URL('../.github/workflows/vigolium-agentic.yml', import.meta.url),
  'utf8',
).replaceAll('\r\n', '\n');
test('PR validation excludes credentials and live jobs restrict authorized refs', () => {
  const offline = workflow.split('  offline:')[1].split('  trial:')[0];
  assert.ok(!offline.includes('secrets.') && !offline.includes('OPENAI_API_KEY'));
  assert.match(workflow, /github\.event_name != 'pull_request'/);
  assert.match(workflow, /refs\/heads\/dev/);
  assert.match(workflow, /refs\/heads\/codex\/vigolium-agentic-provider/);
  assert.match(workflow, /needs: offline/);
  assert.match(workflow, /permissions:\n  contents: read/);
});
test('CI includes a positive detection gate and uploads only report files', () => {
  assert.match(workflow, /\["fixture","chat","groups"\]/);
  assert.match(workflow, /node scripts\/run-vigolium-container\.mjs --run/);
  assert.ok(!workflow.includes('target.json'));
  const uploads = [...workflow.matchAll(/path: \|\n((?: +[^\n]+\n)+?)(?= +if-no-files-found:)/g)];
  assert.equal(uploads.length, 2);
  for (const upload of uploads)
    for (const line of upload[1].trim().split('\n'))
      assert.match(
        line.trim(),
        /\/(?:summary\.html|report\.html|report\.jsonl|native-report\.html|scope\.json|isolation\.json|app-baselines\.json)$/,
      );
});
