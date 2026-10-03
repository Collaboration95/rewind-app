import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, X509Certificate } from 'node:crypto';
import { connect } from 'node:tls';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createRuntimeServer } from '../dist/http.js';
import { createRealAccount } from '../dist/auth/index.js';
import { createRealGroup } from '../dist/groups/real.js';
import { parseConfig } from '../dist/config.js';
import { openDatabase, openDatabaseAt } from '../dist/db.js';
import { createMediaRuntime } from '../dist/media/runtime-store.js';
import { decodeMediaRef } from '../dist/media/store.js';
import { cleanupUploadIntents } from '../dist/media/upload-intents.js';
import { s3ProtocolFixture } from './helpers/s3-protocol-fixture.mjs';

async function scenario(run) {
  const root = await mkdtemp(tmpdir() + '/rewind-intent-protocol-');
  const config = parseConfig({ REWIND_DATA_DIR: root });
  const c = { now: new Date(), database: openDatabase(config) };
  let storage, server, runtime;
  try {
    storage = await s3ProtocolFixture(root, () => c.now);
    runtime = await createMediaRuntime(storage.config, { sdk: storage.sdk, now: () => c.now });
    const deps = {
      store: runtime.store,
      transport: runtime.uploadTransport,
      environment: 'test',
      scratchDir: root + '/scratch',
      ffmpegBin: 'ffmpeg',
      now: () => c.now,
    };
    const proxy = {
      Origin: 'https://protocol.example',
      'x-rewind-origin-auth': 'local-proxy-secret',
      'x-forwarded-proto': 'https',
    };
    async function start() {
      server = createRuntimeServer(
        {
          ...config,
          host: '127.0.0.1',
          port: 0,
          allowOrigin: proxy.Origin,
          originAuthSecret: proxy['x-rewind-origin-auth'],
        },
        c.database,
        {
          now: () => c.now,
          mediaStore: runtime.store,
          mediaEnvironment: 'test',
          uploadIntents: deps,
        },
      );
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      c.base = 'http://127.0.0.1:' + server.address().port;
    }
    async function stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      server = undefined;
    }
    await start();
    async function account(username) {
      const created = await createRealAccount(
        c.database,
        username,
        username,
        'local protocol test password',
        c.now,
      );
      assert.equal(created.ok, true);
      const response = await fetch(c.base + '/auth/login', {
        method: 'POST',
        headers: { ...proxy, 'content-type': 'application/json' },
        body: JSON.stringify({
          username,
          password: 'local protocol test password',
          clientType: 'native',
        }),
      });
      assert.equal(response.status, 200);
      return { account: created.account, token: (await response.json()).token };
    }
    c.owner = await account('protocol-owner');
    c.outsider = await account('protocol-outsider');
    c.group = createRealGroup(
      c.database,
      c.owner.account,
      { name: 'Protocol group', prompt: 'Private media', maxMembers: 3 },
      c.now,
    );
    c.bytes = await readFile(new URL('../fixtures/demo-media.mp4', import.meta.url));
    c.input = (key) => ({
      idempotencyKey: key,
      mediaType: 'video',
      contentType: 'video/mp4',
      byteLength: c.bytes.length,
      sha256: createHash('sha256').update(c.bytes).digest('hex'),
      durationSeconds: 0.5,
      trimStartSeconds: 0,
      trimEndSeconds: 0.5,
    });
    c.request = (suffix = '', method = 'GET', body, person = c.owner) =>
      fetch(c.base + `/real/groups/${c.group.group.id}/upload-intents` + suffix, {
        method,
        headers: {
          ...proxy,
          Authorization: 'Bearer ' + person.token,
          'content-type': 'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    c.restart = async () => {
      await stop();
      c.database.close();
      c.database = openDatabaseAt(config.databasePath);
      await start();
    };
    c.process = (jobId, person = c.owner) =>
      fetch(c.base + `/contributions/jobs/${jobId}/process?groupId=${c.group.group.id}`, {
        method: 'POST',
        headers: { ...proxy, Authorization: 'Bearer ' + person.token },
      });
    c.clipStatus = (jobId, person = c.owner) =>
      fetch(c.base + `/clips/${jobId}?groupId=${c.group.group.id}`, {
        headers: { ...proxy, Authorization: 'Bearer ' + person.token },
      });
    c.overwrite = async (upload) => {
      const metadata = JSON.parse(upload.headers['x-amz-meta-media-ref']);
      const bytes = Buffer.concat([c.bytes, Buffer.from('independent overwrite bytes')]);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const result = await storage.client.send(
        new PutObjectCommand({
          Bucket: storage.config.bucket,
          Key: metadata.key,
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: metadata.contentType,
          Metadata: {
            'media-ref': JSON.stringify({ ...metadata, byteLength: bytes.length, sha256 }),
          },
          ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
          ExpectedBucketOwner: storage.config.expectedBucketOwner,
          ServerSideEncryption: 'AES256',
          CacheControl: 'private, no-store',
        }),
      );
      return result.VersionId;
    };
    await run({ ...c, deps, storage, runtime, context: c });
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    runtime?.close();
    if (storage) await storage.close();
    c.database.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function requested(c, key) {
  const response = await c.request('', 'POST', c.input(key));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
}

// This exercises the actual SDK command serialization, presigner, signer,
// network handler, XML decoder and body streams. No S3 method doubles.
test('signed SDK HTTP: immutable versions survive overwrite around HEAD, API/DB restart, concurrent completion and private processing', async () =>
  scenario(async (c) => {
    const first = await requested(c, 'wire-pinned');
    assert.equal((await requested(c, 'wire-pinned')).intent.id, first.intent.id);
    assert.equal((await c.request('', 'POST', c.input('outsider'), c.outsider)).status, 403);
    assert.equal(
      (await c.request('', 'POST', c.input('invalid'), { token: 'invalid-session' })).status,
      401,
    );
    const before = c.storage.versions.size;
    const callsBeforeRejectedUrls = c.storage.calls.length;
    for (const invalid of [
      new URL('/foreign', 'https://foreign.invalid').href,
      first.upload.url.replace('https:', 'http:'),
      first.upload.url.replace('https://', 'https://injected:credentials@'),
    ]) {
      await assert.rejects(c.storage.put({ ...first.upload, url: invalid }, c.bytes), {
        code: 'ERR_ASSERTION',
      });
    }
    assert.equal(c.storage.calls.length, callsBeforeRejectedUrls);
    const certificate = new X509Certificate(c.storage.certificate);
    assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');
    assert.equal(certificate.checkHost('localhost'), 'localhost');
    const handshake = (options) =>
      new Promise((resolve, reject) => {
        const socket = connect({
          host: '127.0.0.1',
          port: c.storage.port,
          rejectUnauthorized: true,
          ...options,
        });
        socket.once('secureConnect', () => {
          const authorized = socket.authorized;
          socket.destroy();
          resolve(authorized);
        });
        socket.once('error', (error) => {
          socket.destroy();
          reject(error);
        });
      });
    await assert.rejects(handshake({}), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    await assert.rejects(handshake({ ca: c.storage.certificate, servername: 'wrong.invalid' }), {
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });

    assert.equal(
      (
        await c.storage.put(
          { ...first.upload, headers: { ...first.upload.headers, 'content-type': 'image/png' } },
          c.bytes,
        )
      ).status,
      403,
    );
    assert.equal((await c.storage.put(first.upload, Buffer.from('wrong bytes'))).status, 403);
    assert.equal(c.storage.versions.size, before);
    const receipt = await c.storage.put(first.upload, c.bytes);
    assert.equal(receipt.status, 200);
    assert.equal(receipt.tlsAuthorized, true);
    const key = JSON.parse(first.upload.headers['x-amz-meta-media-ref']).key;
    const pinned = c.storage.versions.get(key + ':' + receipt.version);
    assert.deepEqual(pinned.bytes, c.bytes);
    const beforeHead = await c.overwrite(first.upload);
    assert.notDeepEqual(c.storage.versions.get(key + ':' + beforeHead).bytes, pinned.bytes);
    let afterHead;
    c.storage.afterNextHead(async () => {
      afterHead = await c.overwrite(first.upload);
    });
    const completePath = '/' + first.intent.id + '/complete';
    const completions = await Promise.all([
      c.request(completePath, 'POST', { versionId: receipt.version }),
      c.request(completePath, 'POST', { versionId: receipt.version }),
    ]);
    assert.deepEqual(completions.map((r) => r.status).sort(), [200, 429]);
    const accepted = completions.find((r) => r.status === 200);
    const retry = await c.request(completePath, 'POST', { versionId: receipt.version });
    assert.equal(retry.status, 200);
    const results = await Promise.all([accepted.json(), retry.json()]);
    assert.equal(results[0].intent.jobId, results[1].intent.jobId);
    assert.ok(afterHead);
    assert.ok(
      c.storage.calls.some(
        (call) => call.method === 'GET' && call.key === key && call.version === receipt.version,
      ),
    );
    assert.deepEqual(pinned.bytes, c.bytes);
    assert.equal((await c.request(completePath, 'POST', { versionId: beforeHead })).status, 409);
    await c.restart();
    const db = c.context.database;
    const replay = await c.request(completePath, 'POST', { versionId: receipt.version });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).intent.jobId, results[0].intent.jobId);
    const intent = results[0].intent;
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM contributions WHERE id=?').get(intent.contributionId).n,
      1,
    );
    assert.equal(
      db
        .prepare('SELECT count_used AS n FROM contribution_quota_windows WHERE member_id=?')
        .get(intent.profileId).n,
      1,
    );
    assert.equal((await c.process(intent.jobId, c.outsider)).status, 403);
    assert.equal((await c.process(intent.jobId)).status, 200);
    const job = db
      .prepare('SELECT status,source_path,output_path FROM media_jobs WHERE id=?')
      .get(intent.jobId);
    assert.equal(job.status, 'ready');
    const visible = await c.clipStatus(intent.jobId);
    assert.equal(visible.status, 200);
    assert.deepEqual(await visible.json(), { clip: { id: intent.jobId, status: 'ready' } });
    assert.equal((await c.clipStatus(intent.jobId, c.outsider)).status, 403);
    assert.equal(job.source_path, null);
    const output = decodeMediaRef(job.output_path);
    assert.equal(output.prefix, 'processed');
    assert.equal(output.expiresAt, null);
    const storedOutput = c.storage.versions.get(output.key + ':' + output.versionId);
    assert.equal(createHash('sha256').update(storedOutput.bytes).digest('hex'), output.sha256);
    assert.equal(storedOutput.headers['cache-control'], 'private, no-store');
    assert.equal(c.storage.versions.has(key + ':' + receipt.version), false);
    assert.ok(c.storage.versions.has(key + ':' + beforeHead));
    assert.ok(
      c.storage.calls.some(
        (call) => call.method === 'DELETE' && call.key === key && call.version === receipt.version,
      ),
    );
    c.context.now = new Date(c.context.now.getTime() + 16 * 60000);
    let deleted = 0;
    for (let i = 0; i < 3; i++) {
      const report = await cleanupUploadIntents(db, c.deps, { limit: 1, versionLimit: 1 });
      assert.equal(report.failed, 0);
      assert.ok(report.deleted <= 1);
      deleted += report.deleted;
    }
    assert.equal(deleted, 2);
    assert.ok(c.storage.versions.has(output.key + ':' + output.versionId));
    assert.equal([...c.storage.versions.values()].filter((v) => v.key === key).length, 0);
    const status = await (await c.request('/' + first.intent.id)).json();
    assert.doesNotMatch(JSON.stringify(status), /media-object:|X-Amz-Signature|local-proxy-secret/);
  }));

test('signed SDK HTTP: lost receipt reconciliation, authoritative quota, missing identity and expired abandoned cleanup', async () =>
  scenario(async (c) => {
    c.context.database.prepare('UPDATE cycles SET max_count=1 WHERE id=?').run(c.group.cycle.id);
    const first = await requested(c, 'wire-lost-receipt');
    assert.equal((await c.request('', 'POST', c.input('reserved-quota'))).status, 409);
    const receipt = await c.storage.put(first.upload, c.bytes);
    assert.equal(receipt.status, 200); // Client intentionally does not submit this receipt.
    assert.equal(
      (await c.request('/' + first.intent.id + '/complete', 'POST', { versionId: 'null' })).status,
      400,
    );
    const missing = await c.request('/' + first.intent.id + '/complete', 'POST', {
      versionId: 'absent-version',
    });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, 'upload_intent_source_unavailable');
    assert.equal(
      c.context.database
        .prepare('SELECT count(*) AS n FROM contributions WHERE cycle_id=?')
        .get(c.group.cycle.id).n,
      0,
    );
    // Missing identity is CAS-pinned and fails closed; use a separate owned intent
    // for recovery rather than pretending a failed pin can switch versions.
    c.context.now = new Date(c.context.now.getTime() + 16 * 60000);
    const expired = await cleanupUploadIntents(c.context.database, c.deps, {
      limit: 1,
      versionLimit: 1,
    });
    assert.equal(expired.failed, 0);
    assert.equal(expired.deleted, 1);
    assert.equal((await c.storage.put(first.upload, c.bytes)).status, 403);
    const recovered = await requested(c, 'wire-recovery');
    const lost = await c.storage.put(recovered.upload, c.bytes);
    assert.equal(lost.status, 200);
    await c.restart();
    const path = '/' + recovered.intent.id + '/reconcile';
    const response = await c.request(path, 'POST', {});
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.intent.versionId, lost.version);
    assert.equal((await c.request(path, 'POST', {})).status, 200);
    assert.equal((await c.request('', 'POST', c.input('completed-quota'))).status, 409);
    const db = c.context.database;
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM contributions WHERE cycle_id=?').get(c.group.cycle.id)
        .n,
      1,
    );
    assert.equal(
      db
        .prepare('SELECT count_used AS n FROM contribution_quota_windows WHERE member_id=?')
        .get(result.intent.profileId).n,
      1,
    );
    assert.ok(
      c.storage.calls.some(
        (call) => call.method === 'GET' && call.key === '' && call.version === null,
      ),
    );
  }));

