import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createMediaRuntime } from '../dist/media/runtime-store.js';
import { verifyStoredMedia } from '../dist/media/store.js';
import {
  requestUploadIntent,
  completeUploadIntent,
  cleanupUploadIntents,
} from '../dist/media/upload-intents.js';
import { runWorkerTick } from '../dist/jobs/worker.js';
import { s3Double } from './helpers/private-media-store.mjs';
import { withIntentFixture } from './helpers/upload-intents.mjs';

const at = new Date('2026-10-02T12:00:00Z');
const config = {
  backend: 's3',
  bucket: 'private-test-bucket',
  expectedBucketOwner: '123456789012',
  region: 'ap-southeast-1',
  environment: 'test',
};
const scope = { environment: 'test', groupId: 'demo-group' };
const bytes = Buffer.from('private-content');
const sha256 = createHash('sha256').update(bytes).digest('hex');
function input(extra = {}) {
  return {
    prefix: 'incoming',
    name: 'source',
    body: Readable.from([bytes]),
    sha256,
    byteLength: bytes.length,
    contentType: 'video/mp4',
    expiresAt: '2026-10-02T12:15:00Z',
    ...extra,
  };
}
function fakeSdk(double = s3Double()) {
  const calls = [];
  const signatures = [];
  let destroyed = 0;
  let listing = () => ({ Versions: [], IsTruncated: false });
  const commands = Object.fromEntries(
    ['PutObject', 'HeadObject', 'GetObject', 'DeleteObject', 'ListObjectVersions'].map(
      (operation) => [
        `${operation}Command`,
        class {
          constructor(input) {
            this.operation = operation;
            this.input = input;
          }
        },
      ],
    ),
  );
  const client = {
    async send(command) {
      calls.push(command);
      if (command.operation === 'ListObjectVersions') return listing(command.input);
      const method = command.operation[0].toLowerCase() + command.operation.slice(1);
      return double.transport[method](command.input);
    },
    destroy() {
      destroyed++;
    },
  };
  const sdk = {
    client,
    ...commands,
    async getSignedUrl(client, command, options) {
      assert.equal(client, sdk.client);
      signatures.push({ command, options });
      return 'https://storage.invalid/private-put?signature=offline';
    },
  };
  return {
    sdk,
    double,
    calls,
    signatures,
    setListing(fn) {
      listing = fn;
    },
    get destroyed() {
      return destroyed;
    },
  };
}
async function runtime(options = {}) {
  const fake = fakeSdk();
  return {
    ...fake,
    fake,
    runtime: await createMediaRuntime({ ...config, ...options }, { sdk: fake.sdk, now: () => at }),
  };
}
async function target(store, extra = {}) {
  const { versionId: _version, ...allocated } = await store.put(scope, input(extra));
  return allocated;
}

test('local runtime remains an independent private rollback adapter without SDK imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rewind-runtime-'));
  try {
    const fake = fakeSdk();
    const result = await createMediaRuntime(
      { backend: 'local', root, environment: 'test' },
      { sdk: fake.sdk, now: () => at },
    );
    const ref = await result.store.put(scope, input());
    await verifyStoredMedia(result.store, scope, ref, ref);
    await assert.rejects(result.store.put({ ...scope, environment: 'prod' }, input()), {
      code: 'scope_mismatch',
    });
    await assert.rejects(
      result.store.head({ ...scope, environment: 'prod' }, { ...ref, environment: 'prod' }),
      { code: 'scope_mismatch' },
    );
    assert.equal(result.uploadTransport, null);
    result.close();
    result.close();
    assert.equal(fake.calls.length, 0);
    assert.equal(fake.destroyed, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid runtime configuration rejects before client use', async () => {
  const fake = fakeSdk();
  for (const invalid of [
    { ...config, backend: 'public' },
    { ...config, environment: '../prod' },
    { ...config, bucket: 'invalid/bucket' },
    { ...config, expectedBucketOwner: '' },
    { ...config, region: '' },
    { ...config, kmsKeyId: 'alias/mutable' },
    { backend: 'local', environment: 'test', root: '/' },
    { backend: 'local', environment: 'test', root: 'relative' },
  ])
    await assert.rejects(createMediaRuntime(invalid, { sdk: fake.sdk }), {
      code: 'invalid_config',
    });
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.signatures.length, 0);
});

