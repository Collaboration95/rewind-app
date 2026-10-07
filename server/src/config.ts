import { isAbsolute, parse, resolve } from 'node:path';
import type { MediaRuntimeConfig } from './media/runtime-store';
import type { ReminderProviderConfig } from './reminders/providers';
import { validateReminderVapidConfig } from './reminders/config';

export const SERVICE_VERSION = '0.1.0';
export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = '0.0.0.0';
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_HTTP_UPLOAD_TIMEOUT_MS = 120_000;
export const DEFAULT_HTTP_MAX_CONCURRENT_INTAKES = 2;
export const DEFAULT_HTTP_MAX_CONCURRENT_PROCESSING = 1;

const REAL_CYCLE_DEFAULT_MINUTES = 28 * 24 * 60;

export interface RuntimeConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  ffmpegBin: string;
  allowOrigin: string;
  originAuthSecret: string | null;
  /** Enables the read-only /admin table browser (Basic auth, user "admin"). */
  adminPassword?: string | null;
  allowInsecureLocalAuth: boolean;
  /** Log one JSON timing line per request (REWIND_REQUEST_TIMING). */
  requestTiming?: boolean;
  /** Length of a new real group's first cycle; successors repeat it. */
  realCycleDurationMs?: number;
  httpIdleTimeoutMs: number;
  uploadTimeoutMs: number;
  maxConcurrentIntakes: number;
  maxConcurrentProcessing: number;
  /** Unset keeps the local SQLite file at databasePath. */
  database?: PostgresRuntimeConfig | null;
  /** Unset preserves legacy disk paths; opt-in stores use immutable references. */
  media?: MediaRuntimeConfig | null;
  reminders?: ReminderProviderConfig | null;
}

export interface PostgresRuntimeConfig {
  url: string;
  host: string;
  /** verify: TLS with the bundled Amazon RDS CA. disable: loopback only. */
  tls: 'verify' | 'disable';
  /** Recorded in the database on first start; a mismatch refuses to start. */
  environment: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function parseDatabaseConfig(env: NodeJS.ProcessEnv): PostgresRuntimeConfig | null {
  const url = env.REWIND_DATABASE_URL?.trim();
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(
      'REWIND_DATABASE_URL is not a valid URL.',
      'Use postgres://USER:PASSWORD@HOST:5432/DATABASE, or leave it unset for local SQLite.',
    );
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new ConfigError(
      'REWIND_DATABASE_URL must be a postgres:// URL with a host.',
      'Use postgres://USER:PASSWORD@HOST:5432/DATABASE, or leave it unset for local SQLite.',
    );
  }
  if (parsed.searchParams.has('sslmode')) {
    throw new ConfigError(
      'REWIND_DATABASE_URL must not carry sslmode.',
      'Set REWIND_DATABASE_TLS=verify (default) or disable instead.',
    );
  }
  const tls = env.REWIND_DATABASE_TLS?.trim() || 'verify';
  if (tls !== 'verify' && tls !== 'disable') {
    throw new ConfigError(
      'REWIND_DATABASE_TLS must be verify or disable.',
      'Leave it unset to verify TLS against the bundled Amazon RDS certificates.',
    );
  }
  if (tls === 'disable' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new ConfigError(
      'REWIND_DATABASE_TLS=disable is only allowed for a loopback database.',
      'Remote databases must use TLS; leave REWIND_DATABASE_TLS unset.',
    );
  }
  const environment =
    env.REWIND_DATABASE_ENVIRONMENT?.trim() || env.REWIND_MEDIA_ENVIRONMENT?.trim() || 'local';
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(environment)) {
    throw new ConfigError(
      'REWIND_DATABASE_ENVIRONMENT must be a short lowercase name such as dev or release.',
      'It defaults to REWIND_MEDIA_ENVIRONMENT, then local.',
    );
  }
  return { url, host: parsed.hostname, tls, environment };
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

function parseAdminPassword(value: string | undefined): string | null {
  const password = value?.trim();
  if (!password) return null;
  if (password.length < 16) {
    throw new ConfigError(
      'REWIND_ADMIN_PASSWORD must be at least 16 characters.',
      'Use a long random value or leave it unset to disable the admin page.',
    );
  }
  return password;
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
    adminPassword: parseAdminPassword(env.REWIND_ADMIN_PASSWORD),
    allowInsecureLocalAuth: ['1', 'true'].includes(
      env.REWIND_ALLOW_INSECURE_LOCAL_AUTH?.trim().toLowerCase() ?? '',
    ),
    requestTiming: ['1', 'true'].includes(env.REWIND_REQUEST_TIMING?.trim().toLowerCase() ?? ''),
    // The product default is four weeks; a short value supports local reveal
    // testing (for example 1440 for a one-day cycle).
    realCycleDurationMs:
      parsePositiveInteger(
        env.REWIND_REAL_CYCLE_MINUTES,
        'REWIND_REAL_CYCLE_MINUTES',
        REAL_CYCLE_DEFAULT_MINUTES,
        REAL_CYCLE_DEFAULT_MINUTES,
      ) * 60_000,
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
    database: parseDatabaseConfig(env),
    media: parseMediaConfig(env, dataDir),
    reminders: parseReminderConfig(env),
  };
}

function parseReminderConfig(env: NodeJS.ProcessEnv): ReminderProviderConfig | null {
  const config: ReminderProviderConfig = {};
  const enabled = env.REWIND_REMINDER_EXPO_ENABLED?.trim();
  if (enabled && !['true', 'false'].includes(enabled))
    throw new ConfigError(
      'REWIND_REMINDER_EXPO_ENABLED must be true or false.',
      'Leave providers unset to disable remote sending.',
    );
  if (enabled === 'true') {
    const accessToken = env.REWIND_REMINDER_EXPO_ACCESS_TOKEN?.trim();
    if (accessToken && (accessToken.length > 4096 || /\s/.test(accessToken)))
      throw new ConfigError(
        'Invalid Expo reminder credential.',
        'Use an environment-supplied provider access token.',
      );
    config.expo = accessToken ? { accessToken } : {};
  }
  const subject = env.REWIND_REMINDER_VAPID_SUBJECT?.trim();
  const publicKey = env.REWIND_REMINDER_VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.REWIND_REMINDER_VAPID_PRIVATE_KEY?.trim();
  if (subject || publicKey || privateKey) {
    let validSubject = false;
    try {
      const url = new URL(subject ?? '');
      validSubject = ['mailto:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      /* Invalid provider identity. */
    }
    if (
      !validSubject ||
      !publicKey ||
      !privateKey ||
      !/^[A-Za-z0-9_-]{87}$/.test(publicKey) ||
      !/^[A-Za-z0-9_-]{43}$/.test(privateKey) ||
      Buffer.from(publicKey, 'base64url').length !== 65 ||
      Buffer.from(privateKey, 'base64url').length !== 32
    )
      throw new ConfigError(
        'Invalid Web Push reminder configuration.',
        'Set the complete environment-supplied VAPID subject/key pair; never use application or account credentials.',
      );
    config.webpush = validateReminderVapidConfig({ subject: subject!, publicKey, privateKey });
  }
  return Object.keys(config).length ? config : null;
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
