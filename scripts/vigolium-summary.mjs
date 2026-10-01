import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceDetails } from './vigolium-source-details.mjs';

const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char],
  );
const displayPath = (path) => path.replace(/real-group-[^/]+/, '{groupId}');
const advice = {
  'cors-headers-detect': {
    meaning:
      'These responses have wildcard CORS headers, allowing browser scripts from any origin to read non-credentialed responses. Wildcard CORS alone does not demonstrate access to private account data.',
    action:
      'Confirm that health and synthetic profiles are intentionally public. A wildcard on a denied chat response does not establish disclosure of private messages. If not, restrict allowed origins. Review private endpoints separately; credentials were not shown enabled on these public responses.',
  },
  'api-version-detect': {
    meaning:
      'The health response discloses an API version. This is a fingerprinting observation, not a demonstrated vulnerability.',
    action:
      'Decide whether the version is useful for diagnostics. Remove it if unnecessary; otherwise document it as an accepted informational disclosure.',
  },
};

export async function generateSummary(outputDir, sourceRoot = process.cwd()) {
  const scope = JSON.parse(await readFile(join(outputDir, 'scope.json'), 'utf8'));
  const groups = [];
  for (const { file, identity } of scope.contexts || [
    { file: 'report', identity: 'Public / signed out' },
    { file: 'owner', identity: 'Group owner' },
    { file: 'outsider', identity: 'Outside the group' },
  ]) {
    const rows = (await readFile(join(outputDir, `${file}.jsonl`), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(JSON.parse);
    groups.push({
      file,
      identity,
      rows: rows.filter((r) => r.type === 'http_record').map((r) => r.data),
      findings: rows.filter((r) => r.type === 'finding').map((r) => r.data),
      scans: rows.filter((r) => r.type === 'scan').map((r) => r.data),
    });
  }
  const findings = groups.flatMap((group) =>
    group.findings.map((finding) => ({ ...finding, identity: group.identity })),
  );
  const requestCount = groups.reduce((total, group) => total + group.rows.length, 0);
  const matrix = groups
    .map((group) => {
      const rows = group.rows
        .map((row) => {
          const expected =
            scope.expectedStatuses?.[group.file]?.[row.path] ??
            (['owner', 'member'].includes(group.file)
              ? 200
              : group.file === 'outsider'
                ? 404
                : ['/health', '/profiles'].includes(row.path)
                  ? 200
                  : 401);
          const matched = row.status_code === expected;
          return `<tr><td><code>${escape(row.method)} ${escape(displayPath(row.path))}</code></td><td>${expected}</td><td>${escape(row.status_code)}</td><td class="${matched ? 'pass' : 'warn'}">${matched ? 'Matches' : 'Unexpected'}</td></tr>`;
        })
        .join('');
      const completed =
        group.scans.length > 0 && group.scans.every((scan) => scan.status === 'completed');
      return `<section><h2>${escape(group.identity)}</h2><p class="muted">${group.rows.length} responses · ${group.findings.length} findings · scan ${completed ? 'completed' : 'incomplete'}</p><div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>Expected</th><th>Actual</th><th>Access result</th></tr></thead><tbody>${rows}</tbody></table></div><p><a href="${group.file}.html">Open detailed Vigolium report</a></p></section>`;
    })
    .join('');
  const findingHtml = (
    await Promise.all(
      findings.map(async (finding) => {
        const detail = await sourceDetails(finding.module_id, sourceRoot);
        const codeDetails = detail?.snippets.length
          ? `<h4>Relevant source code</h4><p class="muted">Source correlation: ${detail.complete ? 'all mapped code markers found' : 'partial; source markers missing'}. These links are generated from source inspection, not by DAST.</p>${detail.snippets.map((snippet) => `<h4>${escape(snippet.file)}:${snippet.line}</h4><pre>${escape(snippet.code)}</pre>`).join('')}${detail.complete ? `<h4>Why this behavior occurs</h4><p>${escape(detail.cause)}</p><h4>Suggested change — not applied</h4><p>${escape(detail.suggestion)}</p><pre>${escape(detail.example)}</pre><h4>How to validate a change</h4><ul>${detail.checks.map((check) => `<li>${escape(check)}</li>`).join('')}</ul>` : '<p>Source correlation is incomplete. Verify the current implementation before selecting a fix.</p>'}`
          : '<p class="muted">No source correlation available for this finding. DAST alone cannot identify the responsible code.</p>';
        const guidance = advice[finding.module_id];
        const paths = [
          ...new Set(
            (finding.matched_at || [finding.url]).map((url) => {
              try {
                return displayPath(new URL(url).pathname);
              } catch {
                return url;
              }
            }),
          ),
        ];
        return `<article><details><summary><span class="severity">${escape(finding.severity).toUpperCase()}</span> · ${escape(finding.module_name)} — evidence, code and suggested fix</summary><p>Scanner confidence: ${escape(finding.confidence)}</p><p><strong>Where:</strong> ${escape(paths.join(', '))} · ${escape(finding.identity)}</p><h4>Observed evidence</h4><pre>${escape((finding.extracted_results || []).filter(Boolean).join('\n'))}</pre><h4>Interpretation</h4><p>${escape(guidance?.meaning || finding.module_short || 'Scanner observation; manual assessment required.')}</p><h4>Recommended next step</h4><p>${escape(guidance?.action || 'Review scanner evidence, validate impact and decide whether remediation is needed.')}</p>${codeDetails}<details><summary>Scanner description</summary><pre>${escape(finding.description)}</pre></details></details></article>`;
      }),
    )
  ).join('');
  const date = new Date(scope.completedAt).toLocaleString('en-SG', {
    timeZone: 'Asia/Singapore',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rewind security trial</title><style>
body{margin:0;background:#101724;color:#e7edf5;font:16px/1.6 system-ui,sans-serif}main{max-width:980px;margin:auto;padding:28px 20px}h1{font-size:32px;line-height:1.2}h2{font-size:23px}h3{font-size:20px}h4{margin-bottom:8px}.muted{color:#b2bed0}.stats{display:flex;flex-wrap:wrap;gap:20px;margin:24px 0}.stats div{flex:1;min-width:130px}.stats strong{display:block;font-size:28px}section,article{padding:20px;background:#1b2637;border-radius:12px;margin:20px 0}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:10px 6px;border-bottom:1px solid #354458}th{color:#b2bed0;font-weight:500}.table-wrap{overflow-x:auto}code{overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#101724;padding:14px;border-radius:6px}a{color:#a5cbff}.pass{color:#9de2b1}.warn,.severity{color:#f7d28d}.notice{border-left:3px solid #f7d28d;padding-left:16px}summary{cursor:pointer}li{margin:8px 0}@media(max-width:500px){main{padding:20px 12px}section,article{padding:14px}th,td{padding:8px 4px;font-size:14px}}
</style></head><body><main><p class="muted">Rewind · Vigolium setup trial</p><h1>Security scan results</h1><p class="muted">Commit: <code>${escape(scope.sourceCommit || 'Not recorded')}</code><br>Completed: ${escape(date)} SGT<br>Mode: passive HTTP DAST · temporary loopback backend</p><p class="notice">A completed scan confirms the tested checks ran. It does not certify the application is secure.</p><div class="stats"><div><strong>${requestCount}</strong>Recorded responses</div><div><strong>${groups.length}</strong>Identity contexts</div><div><strong>${findings.length}</strong>Scanner advisories</div></div><h2>Access checks and coverage</h2><p>Expected responses describe this test fixture. The expected outsider chat 403 is an application denial; scanner WAF warnings on that response do not prove a WAF is present. HTTP status checks verify the selected routes only; they do not establish complete authorization protection.</p>${matrix}<h2>Finding review</h2>${findingHtml || '<p>No passive findings in the scanned responses.</p>'}<section><h2>What this trial does not cover</h2><ul><li>AI source auditing and the earlier, unverified Demo-reset candidate.</li><li>Browser crawling or a deployed HTTPS environment. Active checks are reported separately in the active folder.</li><li>Media upload, processing, reveal, downloads and full user journeys.</li><li>Exhaustive role, cross-group, concurrency or business-logic testing.</li></ul><p>Local HTTP authentication was enabled solely for disposable test accounts. Reports redact their credentials. The runtime data and scan databases are removed after the run.</p></section><h2>Suggested follow-up</h2><ol><li>Review whether the public CORS policy and version disclosure are intentional.</li><li>Add media and additional role scenarios if the team wants broader coverage.</li><li>Use the dev workflow artifact to review the passive and active reports together.</li></ol><p class="muted">Evidence: Per-identity JSONL exports and scope.json. This summary is generated from those exports.</p></main></body></html>`;
  await writeFile(join(outputDir, 'summary.html'), html);
  return { requestCount, findingCount: findings.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(
    await generateSummary(
      resolve(process.argv[2] || 'vigolium-result/automatic'),
      resolve(process.argv[3] || '.'),
    ),
  );
}
