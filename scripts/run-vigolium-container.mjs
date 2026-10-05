import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { summaryHtml } from './vigolium-provider.mjs';
import { resolve, join } from 'node:path';
import {
  fixtureContainerArgs,
  fixtureImage,
  prepareReportDirectory,
  retryableFixtureFailure,
} from './vigolium-container.mjs';

const mode = process.argv[2];
if (!['--build', '--verify', '--run', '--replay'].includes(mode))
  throw new Error('Choose --build, --verify, --run or --replay');
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
  const reportGroup = await prepareReportDirectory(output);
  const args = fixtureContainerArgs({
    live: mode === '--run',
    env: process.env,
    output,
    name,
    reportGroup,
  });
  if (mode === '--replay') args[args.length - 2] = '--replay';
  try {
    if (mode === '--verify') {
      const probe = fixtureContainerArgs({ output, name: `${name}-check`, reportGroup }).slice(
        0,
        -3,
      );
      await execute(
        [...probe, '--entrypoint', 'node', fixtureImage, 'scripts/check-vigolium-isolation.mjs'],
        45_000,
      );
    }
    const attempts = [];
    for (let attempt = 1; attempt <= (mode === '--run' ? 2 : 1); attempt++) {
      try {
        await execute(args, 420_000);
        break;
      } catch (error) {
        const report = await readFile(join(output, 'scope.json'), 'utf8')
          .then(JSON.parse)
          .catch(() => undefined);
        if (mode !== '--run' || attempt === 2 || !retryableFixtureFailure(report)) throw error;
        attempts.push({ attempt, status: report.status, message: report.message });
        await execute(['rm', '--force', name], 10000).catch(() => {});
        console.log(
          'Retrying fixture generation once after a transient failure; detection gate unchanged.',
        );
      }
    }
    if (attempts.length) {
      const report = JSON.parse(await readFile(join(output, 'scope.json'), 'utf8'));
      report.generationRetries = attempts;
      await writeFile(join(output, 'scope.json'), JSON.stringify(report, null, 2));
      await writeFile(join(output, 'summary.html'), summaryHtml(report));
    }
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