test('S3 construction is inert and injected client ownership is preserved', async () => {
  const result = await runtime();
  assert.equal(result.calls.length, 0);
  assert.equal(result.signatures.length, 0);
  result.runtime.close();
  result.runtime.close();
  assert.equal(result.fake.destroyed, 0);
});

test('runtime snapshots constructor config and rejects later scope mutation', async () => {
  const mutable = { ...config };
  const fake = fakeSdk();
  const result = await createMediaRuntime(mutable, { sdk: fake.sdk, now: () => at });
  const allocated = await target(result.store);
  mutable.bucket = 'other-bucket';
  mutable.environment = 'prod';
  mutable.expectedBucketOwner = '999999999999';
  await result.uploadTransport.signPut(scope, allocated);
  assert.equal(fake.signatures[0].command.input.Bucket, config.bucket);
  assert.equal(fake.signatures[0].command.input.ExpectedBucketOwner, config.expectedBucketOwner);
  await assert.rejects(
    result.uploadTransport.signPut(
      { ...scope, environment: 'prod' },
      { ...allocated, environment: 'prod', key: 'prod/demo-group/incoming/source' },
    ),
    { code: 'scope_mismatch' },
  );
});

test('SDK bridge streams verified bytes, pins every command and deletes only exact versions', async () => {
  const { runtime: result, calls, double } = await runtime();
  const ref = await result.store.put(scope, input());
  const replacement = await result.store.put(scope, input());
  await verifyStoredMedia(result.store, scope, ref, ref);
  await result.store.delete(scope, ref);
  await assert.rejects(result.store.head(scope, ref), { code: 'missing' });
  await verifyStoredMedia(result.store, scope, replacement, replacement);
  const puts = calls.filter((command) => command.operation === 'PutObject');
  assert.ok(puts.every((command) => command.input.Body instanceof Readable));
  assert.ok(puts.every((command) => command.input.Body.destroyed));
  for (const command of calls) {
    assert.equal(command.input.Bucket, config.bucket);
    assert.equal(command.input.ExpectedBucketOwner, config.expectedBucketOwner);
    assert.equal(command.input.ACL, undefined);
    if (command.operation !== 'PutObject') assert.ok(command.input.VersionId);
    if (['HeadObject', 'GetObject'].includes(command.operation))
      assert.equal(command.input.ChecksumMode, 'ENABLED');
  }
  assert.equal(double.versions.size, 1);
});

test('verified stream failure and premature transport success cannot publish a ref', async () => {
  const { runtime: result, double } = await runtime();
  await assert.rejects(result.store.put(scope, input({ sha256: '0'.repeat(64) })), {
    code: 'integrity_mismatch',
  });
  assert.equal(double.versions.size, 0);
  const fake = fakeSdk();
  fake.sdk.client.send = async () => ({ VersionId: 'fake-success' });
  const premature = await createMediaRuntime(config, { sdk: fake.sdk, now: () => at });
  await assert.rejects(premature.store.put(scope, input()), { code: 'storage_failed' });
});

test('malformed GET body and provider errors are safe and cannot bypass integrity', async () => {
  const { runtime: result, sdk } = await runtime();
  const ref = await result.store.put(scope, input());
  const original = sdk.client.send;
  sdk.client.send = async (command) =>
    command.operation === 'GetObject'
      ? { ...(await original(command)), Body: Buffer.from('not-an-async-body') }
      : original(command);
  await assert.rejects(verifyStoredMedia(result.store, scope, ref, ref), {
    code: 'storage_failed',
  });
  sdk.client.send = async () => {
    throw new Error('credentials/private endpoint detail');
  };
  await assert.rejects(
    result.store.head(scope, ref),
    (error) => error.code === 'storage_failed' && !error.message.includes('credentials'),
  );
  await assert.rejects(result.store.delete(scope, ref), { code: 'cleanup_failed' });
});