test('signed SDK HTTP: completion rechecks actual quota and closed cycle without registering or spending twice', async () =>
  scenario(async (c) => {
    for (const input of [
      { ...c.input('bad-type'), contentType: 'application/octet-stream' },
      { ...c.input('bad-size'), byteLength: 50 * 1024 * 1024 + 1 },
    ])
      assert.equal((await c.request('', 'POST', input)).status, 400);
    const first = await requested(c, 'wire-recheck');
    const receipt = await c.storage.put(first.upload, c.bytes);
    assert.equal(receipt.status, 200);
    const db = c.context.database;
    db.prepare('UPDATE contribution_quota_windows SET count_used=max_count WHERE member_id=?').run(
      first.intent.profileId,
    );
    const complete = '/' + first.intent.id + '/complete';
    const quota = await c.request(complete, 'POST', { versionId: receipt.version });
    assert.equal(quota.status, 409);
    assert.equal((await quota.json()).error, 'upload_intent_quota_exceeded');
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM contributions WHERE cycle_id=?').get(c.group.cycle.id)
        .n,
      0,
    );
    db.prepare('UPDATE contribution_quota_windows SET count_used=0 WHERE member_id=?').run(
      first.intent.profileId,
    );
    db.prepare("UPDATE cycles SET status='revealing' WHERE id=?").run(c.group.cycle.id);
    assert.equal((await c.request(complete, 'POST', { versionId: receipt.version })).status, 409);
    assert.equal((await c.request('', 'POST', c.input('closed-cycle'))).status, 409);
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM contributions WHERE cycle_id=?').get(c.group.cycle.id)
        .n,
      0,
    );
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM media_jobs WHERE group_id=?').get(c.group.group.id).n,
      0,
    );
    db.prepare("UPDATE cycles SET status='collecting' WHERE id=?").run(c.group.cycle.id);
    await c.restart();
    const retry = await c.request(complete, 'POST', { versionId: receipt.version });
    assert.equal(retry.status, 200);
    const accepted = (await retry.json()).intent;
    assert.equal(
      c.context.database
        .prepare('SELECT count_used AS n FROM contribution_quota_windows WHERE member_id=?')
        .get(accepted.profileId).n,
      1,
    );
  }));
