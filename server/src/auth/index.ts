import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import type { RewindDatabase } from '../db';

interface ScryptParameters {
  N: number;
  r: number;
  p: number;
  keyLength: number;
  maxmem: number;
}

export const PASSWORD_SCRYPT: Readonly<ScryptParameters> = Object.freeze({
  N: 32_768,
  r: 8,
  p: 1,
  keyLength: 64,
  maxmem: 64 * 1024 * 1024,
});
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_FAILURE_LIMIT = 5;
export const BASE_COOLDOWN_MS = 15 * 60 * 1000;
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
export const REAL_SESSION_COOKIE = '__Host-rewind_session';
const DUMMY_SALT = Buffer.from('2ccf2ee9fc7ee2a87d5a74044cafc5a3', 'hex');
const DUMMY_HASH = Buffer.alloc(PASSWORD_SCRYPT.keyLength);
let authOperationTail: Promise<void> = Promise.resolve();

/** Keep password changes and login verification ordered in this single-process
 * SQLite service so parallel guesses cannot pass the same throttle check and
 * a pre-reset verification cannot mint a post-reset session. */
function serializeAuthOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = authOperationTail.then(operation);
  authOperationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export interface RealAccount {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export type CreateAccountResult =
  { ok: true; account: RealAccount } | { ok: false; reason: 'duplicate' };
export type ResetAccountResult =
  { ok: true; account: RealAccount } | { ok: false; reason: 'missing' };
export type LoginResult =
  | { status: 'authenticated'; account: RealAccount; token: string; expiresAt: string }
  | { status: 'invalid' | 'throttled' };
export type RealSessionResult =
  | { status: 'valid'; account: RealAccount; idleExpiresAt: string; absoluteExpiresAt: string }
  | { status: 'invalid' };

function scrypt(
  password: string,
  salt: Uint8Array,
  parameters: ScryptParameters = PASSWORD_SCRYPT,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { keyLength, ...options } = parameters;
    scryptCallback(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

function normalizeUsername(value: string): { username: string; normalized: string } | null {
  const username = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(username)) return null;
  return { username, normalized: username.toLowerCase() };
}

function mapAccount(row: Record<string, unknown>): RealAccount {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.displayName),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function readAccount(database: RewindDatabase, normalizedUsername: string): RealAccount | null {
  const row = database
    .prepare(
      `SELECT id, username, display_name AS displayName,
      created_at AS createdAt, updated_at AS updatedAt
      FROM real_accounts WHERE normalized_username = ?`,
    )
    .get(normalizedUsername) as Record<string, unknown> | undefined;
  return row ? mapAccount(row) : null;
}

function validateAccountInput(usernameInput: string, displayNameInput: string, password: string) {
  const username = normalizeUsername(usernameInput);
  const displayName = displayNameInput.trim();
  if (
    !username ||
    !displayName ||
    displayName.length > 80 ||
    password.length < 12 ||
    password.length > 1024
  ) {
    return null;
  }
  return { ...username, displayName };
}

export async function createRealAccount(
  database: RewindDatabase,
  usernameInput: string,
  displayNameInput: string,
  password: string,
  now = new Date(),
): Promise<CreateAccountResult | { ok: false; reason: 'invalid' }> {
  return serializeAuthOperation(() =>
    createRealAccountUnlocked(database, usernameInput, displayNameInput, password, now),
  );
}

async function createRealAccountUnlocked(
  database: RewindDatabase,
  usernameInput: string,
  displayNameInput: string,
  password: string,
  now: Date,
): Promise<CreateAccountResult | { ok: false; reason: 'invalid' }> {
  const input = validateAccountInput(usernameInput, displayNameInput, password);
  if (!input) return { ok: false, reason: 'invalid' };
  const salt = randomBytes(16);
  const passwordHash = await scrypt(password, salt);
  const timestamp = now.toISOString();
  const id = randomUUID();
  try {
    database
      .prepare(
        `INSERT INTO real_accounts
      (id, username, normalized_username, display_name, password_salt, password_hash,
       password_scrypt_n, password_scrypt_r, password_scrypt_p, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.username,
        input.normalized,
        input.displayName,
        salt.toString('hex'),
        passwordHash.toString('hex'),
        PASSWORD_SCRYPT.N,
        PASSWORD_SCRYPT.r,
        PASSWORD_SCRYPT.p,
        timestamp,
        timestamp,
      );
  } catch (error) {
    const sqliteError = error as { code?: string; errcode?: number };
    if (sqliteError.code === 'SQLITE_CONSTRAINT_UNIQUE' || sqliteError.errcode === 2067) {
      return { ok: false, reason: 'duplicate' };
    }
    throw error;
  }
  return { ok: true, account: readAccount(database, input.normalized)! };
}

export async function resetRealAccountPassword(
  database: RewindDatabase,
  usernameInput: string,
  password: string,
  now = new Date(),
): Promise<ResetAccountResult | { ok: false; reason: 'invalid' }> {
  return serializeAuthOperation(() =>
    resetRealAccountPasswordUnlocked(database, usernameInput, password, now),
  );
}

async function resetRealAccountPasswordUnlocked(
  database: RewindDatabase,
  usernameInput: string,
  password: string,
  now: Date,
): Promise<ResetAccountResult | { ok: false; reason: 'invalid' }> {
  const username = normalizeUsername(usernameInput);
  if (!username || password.length < 12 || password.length > 1024)
    return { ok: false, reason: 'invalid' };
  const account = readAccount(database, username.normalized);
  if (!account) return { ok: false, reason: 'missing' };
  const salt = randomBytes(16);
  const passwordHash = await scrypt(password, salt);
  const timestamp = now.toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    const update = database.prepare(`UPDATE real_accounts SET password_salt = ?, password_hash = ?,
      password_scrypt_n = ?, password_scrypt_r = ?, password_scrypt_p = ?, updated_at = ?
      WHERE id = ?`);
    update.run(
      salt.toString('hex'),
      passwordHash.toString('hex'),
      PASSWORD_SCRYPT.N,
      PASSWORD_SCRYPT.r,
      PASSWORD_SCRYPT.p,
      timestamp,
      account.id,
    );
    database
      .prepare(
        `UPDATE real_account_sessions SET revoked_at = ?
      WHERE account_id = ? AND revoked_at IS NULL`,
      )
      .run(timestamp, account.id);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return { ok: true, account: readAccount(database, username.normalized)! };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface ThrottleRow {
  failures: number;
  windowStartedAt: string;
  cooldownUntil: string | null;
  cooldownLevel: number;
}

function throttleRow(
  database: RewindDatabase,
  scope: 'account' | 'source',
  subject: string,
): ThrottleRow | null {
  const row = database
    .prepare(
      `SELECT failures, window_started_at AS windowStartedAt,
    cooldown_until AS cooldownUntil, cooldown_level AS cooldownLevel
    FROM auth_login_throttles WHERE scope = ? AND subject_hash = ?`,
    )
    .get(scope, digest(subject)) as (ThrottleRow & Record<string, unknown>) | undefined;
  return row ?? null;
}

export function isLoginThrottled(
  database: RewindDatabase,
  username: string,
  source: string,
  now = new Date(),
): boolean {
  const nowMs = now.getTime();
  return (['account', 'source'] as const).some((scope) => {
    const row = throttleRow(database, scope, scope === 'account' ? username : source);
    return Boolean(row?.cooldownUntil && Date.parse(row.cooldownUntil) > nowMs);
  });
}

function recordFailure(
  database: RewindDatabase,
  scope: 'account' | 'source',
  subject: string,
  now: Date,
): void {
  const subjectHash = digest(subject);
  const old = throttleRow(database, scope, subject);
  const timestamp = now.toISOString();
  const inWindow = old && now.getTime() - Date.parse(old.windowStartedAt) < LOGIN_WINDOW_MS;
  const failures = inWindow ? old.failures + 1 : 1;
  const windowStartedAt = inWindow ? old.windowStartedAt : timestamp;
  let cooldownUntil: string | null = null;
  let cooldownLevel = old?.cooldownLevel ?? 0;
  if (failures >= LOGIN_FAILURE_LIMIT) {
    cooldownLevel += 1;
    const cooldownMs = Math.min(BASE_COOLDOWN_MS * 2 ** (cooldownLevel - 1), 24 * 60 * 60 * 1000);
    cooldownUntil = new Date(now.getTime() + cooldownMs).toISOString();
  }
  database
    .prepare(
      `INSERT INTO auth_login_throttles
    (scope, subject_hash, failures, window_started_at, cooldown_until, cooldown_level, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, subject_hash) DO UPDATE SET failures = excluded.failures,
      window_started_at = excluded.window_started_at, cooldown_until = excluded.cooldown_until,
      cooldown_level = excluded.cooldown_level, updated_at = excluded.updated_at`,
    )
    .run(
      scope,
      subjectHash,
      failures >= LOGIN_FAILURE_LIMIT ? 0 : failures,
      windowStartedAt,
      cooldownUntil,
      cooldownLevel,
      timestamp,
    );
}

export async function authenticateRealAccount(
  database: RewindDatabase,
  usernameInput: string,
  password: string,
  source: string,
  now = new Date(),
): Promise<LoginResult> {
  return serializeAuthOperation(() =>
    authenticateRealAccountUnlocked(database, usernameInput, password, source, now),
  );
}

async function authenticateRealAccountUnlocked(
  database: RewindDatabase,
  usernameInput: string,
  password: string,
  source: string,
  now: Date,
): Promise<LoginResult> {
  const username = normalizeUsername(usernameInput);
  const normalized = username?.normalized ?? usernameInput.trim().toLowerCase().slice(0, 128);
  if (isLoginThrottled(database, normalized, source, now)) return { status: 'throttled' };
  const row = database
    .prepare(
      `SELECT id, username, display_name AS displayName,
    created_at AS createdAt, updated_at AS updatedAt, password_salt AS passwordSalt,
    password_hash AS passwordHash, password_scrypt_n AS scryptN,
    password_scrypt_r AS scryptR, password_scrypt_p AS scryptP
    FROM real_accounts WHERE normalized_username = ?`,
    )
    .get(normalized) as
    | (Record<string, unknown> & {
        passwordSalt?: string;
        passwordHash?: string;
        scryptN?: number;
        scryptR?: number;
        scryptP?: number;
      })
    | undefined;
  const salt = row?.passwordSalt ? Buffer.from(row.passwordSalt, 'hex') : DUMMY_SALT;
  const n = Number(row?.scryptN);
  const r = Number(row?.scryptR);
  const p = Number(row?.scryptP);
  const parametersValid =
    Number.isSafeInteger(n) &&
    n >= 16_384 &&
    n <= 262_144 &&
    (n & (n - 1)) === 0 &&
    Number.isSafeInteger(r) &&
    r >= 1 &&
    r <= 8 &&
    Number.isSafeInteger(p) &&
    p >= 1 &&
    p <= 2;
  const actualHash = await scrypt(
    password,
    salt,
    row && parametersValid
      ? {
          N: n,
          r,
          p,
          keyLength: PASSWORD_SCRYPT.keyLength,
          maxmem: Math.max(PASSWORD_SCRYPT.maxmem, 128 * n * r + 1024 * 1024),
        }
      : PASSWORD_SCRYPT,
  );
  const expectedHash = row?.passwordHash ? Buffer.from(row.passwordHash, 'hex') : DUMMY_HASH;
  if (
    !row ||
    !parametersValid ||
    !row.passwordHash ||
    expectedHash.length !== actualHash.length ||
    !timingSafeEqual(expectedHash, actualHash) ||
    !username ||
    isLoginThrottled(database, normalized, source, now)
  ) {
    recordFailure(database, 'account', normalized, now);
    recordFailure(database, 'source', source, now);
    return { status: 'invalid' };
  }

  for (const scope of ['account', 'source'] as const) {
    database
      .prepare('DELETE FROM auth_login_throttles WHERE scope = ? AND subject_hash = ?')
      .run(scope, digest(scope === 'account' ? normalized : source));
  }
  const token = randomBytes(32).toString('base64url');
  const tokenHash = digest(token);
  const createdAt = now.toISOString();
  const absoluteExpiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS).toISOString();
  const idleExpiresAt = new Date(
    Math.min(now.getTime() + SESSION_IDLE_MS, Date.parse(absoluteExpiresAt)),
  ).toISOString();
  database
    .prepare(
      `INSERT INTO real_account_sessions
    (token_hash, account_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(tokenHash, String(row.id), createdAt, createdAt, idleExpiresAt, absoluteExpiresAt);
  return { status: 'authenticated', account: mapAccount(row), token, expiresAt: idleExpiresAt };
}

export function validateRealSession(
  database: RewindDatabase,
  token: string,
  now = new Date(),
): RealSessionResult {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { status: 'invalid' };
  const tokenHash = digest(token);
  const row = database
    .prepare(
      `SELECT s.account_id AS accountId, s.last_seen_at AS lastSeenAt,
    s.idle_expires_at AS idleExpiresAt, s.absolute_expires_at AS absoluteExpiresAt,
    s.revoked_at AS revokedAt, a.username, a.display_name AS displayName,
    a.created_at AS createdAt, a.updated_at AS updatedAt
    FROM real_account_sessions s JOIN real_accounts a ON a.id = s.account_id
    WHERE s.token_hash = ?`,
    )
    .get(tokenHash) as
    | (Record<string, unknown> & {
        accountId: string;
        idleExpiresAt: string;
        absoluteExpiresAt: string;
        revokedAt: string | null;
      })
    | undefined;
  if (
    !row ||
    row.revokedAt ||
    Date.parse(row.idleExpiresAt) <= now.getTime() ||
    Date.parse(row.absoluteExpiresAt) <= now.getTime()
  ) {
    if (row && !row.revokedAt)
      database
        .prepare('UPDATE real_account_sessions SET revoked_at = ? WHERE token_hash = ?')
        .run(now.toISOString(), tokenHash);
    return { status: 'invalid' };
  }
  const nextIdle = new Date(
    Math.min(now.getTime() + SESSION_IDLE_MS, Date.parse(row.absoluteExpiresAt)),
  ).toISOString();
  database
    .prepare(
      'UPDATE real_account_sessions SET last_seen_at = ?, idle_expires_at = ? WHERE token_hash = ?',
    )
    .run(now.toISOString(), nextIdle, tokenHash);
  return {
    status: 'valid',
    account: mapAccount(row),
    idleExpiresAt: nextIdle,
    absoluteExpiresAt: String(row.absoluteExpiresAt),
  };
}

export function revokeRealSession(database: RewindDatabase, token: string, now = new Date()): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  database
    .prepare(
      'UPDATE real_account_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
    )
    .run(now.toISOString(), digest(token));
}

export function lookupRealAccount(database: RewindDatabase, username: string): RealAccount | null {
  const normalized = normalizeUsername(username);
  return normalized ? readAccount(database, normalized.normalized) : null;
}
