import { isAbsolute, parse, resolve } from 'node:path';

export const SERVICE_VERSION = '0.1.0';
export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = '0.0.0.0';

export interface RuntimeConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  ffmpegBin: string;
  allowOrigin: string;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(`${message} ${hint}`);
    this.name = 'ConfigError';
  }
}

function parsePort(value: string | undefined): number {
  if (!value) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigError(
      `REWIND_PORT must be an integer from 0 to 65535 (received ${JSON.stringify(value)}).`,
      'Set REWIND_PORT=8787 or leave it unset to use the default.',
    );
  }
  return port;
}

function parseHost(value: string | undefined): string {
  const host = value?.trim() || DEFAULT_HOST;
  const allowed = new Set(['0.0.0.0', '127.0.0.1', '::', '::1', 'localhost']);
  if (!allowed.has(host)) {
    throw new ConfigError(
      `REWIND_HOST must be a local or LAN-safe bind address (received ${JSON.stringify(host)}).`,
      'Use 127.0.0.1 for this Mac only or 0.0.0.0 for an explicitly trusted LAN.',
    );
  }
  return host;
}

export function parseConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const dataDirInput = env.REWIND_DATA_DIR?.trim() || resolve(process.cwd(), '.local-data');
  const dataDir = isAbsolute(dataDirInput) ? dataDirInput : resolve(process.cwd(), dataDirInput);
  if (parse(dataDir).root === dataDir) {
    throw new ConfigError(
      'REWIND_DATA_DIR must not point at the filesystem root.',
      'Choose a project-local directory such as .local-data or an explicit temporary directory.',
    );
  }
  const databasePath = resolve(dataDir, 'rewind.sqlite');
  const ffmpegBin = env.REWIND_FFMPEG_BIN?.trim() || 'ffmpeg';
  if (!ffmpegBin) {
    throw new ConfigError(
      'REWIND_FFMPEG_BIN cannot be empty.',
      'Set it to ffmpeg or to the absolute path of a compatible FFmpeg binary.',
    );
  }

  return {
    host: parseHost(env.REWIND_HOST),
    port: parsePort(env.REWIND_PORT),
    dataDir,
    databasePath,
    ffmpegBin,
    allowOrigin: env.REWIND_ALLOW_ORIGIN?.trim() || '*',
  };
}
