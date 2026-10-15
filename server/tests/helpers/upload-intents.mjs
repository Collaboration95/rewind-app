import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { parseConfig } from '../../dist/config.js';
import { openDatabaseAt } from '../../dist/db.js';
import { createRealGroup } from '../../dist/groups/real.js';
import { PrivateS3MediaStore } from '../../dist/media/s3-store.js';
import { s3Double } from './private-media-store.mjs';
import { openFixtureDatabase } from './fixture-group.mjs';

/** Tests share the canonical migration; no duplicate schema contract. */
export const INTENT_SCHEMA_SQL = readFileSync(
  new URL('../../migrations/026-upload-intents.sql', import.meta.url),
  'utf8',
);

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
  const root = await mkdtemp(`${tmpdir()}/rewind-upload-intents-`);
  const config = parseConfig({ REWIND_DATA_DIR: root });
  const now = new Date('2026-10-02T12:00:00Z');
  const database = openFixtureDatabase(config);
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
  context.bytes = await readFile(new URL('../../fixtures/sample-clip.mp4', import.meta.url));
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
