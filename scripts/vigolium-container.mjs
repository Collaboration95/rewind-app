import { providerSettings } from './vigolium-provider.mjs';
import { chmod, mkdir } from 'node:fs/promises';

export const fixtureImage = 'rewind-vigolium-fixture:0.5.1';

export async function prepareReportDirectory(output) {
  await mkdir(output, { recursive: true });
  const reportGroup = process.getgid?.() ?? 1000;
  // Share only this owned report directory with the non-root container using
  // the host's group; don't grant write access to every user or elevate UID.
  if (process.platform === 'linux') await chmod(output, 0o770);
  return reportGroup;
}

export function fixtureContainerArgs({ live = false, env = {}, output, name, reportGroup = 1000 }) {
  if (!Number.isInteger(reportGroup) || reportGroup < 0 || reportGroup > 2147483647)
    throw new Error('Invalid report group');
  if (!output || /[\r\n,]/.test(output)) throw new Error('Unsupported report mount path');
  if (!/^rewind-agentic-[a-z0-9-]+$/.test(name)) throw new Error('Invalid container name');
  const settings = providerSettings(env, live);
  const args = [
    'run',
    '--rm',
    '--name',
    name,
    '--init',
    '--read-only',
    '--user',
    `1000:${reportGroup}`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=128',
    '--memory=1g',
    '--cpus=2',
    '--network',
    live ? 'bridge' : 'none',
    '--tmpfs',
    '/tmp:rw,exec,nosuid,nodev,size=512m,mode=1777',
    '--mount',
    `type=bind,source=${output},target=/reports`,
  ];
  if (live) {
    // Docker imports only these named variables. Secret values never appear in argv.
    for (const key of [
      'REWIND_AGENT_PROVIDER',
      'REWIND_AGENT_MODEL',
      'REWIND_AGENT_DATA_SHARING',
      settings.keyName,
    ])
      args.push('--env', key);
  }
  return [...args, fixtureImage, live ? '--run' : '--verify', '--fixture'];
}

// Retry generation failures only, never a failed independent detection verdict.
export function retryableFixtureFailure(report) {
  return (
    report?.status === 'incomplete' &&
    /context deadline exceeded|No generated extension retained|Scanner exceeded the six-minute deadline/.test(
      report.message || '',
    )
  );
}
