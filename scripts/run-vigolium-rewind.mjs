import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { disposableTarget } from './vigolium-provider.mjs';
import { fixtureContainerArgs, fixtureImage } from './vigolium-container.mjs';

const mode = process.argv[2];
if (!['--build', '--verify'].includes(mode))
  throw new Error('Choose --build or --verify; live Rewind scanning is not enabled yet');
const docker = process.env.REWIND_DOCKER_BIN || 'docker';
const image = 'rewind-vigolium-target:trial';
async function execute(args, deadline = 60_000, quiet = false) {
  const child = spawn(docker, args, { stdio: quiet ? 'ignore' : 'inherit' });
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
  const output = resolve('vigolium-result/agentic-rewind-container');
  const name = `rewind-agentic-${randomUUID()}`;
  const appName = `${name}-app`;
  await mkdir(output, { recursive: true });
  await rm(join(output, 'target.json'), { force: true });
  await rm(join(output, 'app-baselines.json'), { force: true });
  const appArgs = fixtureContainerArgs({ output, name: appName }).slice(0, -3);
  appArgs.splice(1, 0, '--detach');
  const scannerArgs = fixtureContainerArgs({ output, name });
  scannerArgs[scannerArgs.indexOf('--network') + 1] = `container:${appName}`;
  scannerArgs.splice(-3, 3, fixtureImage, '--verify', '--target-file', '/reports/target.json');
  try {
    await execute([...appArgs, image]);
    const deadline = Date.now() + 45_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        disposableTarget(JSON.parse(await readFile(join(output, 'target.json'), 'utf8')));
        ready = true;
        break;
      } catch {
        await delay(500);
      }
    }
    if (!ready) throw new Error('Disposable Rewind backend did not become ready');
    await execute(
      [
        ...scannerArgs.slice(0, -4),
        '--entrypoint',
        'node',
        fixtureImage,
        'scripts/check-vigolium-isolation.mjs',
      ],
      45_000,
    );
    await execute(scannerArgs, 60_000);
  } finally {
    // These exact names belong to this invocation; no unrelated containers are touched.
    await execute(['rm', '--force', name, appName], 15_000, true).catch(() => {});
    await rm(join(output, 'target.json'), { force: true });
  }
}
