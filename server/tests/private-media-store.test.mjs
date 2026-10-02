import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import test from 'node:test';
import { LocalMediaStore } from '../dist/media/local-store.js';
import { s3Double, s3Store } from './helpers/private-media-store.mjs';
import { decodeMediaRef, encodeMediaRef, verifyStoredMedia } from '../dist/media/store.js';
import { materializeStoredMedia } from '../dist/media/store-files.js';
import { cleanupExpiredStoredMedia } from '../dist/jobs/retention.js';
import { openDatabase } from '../dist/db.js';
import { parseConfig } from '../dist/config.js';
const scope = { environment: 'test', groupId: 'demo-group' };
const now = new Date('2026-10-02T12:00:00Z');
const bytes = Buffer.from('private-content');
const digest = createHash('sha256').update(bytes).digest('hex');
function input(extra = {}) {
  return {
    prefix: 'incoming',
    name: 'source',
    body: Readable.from([bytes]),
    sha256: digest,
    byteLength: bytes.length,
    contentType: 'video/mp4',
    expiresAt: '2026-10-03T12:00:00Z',
    ...extra,
  };
}
async function temporary(run) {
  const root = await mkdtemp('/private/tmp/rewind-media-store-');
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
for (const backend of ['local', 's3']) {
  test(`${backend}: pinned versions, authorization scope, expiry, integrity and exact cleanup`, async () =>
    temporary(async (root) => {
      const double = s3Double();
      const store = backend === 'local' ? new LocalMediaStore(root, () => now) : s3Store(double);
      const ref = await store.put(scope, input());
      assert.deepEqual(decodeMediaRef(encodeMediaRef(ref)), ref);
      await verifyStoredMedia(store, scope, ref, ref);
      const replacement = Buffer.from('replacement-data');
      const other = await store.put(
        scope,
        input({
          body: Readable.from([replacement]),
          byteLength: replacement.length,
          sha256: createHash('sha256').update(replacement).digest('hex'),
        }),
      );
      assert.notEqual(other.versionId, ref.versionId);
      await verifyStoredMedia(store, scope, ref, ref);
      await assert.rejects(store.head({ ...scope, groupId: 'outsider' }, ref), {
        code: 'scope_mismatch',
      });
      await assert.rejects(store.head({ ...scope, environment: 'prod' }, ref), {
        code: 'scope_mismatch',
      });
      await assert.rejects(store.head(scope, { ...ref, versionId: 'null' }), {
        code: 'invalid_ref',
      });
      await assert.rejects(store.head(scope, { ...ref, expiresAt: '2026-10-01T00:00:00Z' }), {
        code: 'expired',
      });
      await assert.rejects(
        verifyStoredMedia(store, scope, ref, { ...ref, sha256: '0'.repeat(64) }),
        { code: 'integrity_mismatch' },
      );
      if (backend === 'local')
        await writeFile(`${root}/${ref.key}/${ref.versionId}`, Buffer.alloc(bytes.length));
      else double.versions.get(`${ref.key}:${ref.versionId}`).bytes = Buffer.alloc(bytes.length);
      await assert.rejects(verifyStoredMedia(store, scope, ref, ref), {
        code: 'integrity_mismatch',
      });
      await assert.rejects(materializeStoredMedia(store, scope, ref, root + '/scratch'), {
        code: 'integrity_mismatch',
      });
      await store.delete(scope, ref);
      await store.delete(scope, ref);
      await assert.rejects(store.head(scope, ref), { code: 'missing' });
      await verifyStoredMedia(store, scope, other, other);
      const retained = await store.put(scope, input({ prefix: 'processed', expiresAt: null }));
      await store.head(scope, retained);
      await assert.rejects(store.put(scope, input({ prefix: 'films' })), { code: 'invalid_ref' });
      await assert.rejects(store.put(scope, input({ sha256: '0'.repeat(64) })), {
        code: 'integrity_mismatch',
      });
      if (backend === 's3') {
        for (const [operation, request] of double.calls) {
          assert.equal(request.ExpectedBucketOwner, '123456789012');
          if (operation === 'put') {
            assert.equal(request.ACL, undefined);
            assert.equal(request.ServerSideEncryption, 'AES256');
            assert.equal(request.CacheControl, 'private, no-store');
          } else assert.ok(request.VersionId && request.VersionId !== 'null');
        }
      }
    }));
}

test('S3 refuses unversioned writes, forged HEAD identity, encryption mismatch and unsafe transport errors', async () => {
  const double = s3Double();
  const store = s3Store(double);
  const ref = await store.put(scope, input());
  const stored = double.versions.get(`${ref.key}:${ref.versionId}`);
  stored.ServerSideEncryption = undefined;
  await assert.rejects(store.head(scope, ref), { code: 'integrity_mismatch' });
  stored.ServerSideEncryption = 'AES256';
  stored.VersionId = 'another-version';
  await assert.rejects(store.head(scope, ref), { code: 'integrity_mismatch' });
  double.transport.putObject = async () => ({ VersionId: 'null' });
  await assert.rejects(store.put(scope, input()), { code: 'invalid_ref' });
  double.transport.getObject = async () => {
    throw new Error('credential-or-private-url');
  };
  await assert.rejects(
    verifyStoredMedia(store, scope, { ...ref }, ref),
    (error) => !error.message.includes('credential'),
  );
});

test('local rejects parent symlink escapes', async () =>
  temporary(async (root) => {
    await mkdir(root + '/outside');
    await mkdir(root + '/store');
    await symlink(root + '/outside', root + '/store/test');
    const store = new LocalMediaStore(root + '/store', () => now);
    await assert.rejects(store.put(scope, input()), { code: 'scope_mismatch' });
  }));

test('bounded expiry cleanup protects retained output and referenced input, reports failed deletions', async () =>
  temporary(async (root) => {
    const db = openDatabase(parseConfig({ REWIND_DATA_DIR: root }));
    const double = s3Double();
    const store = s3Store(double);
    try {
      const ref = await store.put(scope, input());
      const retained = await store.put(scope, input({ prefix: 'films', expiresAt: null }));
      const future = new Date('2026-10-04T00:00:00Z');
      db.prepare(
        'UPDATE media_jobs SET source_path = ? WHERE id = (SELECT id FROM media_jobs LIMIT 1)',
      ).run(encodeMediaRef(ref));
      // Seed databases need not include media jobs; a durable staged binding also protects input.
      db.prepare(
        "INSERT INTO staged_sources (source_id,source_uri,idempotency_key_hash,group_id,member_id,source_path,status,created_at) VALUES ('cleanup-source','staged://cleanup-source','cleanup','demo-group','demo-1',?,'staged',?)",
      ).run(encodeMediaRef(ref), now.toISOString());
      assert.deepEqual(
        await cleanupExpiredStoredMedia(db, store, scope, [retained, ref], { now: future }),
        { deleted: 0, protected: 2, failed: 0 },
      );
      db.prepare("DELETE FROM staged_sources WHERE source_id = 'cleanup-source'").run();
      db.prepare('UPDATE media_jobs SET source_path = NULL WHERE source_path = ?').run(
        encodeMediaRef(ref),
      );
      double.transport.deleteObject = async () => {
        throw new Error('private-details');
      };
      assert.deepEqual(await cleanupExpiredStoredMedia(db, store, scope, [ref], { now: future }), {
        deleted: 0,
        protected: 0,
        failed: 1,
      });
      double.transport.deleteObject = async (request) =>
        double.versions.delete(`${request.Key}:${request.VersionId}`);
      assert.deepEqual(
        await cleanupExpiredStoredMedia(db, store, scope, [ref, retained], {
          now: future,
          limit: 1,
        }),
        { deleted: 1, protected: 0, failed: 0 },
      );
      await store.head(scope, retained);
    } finally {
      db.close();
    }
  }));

test('S3 KMS policy and metadata verification are mandatory; failed HEAD cleans exact PUT version', async () => {
  const double = s3Double();
  const kmsKeyId = 'arn:aws:kms:ap-southeast-1:123456789012:key/test';
  const store = s3Store(double, { kmsKeyId });
  const ref = await store.put(scope, input());
  await verifyStoredMedia(store, scope, ref, ref);
  const put = double.transport.putObject;
  double.transport.putObject = async (request) => {
    const result = await put(request);
    double.versions.get(`${request.Key}:${result.VersionId}`).Metadata = {};
    return result;
  };
  await assert.rejects(store.put(scope, input()), { code: 'integrity_mismatch' });
  assert.equal(double.versions.size, 1);
  double.transport.putObject = async () => {
    throw new Error('private URL or credential');
  };
  await assert.rejects(store.put(scope, input()), {
    code: 'storage_failed',
    message: 'storage_failed',
  });
  assert.equal(encodeMediaRef(ref), encodeMediaRef({ expiresAt: ref.expiresAt, ...ref }));
});
