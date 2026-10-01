import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProposal, renderProposal } from '../scripts/vigolium-agentic-proposal.mjs';

const source = "if (url.pathname === '/comments' && request.method === 'POST') {";
const sources = { 'server/src/http.ts': source };
const coverage = {
  contexts: [{ requests: [{ method: 'GET', path: '/comments' }] }],
  active: { requests: [] },
};
const reply = () => ({
  schemaVersion: 1,
  endpoints: [
    {
      method: 'POST',
      path: '/comments',
      source: { file: 'server/src/http.ts', line: 1, quote: source },
      authentication: 'Unknown; verify helper implementation',
      setup: ['Create a disposable group'],
      checks: ['Verify outsider access is denied'],
    },
  ],
  uncertainties: ['No runtime validation performed'],
});

test('coverage discovery identifies a new method on a listed path and preserves uncertainty', () => {
  const result = validateProposal(JSON.stringify(reply()), sources, coverage);
  assert.equal(result.endpoints[0].nativeCoverage, 'not listed');
  assert.equal(result.uncertainties[0], 'No runtime validation performed');
});

test('invented source references and external endpoint URLs are rejected', () => {
  for (const mutate of [
    (value) => {
      value.endpoints[0].source.file = '../credentials';
    },
    (value) => {
      value.endpoints[0].source.line = 99;
    },
    (value) => {
      value.endpoints[0].source.quote = 'invented handler';
    },
    (value) => {
      value.endpoints[0].path = 'https://external.example/comments';
    },
    (value) => {
      value.endpoints[0].path = '//external.example/comments';
    },
    (value) => {
      value.endpoints[0].path = '/../credentials';
    },
  ]) {
    const value = reply();
    mutate(value);
    assert.throws(() => validateProposal(JSON.stringify(value), sources, coverage));
  }
});

test('report escapes model text, keeps proposals advisory, and drops executable extras', () => {
  const value = reply();
  value.endpoints[0].checks = ['<script>alert("proposal")</script>'];
  value.endpoints[0].command = 'arbitrary executable instruction';
  const result = validateProposal(JSON.stringify(value), sources, coverage);
  assert.equal(result.endpoints[0].command, undefined);
  const html = renderProposal(result, { sourceCommit: 'fixture', completedAt: 'test' });
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /No proposal is automatically executed/);
});

test('empty, duplicate or malformed discovery is not reported as successful', () => {
  assert.throws(() => validateProposal('not JSON', sources, coverage));
  assert.throws(() =>
    validateProposal(JSON.stringify({ ...reply(), endpoints: [] }), sources, coverage),
  );
  const duplicated = reply();
  duplicated.endpoints.push(duplicated.endpoints[0]);
  assert.throws(() => validateProposal(JSON.stringify(duplicated), sources, coverage));
});
