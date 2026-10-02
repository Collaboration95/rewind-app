import { isAbsolute, parse, resolve } from 'node:path';
import type { MediaRuntimeConfig } from './media/runtime-store';

export const SERVICE_VERSION = '0.1.0';
export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = '0.0.0.0';
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_HTTP_UPLOAD_TIMEOUT_MS = 120_000;
export const DEFAULT_HTTP_MAX_CONCURRENT_INTAKES = 2;
export const DEFAULT_HTTP_MAX_CONCURRENT_PROCESSING = 1;

export interface RuntimeConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  ffmpegBin: string;
  allowOrigin: string;
  originAuthSecret: string | null;
  allowInsecureLocalAuth: boolean;
  httpIdleTimeoutMs: number;
  uploadTimeoutMs: number;
  maxConcurrentIntakes: number;
  maxConcurrentProcessing: number;
  /** Unset preserves legacy disk paths; opt-in stores use immutable references. */
  media?: MediaRuntimeConfig | null;
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

function parsePositiveInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  maximum: number,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ConfigError(
      `${name} must be an integer from 1 to ${maximum} (received ${JSON.stringify(value)}).`,
      `Set ${name} to a bounded positive integer or leave it unset to use the default.`,
    );
  }
  return parsed;
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
    // Only configure when a verified edge overwrites this header on every
    // origin request; it is not a substitute for enforcing viewer HTTPS.
    originAuthSecret: env.REWIND_ORIGIN_AUTH_SECRET?.trim() || null,
    allowInsecureLocalAuth: ['1', 'true'].includes(
      env.REWIND_ALLOW_INSECURE_LOCAL_AUTH?.trim().toLowerCase() ?? '',
    ),
    httpIdleTimeoutMs: parsePositiveInteger(
      env.REWIND_HTTP_IDLE_TIMEOUT_MS,
      'REWIND_HTTP_IDLE_TIMEOUT_MS',
      DEFAULT_HTTP_IDLE_TIMEOUT_MS,
      3_600_000,
    ),
    uploadTimeoutMs: parsePositiveInteger(
      env.REWIND_HTTP_UPLOAD_TIMEOUT_MS,
      'REWIND_HTTP_UPLOAD_TIMEOUT_MS',
      DEFAULT_HTTP_UPLOAD_TIMEOUT_MS,
      3_600_000,
    ),
    maxConcurrentIntakes: parsePositiveInteger(
      env.REWIND_HTTP_MAX_CONCURRENT_INTAKES,
      'REWIND_HTTP_MAX_CONCURRENT_INTAKES',
      DEFAULT_HTTP_MAX_CONCURRENT_INTAKES,
      64,
    ),
    maxConcurrentProcessing: parsePositiveInteger(
      env.REWIND_HTTP_MAX_CONCURRENT_PROCESSING,
      'REWIND_HTTP_MAX_CONCURRENT_PROCESSING',
      DEFAULT_HTTP_MAX_CONCURRENT_PROCESSING,
      64,
    ),
    media: parseMediaConfig(env, dataDir),
  };
}

function parseMediaConfig(env: NodeJS.ProcessEnv, dataDir: string): MediaRuntimeConfig | null {
  const backend = env.REWIND_MEDIA_BACKEND?.trim() || 'disk';
  if (backend === 'disk') return null;
  const invalid = (name: string): never => {
    throw new ConfigError(
      `${name} is invalid for the configured media backend.`,
      'Use disk for filesystem rollback, or configure an explicit local/S3 store and namespace.',
    );
  };
  if (backend !== 'local' && backend !== 's3') invalid('REWIND_MEDIA_BACKEND');
  const environment = env.REWIND_MEDIA_ENVIRONMENT?.trim() || '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(environment)) invalid('REWIND_MEDIA_ENVIRONMENT');
  if (backend === 'local') {
    // Keep the versioned adapter separate from legacy processed/staged paths.
    return { backend, environment, root: resolve(dataDir, 'media', 'objects') };
  }
  const bucket = env.REWIND_MEDIA_S3_BUCKET?.trim() || '';
  const expectedBucketOwner = env.REWIND_MEDIA_S3_OWNER?.trim() || '';
  const region = env.REWIND_MEDIA_S3_REGION?.trim() || '';
  const kmsKeyId = env.REWIND_MEDIA_S3_KMS_KEY_ARN?.trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) invalid('REWIND_MEDIA_S3_BUCKET');
  if (!/^\d{12}$/.test(expectedBucketOwner)) invalid('REWIND_MEDIA_S3_OWNER');
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) invalid('REWIND_MEDIA_S3_REGION');
  if (
    kmsKeyId &&
    !/^arn:aws(?:-cn|-us-gov)?:kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]+$/.test(kmsKeyId)
  )
    invalid('REWIND_MEDIA_S3_KMS_KEY_ARN');
  return {
    backend: 's3',
    environment,
    bucket,
    expectedBucketOwner,
    region,
    ...(kmsKeyId ? { kmsKeyId } : {}),
  };
}
