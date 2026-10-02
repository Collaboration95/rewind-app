import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fixtureContainerArgs, fixtureImage } from './vigolium-container.mjs';

const mode = process.argv[2];
if (!['--build', '--verify', '--run'].includes(mode))
  throw new Error('Choose --build, --verify or --run');
const docker = process.env.REWIND_DOCKER_BIN || 'docker';
async function execute(args, deadline) {
  const child = spawn(docker, args, { stdio: 'inherit' });
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    child.kill();
  }, deadline);
  try {
    const [code] = await once(child, 'exit');
    if (expired) throw new Error('Container operation exceeded its deadline');
    if (code !== 0) throw new Error(`Docker exited with code ${code}`);
  } finally {
    clearTimeout(timer);
  }
}

if (mode === '--build') {
  await execute(
    ['build', '--file', 'security/agentic/Dockerfile', '--tag', fixtureImage, '.'],
    1200_000,
  );
} else {
  const output = resolve('vigolium-result/agentic-container');
  const name = `rewind-agentic-${randomUUID()}`;
  const args = fixtureContainerArgs({ live: mode === '--run', env: process.env, output, name });
  await mkdir(output, { recursive: true });
  try {
    if (mode === '--verify') {
      const probe = fixtureContainerArgs({ output, name: `${name}-check` }).slice(0, -3);
      await execute(
        [...probe, '--entrypoint', 'node', fixtureImage, 'scripts/check-vigolium-isolation.mjs'],
        45_000,
      );
    }
    await execute(args, 420_000);
  } finally {
    // Remove this one owned container even if the Docker client was terminated.
    const child = spawn(docker, ['rm', '--force', name, `${name}-check`], { stdio: 'ignore' });
    child.on('error', () => {});
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      await once(child, 'close');
    } catch {
      /* Preserve the original launch failure. */
    } finally {
      clearTimeout(timer);
    }
  }
}