for (const kmsKeyId of [undefined, 'arn:aws:kms:ap-southeast-1:123456789012:key/1234-abcd']) {
  test(`PUT capability binds type, size, checksum, metadata, owner and ${kmsKeyId ? 'KMS' : 'AES256'}`, async () => {
    const {
      runtime: result,
      signatures,
      calls,
      double,
    } = await runtime({ ...(kmsKeyId ? { kmsKeyId } : {}) });
    const allocated = await target(result.store);
    const before = calls.length;
    const capability = await result.uploadTransport.signPut(scope, allocated);
    assert.equal(calls.length, before, 'signing must not send a storage request');
    const { command, options } = signatures[0];
    assert.equal(command.operation, 'PutObject');
    assert.equal(command.input.Key, allocated.key);
    assert.equal(command.input.Body, undefined);
    assert.equal(command.input.VersionId, undefined);
    assert.equal(command.input.ContentLength, allocated.byteLength);
    assert.equal(command.input.ContentType, allocated.contentType);
    assert.equal(command.input.ChecksumSHA256, Buffer.from(sha256, 'hex').toString('base64'));
    assert.equal(command.input.ExpectedBucketOwner, config.expectedBucketOwner);
    assert.equal(command.input.ServerSideEncryption, kmsKeyId ? 'aws:kms' : 'AES256');
    assert.equal(command.input.SSEKMSKeyId, kmsKeyId);
    assert.deepEqual(JSON.parse(command.input.Metadata['media-ref']), {
      ...allocated,
      versionId: 'pending',
    });
    assert.equal(command.input.ACL, undefined);
    assert.equal(options.expiresIn, 900);
    assert.equal(capability.expiresAt, new Date(allocated.expiresAt).toISOString());
    assert.equal(capability.method, 'PUT');
    assert.equal(capability.headers['content-length'], undefined);
    assert.ok(options.signableHeaders.has('content-length'));
    for (const name of Object.keys(capability.headers)) {
      assert.ok(options.signableHeaders.has(name));
      if (name.startsWith('x-amz-')) assert.ok(options.unhoistableHeaders.has(name));
    }
    // Exercise the signed wire contract through the same pinned store reader.
    const response = await double.transport.putObject({
      ...command.input,
      Body: Readable.from([bytes]),
    });
    await verifyStoredMedia(
      result.store,
      scope,
      { ...allocated, versionId: response.VersionId },
      { ...allocated, versionId: response.VersionId },
    );
  });
}

test('signing rejects scope, expiry, retained targets and unsafe URLs before exposing capability', async () => {
  const { runtime: result, signatures, sdk } = await runtime();
  const allocated = await target(result.store);
  for (const [actor, value, code] of [
    [{ ...scope, groupId: 'outsider' }, allocated, 'scope_mismatch'],
    [{ ...scope, environment: 'prod' }, allocated, 'scope_mismatch'],
    [scope, { ...allocated, expiresAt: at.toISOString() }, 'expired'],
    [
      scope,
      {
        ...allocated,
        prefix: 'processed',
        key: 'test/demo-group/processed/source',
        expiresAt: null,
      },
      'scope_mismatch',
    ],
    [scope, { ...allocated, storeId: 'other-bucket' }, 'scope_mismatch'],
  ])
    await assert.rejects(result.uploadTransport.signPut(actor, value), { code });
  assert.equal(signatures.length, 0);
  for (const unsafe of [
    'http://storage.invalid/put',
    'https://user:secret@storage.invalid/put',
    'https://storage.invalid/put#private',
  ]) {
    sdk.getSignedUrl = async () => unsafe;
    await assert.rejects(result.uploadTransport.signPut(scope, allocated), {
      code: 'storage_failed',
    });
  }
});

