import assert from 'node:assert/strict';

const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);
const text = (value, limit = 2000) => {
  assert.equal(typeof value, 'string', 'Expected a string in the proposal');
  assert.ok(value.length <= limit, 'Proposal text exceeds the limit');
  return value;
};
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

export function validateProposal(raw, sources, coverage) {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*\n/, '')
    .replace(/\n```$/, '');
  assert.ok(trimmed.length <= 200_000, 'Agent output exceeds the limit');
  const result = JSON.parse(trimmed);
  assert.equal(result.schemaVersion, 1, 'Unsupported proposal schema');
  assert.ok(Array.isArray(result.endpoints) && result.endpoints.length <= 200);
  assert.ok(Array.isArray(result.uncertainties) && result.uncertainties.length <= 100);
  const covered = new Set(
    [...coverage.contexts.flatMap((context) => context.requests), ...coverage.active.requests].map(
      (request) => `${request.method} ${request.path}`,
    ),
  );
  const keys = new Set();
  const endpoints = result.endpoints.map((endpoint) => {
    assert.ok(methods.has(endpoint.method), 'Unsupported HTTP method');
    const path = text(endpoint.path, 300);
    assert.match(path, /^\/[A-Za-z0-9_{}./:-]*$/, 'Expected an endpoint path template');
    assert.ok(!path.startsWith('//') && !path.includes('..'), 'Invalid endpoint path');
    const key = `${endpoint.method} ${path}`;
    assert.ok(!keys.has(key), `Duplicate endpoint: ${key}`);
    keys.add(key);
    const reference = endpoint.source;
    assert.ok(reference && Object.hasOwn(sources, reference.file), 'Source file not supplied');
    assert.ok(Number.isInteger(reference.line) && reference.line > 0, 'Invalid source line');
    const sourceLine = sources[reference.file].split(/\r?\n/)[reference.line - 1];
    const quote = text(reference.quote, 1000);
    assert.ok(
      quote.trim().length > 0 && sourceLine?.includes(quote),
      'Source quote does not match',
    );
    assert.ok(Array.isArray(endpoint.setup) && endpoint.setup.length <= 15);
    assert.ok(Array.isArray(endpoint.checks) && endpoint.checks.length <= 15);
    return {
      method: endpoint.method,
      path,
      source: { file: reference.file, line: reference.line, quote },
      authentication: text(endpoint.authentication),
      setup: endpoint.setup.map((value) => text(value)),
      checks: endpoint.checks.map((value) => text(value)),
      nativeCoverage: covered.has(key) ? 'listed' : 'not listed',
    };
  });
  assert.ok(endpoints.length > 0, 'No endpoints returned; discovery is incomplete');
  return {
    schemaVersion: 1,
    endpoints,
    uncertainties: result.uncertainties.map((value) => text(value)),
  };
}

export function renderProposal(proposal, metadata) {
  const uncovered = proposal.endpoints.filter(
    (endpoint) => endpoint.nativeCoverage === 'not listed',
  );
  const rows = proposal.endpoints
    .map(
      (endpoint) =>
        `<article><h2>${escape(endpoint.method)} ${escape(endpoint.path)}</h2><p>Native request manifest: <strong>${escape(endpoint.nativeCoverage)}</strong></p><p>Source: ${escape(endpoint.source.file)}:${endpoint.source.line}</p><pre>${escape(endpoint.source.quote)}</pre><p>Authentication: ${escape(endpoint.authentication)}</p><details><summary>Proposed setup and checks — review before use</summary><h3>Setup</h3><ul>${endpoint.setup.map((item) => `<li>${escape(item)}</li>`).join('')}</ul><h3>Checks</h3><ul>${endpoint.checks.map((item) => `<li>${escape(item)}</li>`).join('')}</ul></details></article>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rewind agentic coverage review</title><style>body{font:16px/1.6 system-ui;margin:0;background:#101724;color:#e7edf5}main{max-width:960px;margin:auto;padding:24px}article{background:#1b2637;padding:18px;margin:18px 0;border-radius:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere}h2{font-size:20px;overflow-wrap:anywhere}summary{cursor:pointer}</style><main><h1>Agentic coverage proposal</h1><p>Commit: ${escape(metadata.sourceCommit)} · ${escape(metadata.completedAt)}</p><p>${proposal.endpoints.length} proposed endpoints · ${uncovered.length} not listed in the native manifest</p><p>This is AI-assisted source discovery, not a completed DAST scan or a confirmed vulnerability report. Matching source quotes establish a reference, not that the agent interpreted the route correctly. Listed endpoints may still lack role or attack coverage.</p>${rows}<h2>Uncertainties</h2><ul>${proposal.uncertainties.map((item) => `<li>${escape(item)}</li>`).join('')}</ul><h2>Review and promotion</h2><ol><li>Verify each route, request format and business rule against source and a disposable app.</li><li>Add reviewed requests to security/vigolium-coverage.json and any required fixtures to the native runners.</li><li>Run security:auto and security:active, verify evidence, and submit the changes for review.</li></ol><p>No proposal is automatically executed or committed.</p></main></html>`;
}
