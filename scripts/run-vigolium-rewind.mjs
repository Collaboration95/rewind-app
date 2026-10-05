import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { disposableTarget } from './vigolium-provider.mjs';
import {
  fixtureContainerArgs,
  fixtureImage,
  prepareReportDirectory,
} from './vigolium-container.mjs';

const mode = process.argv[2];
if (!['--build', '--verify', '--run'].includes(mode))
  throw new Error('Choose --build, --verify or --run');
const live = mode === '--run';
const endpointIndex = process.argv.indexOf('--endpoint');
const endpoint = endpointIndex < 0 ? 'chat' : process.argv[endpointIndex + 1];
if (!['chat', 'groups', 'access'].includes(endpoint))
  throw new Error('Endpoint must be chat, groups or access');
if (live && process.env.REWIND_AGENT_REWIND_DATA_SHARING !== 'approved')
  throw new Error(
    'Live Rewind scanning requires REWIND_AGENT_REWIND_DATA_SHARING=approved in addition to provider approval',
  );
const docker = process.env.REWIND_DOCKER_BIN || 'docker';
const image = 'rewind-vigolium-target:trial';
async function execute(args, deadline = 60_000, quiet = false, input) {
  const child = spawn(docker, args, {
    stdio: input ? ['pipe', 'inherit', 'inherit'] : quiet ? 'ignore' : 'inherit',
  });
  if (input) {
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  }
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    child.kill();
  }, deadline);
  try {
    const [code] = await once(child, 'exit');
    if (expired || code !== 0)
      throw new Error('Disposable container operation failed or exceeded its deadline');
  } finally {
    clearTimeout(timer);
  }
}
if (mode === '--build') {
  await execute(
    ['build', '--file', 'security/agentic/Dockerfile', '--tag', fixtureImage, '.'],
    1200_000,
  );
  await execute(
    ['build', '--file', 'security/agentic/Rewind.Dockerfile', '--tag', image, '.'],
    1200_000,
  );
} else {
  const output = resolve(
    (endpoint === 'chat'
      ? 'vigolium-result/agentic-rewind-container'
      : endpoint === 'groups'
        ? 'vigolium-result/agentic-rewind-groups'
        : 'vigolium-result/agentic-rewind-access') + (live ? '' : '-offline'),
  );
  const name = `rewind-agentic-${randomUUID()}`;
  const appName = `${name}-app`;
  const reportGroup = await prepareReportDirectory(output);
  await rm(join(output, 'target.json'), { force: true });
  await rm(join(output, 'app-baselines.json'), { force: true });
  const appArgs = fixtureContainerArgs({ output, name: appName, reportGroup }).slice(0, -3);
  if (live) appArgs[appArgs.indexOf('--network') + 1] = 'bridge';
  appArgs.splice(1, 0, '--log-driver', 'none');
  const scannerArgs = fixtureContainerArgs({ output, name, live, env: process.env, reportGroup });
  scannerArgs[scannerArgs.indexOf('--network') + 1] = `container:${appName}`;
  scannerArgs.splice(-3, 3, fixtureImage, live ? '--run' : '--verify', '--target-stdin');
  scannerArgs.splice(1, 0, '--interactive');
  let app;
  try {
    app = spawn(docker, [...appArgs, '--env', `REWIND_AGENT_ENDPOINT=${endpoint}`, image], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const seed = await new Promise((resolveSeed, rejectSeed) => {
      let buffer = '';
      const timer = setTimeout(
        () => finish(new Error('Disposable backend readiness deadline exceeded')),
        45000,
      );
      const finish = (error, value) => {
        clearTimeout(timer);
        app.stdout.removeListener('data', onData);
        app.removeListener('error', onError);
        app.removeListener('exit', onExit);
        app.stdout.resume();
        if (error) rejectSeed(error);
        else resolveSeed(value);
      };
      const onError = () => finish(new Error('Backend launch failed'));
      const onExit = () => finish(new Error('Backend exited before readiness'));
      const onData = (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > 65536) return finish(new Error('Backend seed exceeds limit'));
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        try {
          const value = JSON.parse(buffer.slice(0, newline));
          disposableTarget(value);
          finish(undefined, JSON.stringify(value));
        } catch {
          finish(new Error('Invalid disposable seed'));
        }
      };
      app.on('error', onError);
      app.on('exit', onExit);
      app.stdout.on('data', onData);
    });
    if (live) await rm(join(output, 'isolation.json'), { force: true });
    else
      await execute(
        [
          ...scannerArgs.slice(0, -3),
          '--entrypoint',
          'node',
          fixtureImage,
          'scripts/check-vigolium-isolation.mjs',
        ],
        45_000,
      );
    await execute(scannerArgs, live ? 600_000 : 60_000, false, seed);
  } finally {
    // These exact names belong to this invocation; no unrelated containers are touched.
    await execute(['rm', '--force', name, appName], 15_000, true).catch(() => {});
    app?.kill();
    await rm(join(output, 'target.json'), { force: true });
  }
}