test('capability expiry rounds down and expired signing responses are discarded', async () => {
  let time = at;
  const fake = fakeSdk();
  const result = await createMediaRuntime(config, { sdk: fake.sdk, now: () => time });
  const allocated = await target(result.store, { expiresAt: '2026-10-02T12:00:03.900Z' });
  const capability = await result.uploadTransport.signPut(scope, allocated);
  assert.equal(capability.expiresAt, '2026-10-02T12:00:03.000Z');
  assert.equal(fake.signatures[0].options.expiresIn, 3);
  time = new Date('2026-10-02T12:00:03.100Z');
  await assert.rejects(result.uploadTransport.signPut(scope, allocated), { code: 'expired' });
  time = at;
  fake.sdk.getSignedUrl = async () => {
    time = new Date('2026-10-02T12:00:04Z');
    return 'https://storage.invalid/put';
  };
  await assert.rejects(result.uploadTransport.signPut(scope, allocated), { code: 'expired' });
});

test('exact-key version inventory is bounded, restartable, owner-bound and includes delete markers', async () => {
  const { runtime: result, fake, calls } = await runtime();
  const allocated = await target(result.store);
  fake.setListing((request) =>
    request.KeyMarker
      ? { Versions: [{ Key: allocated.key, VersionId: 'v3' }], IsTruncated: false }
      : {
          Versions: [{ Key: allocated.key, VersionId: 'v1' }],
          DeleteMarkers: [{ Key: allocated.key, VersionId: 'v2' }],
          IsTruncated: true,
          NextKeyMarker: allocated.key,
          NextVersionIdMarker: 'v2',
        },
  );
  const page1 = await result.uploadTransport.listVersions(scope, allocated, null, 2);
  assert.deepEqual(
    page1.refs.map((ref) => ref.versionId),
    ['v1', 'v2'],
  );
  const restarted = await createMediaRuntime(config, { sdk: fake.sdk, now: () => at });
  const page2 = await restarted.uploadTransport.listVersions(scope, allocated, page1.nextCursor, 2);
  assert.deepEqual(
    page2.refs.map((ref) => ref.versionId),
    ['v3'],
  );
  assert.equal(page2.nextCursor, null);
  for (const command of calls.filter((value) => value.operation === 'ListObjectVersions')) {
    assert.equal(command.input.Prefix, allocated.key);
    assert.equal(command.input.MaxKeys, 2);
    assert.equal(command.input.ExpectedBucketOwner, config.expectedBucketOwner);
  }
  assert.equal(calls.at(-1).input.KeyMarker, allocated.key);
  assert.equal(calls.at(-1).input.VersionIdMarker, 'v2');
});

test('inventory ignores prefix siblings and ends at a marker outside the exact key', async () => {
  const { runtime: result, fake } = await runtime();
  const allocated = await target(result.store);
  fake.setListing(() => ({
    Versions: [
      { Key: allocated.key, VersionId: 'v1' },
      { Key: allocated.key + '-neighbor', VersionId: 'private-other' },
    ],
    IsTruncated: true,
    NextKeyMarker: allocated.key + '-neighbor',
    NextVersionIdMarker: 'private-other',
  }));
  const page = await result.uploadTransport.listVersions(scope, allocated, null, 2);
  assert.deepEqual(
    page.refs.map((ref) => ref.versionId),
    ['v1'],
  );
  assert.equal(page.nextCursor, null);
});

test('foreign, malformed and looping version cursors fail closed without arbitrary listings', async () => {
  const { runtime: result, fake, calls } = await runtime();
  const allocated = await target(result.store);
  fake.setListing(() => ({
    IsTruncated: true,
    NextKeyMarker: allocated.key,
    NextVersionIdMarker: 'v1',
  }));
  const page = await result.uploadTransport.listVersions(scope, allocated, null, 1);
  const before = calls.length;
  for (const cursor of [
    'not-json',
    'x'.repeat(9000),
    Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString()),
        keyMarker: 'prod/outsider/incoming/secret',
      }),
    ).toString('base64url'),
  ])
    await assert.rejects(result.uploadTransport.listVersions(scope, allocated, cursor, 1), {
      code: 'invalid_ref',
    });
  assert.equal(calls.length, before);
  await assert.rejects(result.uploadTransport.listVersions(scope, allocated, page.nextCursor, 1), {
    code: 'storage_failed',
  });
  for (const limit of [0, 101, 1.5])
    await assert.rejects(result.uploadTransport.listVersions(scope, allocated, null, limit), {
      code: 'invalid_ref',
    });
});

