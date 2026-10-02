import { providerSettings } from './vigolium-provider.mjs';

export const fixtureImage = 'rewind-vigolium-fixture:0.5.1';

export function fixtureContainerArgs({ live = false, env = {}, output, name }) {
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
    '1000:1000',
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
