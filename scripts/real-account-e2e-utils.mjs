import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const REAL_ACCOUNT_E2E_PORT_MIN = 5431;
export const REAL_ACCOUNT_E2E_PORT_MAX = 5439;

export function portsForRealAccountRun(runNumber) {
  if (!Number.isSafeInteger(runNumber) || runNumber < 1 || runNumber > 4) {
    throw new RangeError('Real-account E2E run number must be from 1 to 4.');
  }
  const runtimePort = REAL_ACCOUNT_E2E_PORT_MIN + (runNumber - 1) * 2;
  return { runtimePort, webPort: runtimePort + 1 };
}

export async function assertOwnedPortsAvailable(ports) {
  for (const port of ports) {
    if (
      !Number.isSafeInteger(port) ||
      port < REAL_ACCOUNT_E2E_PORT_MIN ||
      port > REAL_ACCOUNT_E2E_PORT_MAX
    ) {
      throw new RangeError(
        `Fixture port must be from ${REAL_ACCOUNT_E2E_PORT_MIN} to ${REAL_ACCOUNT_E2E_PORT_MAX}.`,
      );
    }
    const probe = createServer();
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        probe.removeListener('listening', onListening);
        reject(new Error(`Owned fixture port ${port} is unavailable; no process was stopped.`));
      };
      const onListening = () => {
        probe.removeListener('error', onError);
        probe.close((error) => (error ? reject(error) : resolve()));
      };
      probe.once('error', onError);
      probe.once('listening', onListening);
      probe.listen(port, '127.0.0.1');
    });
  }
}

export function createCleanupStack() {
  const callbacks = [];
  return {
    defer(callback) {
      callbacks.push(callback);
    },
    async dispose() {
      const errors = [];
      while (callbacks.length > 0) {
        try {
          await callbacks.pop()();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'One or more owned E2E resources failed to clean up.');
      }
    },
  };
}

export function runOwnedCommand(command, args, options = {}) {
  const spawnCommand = options.spawn ?? spawn;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnCommand(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: options.stdio ?? 'inherit',
      });
    } catch (error) {
      reject(error);
      return;
    }
    options.onSpawn?.(child);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const signalNumber = signal ? osConstants.signals[signal] : undefined;
      resolve(code ?? (signalNumber ? 128 + signalNumber : 1));
    });
  });
}

export function localOnlyEnv(source = process.env, overrides = {}) {
  const env = { ...source, ...overrides };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('AWS_') ||
      key === 'AWS_PROFILE' ||
      key === 'AWS_DEFAULT_PROFILE' ||
      key === 'AWS_CONFIG_FILE' ||
      key === 'AWS_SHARED_CREDENTIALS_FILE' ||
      key.startsWith('CLOUDSDK_')
    ) {
      delete env[key];
    }
  }
  return env;
}

export function redactRealAccountDiagnostic(value) {
  return String(value)
    .replace(/\/media\/access\/[A-Za-z0-9_-]+/g, '/media/access/<capability>')
    .replace(
      /((?:sessionId|groupId|cycleId|jobId|contributionId|accountId|token|password|inviteCode|code)=)[^&\s)]+/gi,
      '$1<redacted>',
    )
    .replace(/\b[A-Z0-9]{6}(?:-[A-Z0-9]{3})?\b/g, '<invite>')
    .replace(/(?:\/Users\/|\/private\/var\/|\/var\/folders\/|\/tmp\/)[^\s)]+/g, '<local-path>')
    .replace(/\b(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):\d+\b/g, '<local-url>');
}

async function checkedCommand(command, args, cwd) {
  const result = await runOwnedCommand(command, args, { cwd, stdio: 'ignore' });
  if (result !== 0) throw new Error(`${command} exited with code ${result}.`);
}

export async function createLocalTlsProfile({ directory, runNumber, cwd = process.cwd() }) {
  const profileDir = join(directory, 'firefox-profile');
  const caKey = join(directory, 'ca.key');
  const caCert = join(directory, 'ca.crt');
  const serverKey = join(directory, 'server.key');
  const serverCsr = join(directory, 'server.csr');
  const serverCert = join(directory, 'server.crt');
  const extensionFile = join(directory, 'server.ext');
  await mkdir(profileDir, { recursive: true });
  await checkedCommand(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      caKey,
      '-out',
      caCert,
      '-days',
      '2',
      '-subj',
      `/CN=Rewind-Disposable-E2E-CA-${runNumber}`,
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
      '-addext',
      'subjectKeyIdentifier=hash',
    ],
    cwd,
  );
  await checkedCommand(
    'openssl',
    [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      serverKey,
      '-out',
      serverCsr,
      '-subj',
      '/CN=localhost',
    ],
    cwd,
  );
  await writeFile(
    extensionFile,
    [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  await checkedCommand(
    'openssl',
    [
      'x509',
      '-req',
      '-in',
      serverCsr,
      '-CA',
      caCert,
      '-CAkey',
      caKey,
      '-CAcreateserial',
      '-out',
      serverCert,
      '-days',
      '2',
      '-sha256',
      '-extfile',
      extensionFile,
    ],
    cwd,
  );
  await checkedCommand(
    'openssl',
    ['verify', '-CAfile', caCert, '-verify_hostname', 'localhost', serverCert],
    cwd,
  );
  await checkedCommand(
    'openssl',
    ['verify', '-CAfile', caCert, '-verify_ip', '127.0.0.1', serverCert],
    cwd,
  );
  await checkedCommand('certutil', ['-N', '--empty-password', '-d', `sql:${profileDir}`], cwd);
  await checkedCommand(
    'certutil',
    [
      '-A',
      '-d',
      `sql:${profileDir}`,
      '-n',
      `Rewind disposable E2E CA ${runNumber}`,
      '-t',
      'CT,,',
      '-i',
      caCert,
    ],
    cwd,
  );
  return { caCert, profileDir, serverCert, serverKey };
}