test('invalid version inventory cannot authorize an unversioned or oversized cleanup', async () => {
  const { runtime: result, fake } = await runtime();
  const allocated = await target(result.store);
  for (const page of [
    { Versions: [{ Key: allocated.key, VersionId: 'null' }] },
    { Versions: [{ Key: allocated.key, VersionId: 'pending' }] },
    {
      Versions: [
        { Key: allocated.key, VersionId: 'v1' },
        { Key: allocated.key, VersionId: 'v1' },
      ],
    },
    { Versions: 'not-array' },
    { IsTruncated: true },
  ]) {
    fake.setListing(() => page);
    await assert.rejects(result.uploadTransport.listVersions(scope, allocated, null, 2));
  }
  fake.setListing(() => ({
    Versions: [
      { Key: allocated.key, VersionId: 'v1' },
      { Key: allocated.key, VersionId: 'v2' },
    ],
  }));
  await assert.rejects(result.uploadTransport.listVersions(scope, allocated, null, 1), {
    code: 'storage_failed',
  });
});

test('runtime bridge drives real-account intent completion, worker output and bounded expired cleanup offline', async () =>
  withIntentFixture(async (c) => {
    const fake = fakeSdk();
    const result = await createMediaRuntime(config, { sdk: fake.sdk, now: () => c.now });
    const deps = { ...c.deps, store: result.store, transport: result.uploadTransport };
    const request = await requestUploadIntent(
      c.database,
      c.actor,
      c.input('runtime-real-intent'),
      deps,
    );
    assert.equal(request.ok, true, JSON.stringify(request));
    const command = fake.signatures[0].command;
    const first = await fake.double.transport.putObject({
      ...command.input,
      Body: Readable.from([c.bytes]),
    });
    const abandoned = await fake.double.transport.putObject({
      ...command.input,
      Body: Readable.from([c.bytes]),
    });
    c.reopen();
    const completion = await completeUploadIntent(
      c.database,
      c.actor,
      { intentId: request.value.intent.id, versionId: first.VersionId },
      deps,
    );
    assert.equal(completion.ok, true, JSON.stringify(completion));
    const tick = await runWorkerTick(c.database, {
      ffmpegBin: 'ffmpeg',
      stagingDir: c.root + '/staging',
      outputDir: c.root + '/processed',
      mediaStore: result.store,
      mediaEnvironment: 'test',
      groupId: c.actor.groupId,
    });
    assert.equal(tick.record.status, 'ready');
    assert.equal(fake.double.versions.has(`${command.input.Key}:${first.VersionId}`), false);
    assert.equal(fake.double.versions.has(`${command.input.Key}:${abandoned.VersionId}`), true);
    fake.setListing((request) => ({
      Versions: [...fake.double.versions.values()]
        .filter((value) => JSON.parse(value.Metadata['media-ref']).key === request.Prefix)
        .map((value) => ({ Key: request.Prefix, VersionId: value.VersionId })),
      IsTruncated: false,
    }));
    c.now = new Date('2026-10-02T12:16:00Z');
    const cleanup = await cleanupUploadIntents(c.database, deps, { limit: 1, versionLimit: 2 });
    assert.equal(cleanup.failed, 0);
    assert.equal(cleanup.deleted, 1);
    assert.equal(fake.double.versions.has(`${command.input.Key}:${abandoned.VersionId}`), false);
    assert.equal(
      fake.double.versions.size,
      1,
      'retained processed output survives incoming expiry',
    );
    assert.equal(
      c.database
        .prepare('SELECT state FROM upload_intents WHERE id = ?')
        .get(request.value.intent.id).state,
      'completed',
    );
  }));
