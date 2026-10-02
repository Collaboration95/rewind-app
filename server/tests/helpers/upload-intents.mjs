import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { parseConfig } from '../../dist/config.js';
import { openDatabase, openDatabaseAt } from '../../dist/db.js';
import { createRealGroup } from '../../dist/groups/real.js';
import { PrivateS3MediaStore } from '../../dist/media/s3-store.js';
import { s3Double } from './private-media-store.mjs';

/** Disposable SQL proposal fixture; canonical migration 026 remains lead-owned. */
export const INTENT_SCHEMA_SQL = `
CREATE TABLE upload_intents (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES real_group_metadata(group_id),
  account_id TEXT NOT NULL REFERENCES real_accounts(id),
  profile_id TEXT NOT NULL REFERENCES real_profiles(id),
  cycle_id TEXT NOT NULL REFERENCES cycles(id),
  quota_window_start_at TEXT NOT NULL,
  idempotency_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  target_json TEXT NOT NULL,
  reserved_seconds REAL NOT NULL CHECK (reserved_seconds > 0 AND reserved_seconds <= 15),
  state TEXT NOT NULL CHECK (state IN ('open','pinned','completed','expired')),
  pinned_ref TEXT,
  contribution_id TEXT UNIQUE REFERENCES contributions(id),
  job_id TEXT UNIQUE REFERENCES media_jobs(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cleanup_cursor TEXT,
  cleanup_complete INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_complete IN (0,1)),
  UNIQUE (environment, group_id, profile_id, idempotency_hash),
  CHECK ((state = 'open' AND pinned_ref IS NULL)
      OR state = 'expired'
      OR (state IN ('pinned','completed') AND pinned_ref IS NOT NULL)),
  CHECK ((state = 'completed' AND contribution_id IS NOT NULL AND job_id IS NOT NULL)
      OR (state <> 'completed' AND contribution_id IS NULL AND job_id IS NULL))
);
CREATE INDEX upload_intents_expiry_idx ON upload_intents(environment, cleanup_complete, expires_at, id);
CREATE INDEX upload_intents_quota_idx ON upload_intents(cycle_id, profile_id, quota_window_start_at, state, expires_at);
`;

export function accountFixture(database, id, now) {
  const token = randomBytes(32).toString('base64url');
  database
    .prepare(
      `INSERT INTO real_accounts (id,username,normalized_username,display_name,password_salt,password_hash,password_scrypt_n,password_scrypt_r,password_scrypt_p,created_at,updated_at) VALUES (?,?,?,?,?,?,16384,8,1,?,?)`,
    )
    .run(
      id,
      id,
      id,
      id,
      id + '-salt',
      'not-a-login-password',
      now.toISOString(),
      now.toISOString(),
    );
  database
    .prepare(
      `INSERT INTO real_account_sessions (token_hash,account_id,created_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES (?,?,?,?,?,?)`,
    )
    .run(
      createHash('sha256').update(token).digest('hex'),
      id,
      now.toISOString(),
      now.toISOString(),
      new Date(now.getTime() + 12 * 3600000).toISOString(),
      new Date(now.getTime() + 30 * 86400000).toISOString(),
    );
  return token;
}
export async function withIntentFixture(run) {
  const root = await mkdtemp('/private/tmp/rewind-upload-intents-');
  const config = parseConfig({ REWIND_DATA_DIR: root });
  const now = new Date('2026-10-02T12:00:00Z');
  const database = openDatabase(config);
  database.exec(INTENT_SCHEMA_SQL);
  const token = accountFixture(database, 'intent-owner', now);
  const otherToken = accountFixture(database, 'intent-outsider', now);
  const group = createRealGroup(
    database,
    { id: 'intent-owner', displayName: 'Owner' },
    { name: 'Intent group', prompt: 'Hello', maxMembers: 5 },
    now,
  );
  const groupId = group.group.id;
  const actor = { sessionToken: token, groupId };
  const double = s3Double();
  const capabilities = new Map();
  const context = { root, database, config, now, actor, otherToken, group, double, capabilities };
  const store = new PrivateS3MediaStore(double.transport, {
    bucket: 'private-intent-bucket',
    environment: 'test',
    expectedBucketOwner: '123456789012',
    now: () => context.now,
  });
  const transport = {
    backend: 's3',
    storeId: 'private-intent-bucket',
    async signPut(scope, target) {
      const url = `https://storage.invalid/${target.key}?opaque=${randomBytes(16).toString('hex')}`;
      capabilities.set(url, { scope, target });
      return {
        method: 'PUT',
        url,
        headers: { 'content-type': target.contentType },
        expiresAt: target.expiresAt,
      };
    },
    async listVersions(_scope, target, cursor, limit) {
      const refs = [];
      for (const [identity, value] of double.versions) {
        if (!identity.startsWith(target.key + ':')) continue;
        if (cursor !== null && Number(value.VersionId) <= Number(cursor)) continue;
        refs.push({ ...JSON.parse(value.Metadata['media-ref']), versionId: value.VersionId });
      }
      refs.sort((a, b) => Number(a.versionId) - Number(b.versionId));
      const page = refs.slice(0, limit);
      return { refs: page, nextCursor: refs.length > limit ? page.at(-1).versionId : null };
    },
  };
  context.deps = {
    environment: 'test',
    store,
    transport,
    scratchDir: root + '/scratch',
    ffmpegBin: 'ffmpeg',
    now: () => context.now,
  };
  context.bytes = await readFile(new URL('../../fixtures/demo-media.mp4', import.meta.url));
  context.input = (key) => ({
    idempotencyKey: key,
    mediaType: 'video',
    contentType: 'video/mp4',
    byteLength: context.bytes.length,
    sha256: createHash('sha256').update(context.bytes).digest('hex'),
    durationSeconds: 0.5,
    trimStartSeconds: 0,
    trimEndSeconds: 0.5,
  });
  context.put = async (capability, bytes = context.bytes) => {
    const allocation = capabilities.get(capability.url);
    if (Date.parse(allocation.target.expiresAt) <= context.now.getTime())
      throw new Error('expired capability');
    const { target } = allocation;
    const result = await double.transport.putObject({
      Bucket: transport.storeId,
      Key: target.key,
      ExpectedBucketOwner: '123456789012',
      Body: Readable.from([bytes]),
      ContentLength: bytes.length,
      ContentType: target.contentType,
      ChecksumSHA256: Buffer.from(createHash('sha256').update(bytes).digest('hex'), 'hex').toString(
        'base64',
      ),
      Metadata: { 'media-ref': JSON.stringify({ ...target, versionId: 'pending' }) },
      ServerSideEncryption: 'AES256',
    });
    return result.VersionId;
  };
  context.reopen = () => {
    context.database.close();
    context.database = openDatabaseAt(config.databasePath);
  };
  try {
    await run(context);
  } finally {
    context.database.close();
    await rm(root, { recursive: true, force: true });
  }
}
