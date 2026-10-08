import { appendFile, readFile } from 'node:fs/promises';
const target = process.env.REWIND_AGENT_ENDPOINT;
const directories = {
  fixture: 'agentic-container',
  chat: 'agentic-rewind-container',
  groups: 'agentic-rewind-groups',
  access: 'agentic-rewind-access',
};
if (!Object.hasOwn(directories, target)) throw new Error('Unsupported CI target');
const report = await readFile(`vigolium-result/${directories[target]}/scope.json`, 'utf8')
  .then(JSON.parse)
  .catch(() => undefined);
const lines = [`### Vigolium ${target} trial`, `Commit: ${process.env.GITHUB_SHA || 'local'}`];
if (!report) lines.push('No completed report produced. Inspect the failed step.');
else {
  lines.push(
    `Status: ${report.status}`,
    `Scanner requests: ${report.scannerRequests ?? 'not recorded'}`,
    `Reported vulnerabilities: ${report.assessment?.vulnerabilityCount ?? 'not assessed'}`,
    `Informational observations: ${report.assessment?.informationalCount ?? 'not assessed'}`,
  );
  if (target === 'fixture')
    lines.push(
      `Known SQL injection detection gate: ${report.detectionTrialPassed === true ? 'PASS' : 'NOT PASSED'}`,
    );
  else if (target === 'access')
    lines.push(
      `Access scenario gate: ${report.accessAssessment?.complete ? 'PASS' : 'NOT PASSED'}`,
      'Scope: two synthetic groups, four disposable identities, invitation creation/acceptance. No whole-app security claim.',
    );
  else
    lines.push(
      'Scope: one disposable endpoint. Access/invitation checks are local preflight; no whole-app security claim.',
    );
  if (report.requestLimitReached) lines.push('Coverage is partial: request budget exhausted.');
}
const content = lines.join('\n\n') + '\n';
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, content);
else console.log(content);
