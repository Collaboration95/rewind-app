import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import test from 'node:test';
import {
  cleanupUploadIntents,
  completeUploadIntent,
  getUploadIntentStatus,
  reconcileUploadIntent,
  requestUploadIntent,
  UPLOAD_INTENT_RECONCILE_VERSION_LIMIT,
} from '../dist/media/upload-intents.js';
import { decodeMediaRef } from '../dist/media/store.js';
import { runWorkerTick } from '../dist/jobs/worker.js';
import { withIntentFixture } from './helpers/upload-intents.mjs';
// Identity is cached; out-of-band SQL changes below clear it, as the server's
// own revocation, selection and membership changes do.
import { forgetAllIdentities } from '../dist/auth/identity-cache.js';
import { createTestTrigger, dropTestTrigger } from './helpers/dialect.mjs';

function reconciled(c, intent) {
  return reconcileUploadIntent(c.database, c.actor, { intentId: intent.id }, c.deps);
}

function noRegistration(c, intent) {
  assert.equal(
    c.database.prepare('SELECT state,pinned_ref FROM upload_intents WHERE id=?').get(intent.id)
      .state,
    'open',
  );
  assert.equal(
    c.database.prepare('SELECT pinned_ref FROM upload_intents WHERE id=?').get(intent.id)
      .pinned_ref,
    null,
  );
  assert.equal(
    c.database
      .prepare('SELECT count(*) AS n FROM contributions WHERE cycle_id=?')
      .get(intent.cycleId).n,
    0,
  );
  assert.equal(
    c.database
      .prepare('SELECT count_used FROM contribution_quota_windows WHERE member_id=?')
      .get(intent.profileId).count_used,
    0,
  );
}

test('lost PUT reconciliation verifies one immutable version, survives reopen and registers/processes exactly once', async () =>
  withIntentFixture(async (c) => {
    const request = await requested(c, 'reconcile-lost-put');
    const version = await c.put(request.upload);
    const list = c.deps.transport.listVersions;
    let lists = 0;
    c.deps.transport.listVersions = async (...args) => {
      lists++;
      assert.equal(args[1].key, `test/${c.actor.groupId}/incoming/${request.intent.id}`);
      assert.equal(args[2], null);
      assert.equal(args[3], UPLOAD_INTENT_RECONCILE_VERSION_LIMIT);
      return list(...args);
    };
    c.reopen();
    const [first, second] = await Promise.all([
      reconciled(c, request.intent),
      reconciled(c, request.intent),
    ]);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual(second, first);
    assert.equal(first.value.versionId, version);
    assert.equal(
      c.database
        .prepare('SELECT count_used FROM contribution_quota_windows WHERE member_id=?')
        .get(request.intent.profileId).count_used,
      1,
    );
    assert.equal(c.double.calls.filter(([kind]) => kind === 'put').length, 1);
    const tick = await runWorkerTick(c.database, {
      ffmpegBin: 'ffmpeg',
      stagingDir: c.root + '/staging',
      outputDir: c.root + '/processed',
      mediaStore: c.deps.store,
      mediaEnvironment: 'test',
      groupId: c.actor.groupId,
    });
    assert.equal(tick.record.status, 'ready');
    const count = lists;
    c.now = new Date(c.now.getTime() + 16 * 60000);
    assert.deepEqual(await reconciled(c, request.intent), first);
    assert.equal(lists, count); // receipt replay never inventories disposed source
  }));

for (const kind of [
  'empty',
  'two_matching',
  'foreign',
  'adjacent_key',
  'wrong_store',
  'pending',
  'duplicate',
  'truncated',
  'oversize_page',
  'malformed_page',
  'malformed_ref',
  'metadata_changed',
  'provider_error',
]) {
  test(`reconciliation rejects ${kind} inventory without guessing or pinning`, async () =>
    withIntentFixture(async (c) => {
      const request = await requested(c, 'reconcile-inventory');
      await c.put(request.upload);
      if (kind === 'two_matching') await c.put(request.upload);
      const list = c.deps.transport.listVersions;
      let lists = 0;
      c.deps.transport.listVersions = async (...args) => {
        lists++;
        const page = await list(...args);
        const ref = page.refs[0];
        switch (kind) {
          case 'empty':
            return { refs: [], nextCursor: null };
          case 'foreign':
            return {
              refs: [{ ...ref, groupId: 'foreign', key: 'test/foreign/incoming/object' }],
              nextCursor: null,
            };
          case 'adjacent_key':
            return { refs: [{ ...ref, key: ref.key + '-adjacent' }], nextCursor: null };
          case 'wrong_store':
            return { refs: [{ ...ref, storeId: 'other-private-bucket' }], nextCursor: null };
          case 'pending':
            return { refs: [{ ...ref, versionId: 'pending' }], nextCursor: null };
          case 'duplicate':
            return { refs: [ref, ref], nextCursor: null };
          case 'truncated':
            return { ...page, nextCursor: 'another-page' };
          case 'oversize_page':
            return {
              refs: Array.from(
                { length: UPLOAD_INTENT_RECONCILE_VERSION_LIMIT + 1 },
                (_, index) => ({ ...ref, versionId: String(index + 1) }),
              ),
              nextCursor: null,
            };
          case 'malformed_page':
            return { refs: null, nextCursor: null };
          case 'malformed_ref':
            return { refs: [{ ...ref, sha256: 'not-a-checksum' }], nextCursor: null };
          case 'metadata_changed':
            return { refs: [{ ...ref, byteLength: ref.byteLength + 1 }], nextCursor: null };
          case 'provider_error':
            throw new Error('private provider details');
          default:
            return page;
        }
      };
      const result = await reconciled(c, request.intent);
      assert.equal(result.ok, false);
      assert.equal(lists, 1);
      if (kind === 'two_matching') assert.equal(result.reason, 'version_conflict');
      else
        assert.equal(
          c.double.calls.some(([kind]) => kind === 'get'),
          false,
        );
      assert.equal(JSON.stringify(result).includes('private provider'), false);
      noRegistration(c, request.intent);
    }));
}

test('reconciliation ignores conclusively nonmatching bytes and selects the only verified version, not latest', async () =>
  withIntentFixture(async (c) => {
    const request = await requested(c, 'reconcile-exact-bytes');
    const good = await c.put(request.upload);
    const bad = Buffer.from(c.bytes);
    bad[0] ^= 255;
    await c.put(request.upload, bad); // latest HEAD/checksum does not match
    const result = await reconciled(c, request.intent);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value.versionId, good);
    assert.equal(c.double.calls.filter(([kind]) => kind === 'put').length, 2);
  }));

test('reconciliation hashes actual GET bytes even when HEAD advertises the requested checksum', async () =>
  withIntentFixture(async (c) => {
    const request = await requested(c, 'reconcile-corrupt-get');
    await c.put(request.upload);
    [...c.double.versions.values()][0].bytes[0] ^= 255;
    assert.deepEqual(await reconciled(c, request.intent), {
      ok: false,
      reason: 'source_unavailable',
    });
    noRegistration(c, request.intent);
  }));

for (const kind of [
  'session',
  'selection',
  'membership',
  'expiry',
  'closure',
  'rollover',
  'quota',
  'cleanup',
]) {
  test(`reconciliation fences ${kind} changing during asynchronous inventory/read`, async () =>
    withIntentFixture(async (c) => {
      const request = await requested(c, 'reconcile-race');
      await c.put(request.upload);
      const mutate = () => {
        switch (kind) {
          case 'session':
            c.database
              .prepare('DELETE FROM real_account_sessions WHERE account_id=?')
              .run('intent-owner');
            forgetAllIdentities(c.database);
            break;
          case 'selection':
            c.database
              .prepare('DELETE FROM real_account_group_selections WHERE account_id=?')
              .run('intent-owner');
            forgetAllIdentities(c.database);
            break;
          case 'membership':
            c.database
              .prepare('DELETE FROM real_group_memberships WHERE account_id=?')
              .run('intent-owner');
            forgetAllIdentities(c.database);
            break;
          case 'expiry':
          case 'cleanup':
            c.now = new Date(c.now.getTime() + 16 * 60000);
            break;
          case 'closure':
            c.database
              .prepare("UPDATE cycles SET status='revealing' WHERE id=?")
              .run(c.group.cycle.id);
            break;
          case 'rollover':
            c.database
              .prepare(
                `INSERT INTO cycles (id,group_id,prompt,starts_at,ends_at,status,lock_state,max_count,max_seconds,count_used,seconds_used,previous_cycle_id)
              SELECT 'reconcile-successor',group_id,prompt,starts_at,ends_at,'collecting',lock_state,max_count,max_seconds,0,0,id FROM cycles WHERE id=?`,
              )
              .run(request.intent.cycleId);
            c.database
              .prepare("UPDATE groups SET current_cycle_id='reconcile-successor' WHERE id=?")
              .run(c.actor.groupId);
            break;
          case 'quota':
            c.database
              .prepare(
                'UPDATE contribution_quota_windows SET count_used=max_count WHERE member_id=?',
              )
              .run(request.intent.profileId);
            break;
        }
      };
      const read = c.deps.store.read.bind(c.deps.store);
      c.deps.store.read = async function* (...args) {
        for await (const bytes of read(...args)) {
          yield bytes;
          mutate();
          if (kind === 'cleanup') await cleanupUploadIntents(c.database, c.deps);
        }
      };
      const result = await reconciled(c, request.intent);
      assert.equal(result.ok, false, kind);
      assert.equal(
        c.database
          .prepare('SELECT count(*) AS n FROM contributions WHERE cycle_id=?')
          .get(request.intent.cycleId).n,
        0,
      );
      const row = c.database
        .prepare('SELECT state,pinned_ref FROM upload_intents WHERE id=?')
        .get(request.intent.id);
      if (kind === 'quota') {
        assert.equal(result.reason, 'quota_exceeded');
        assert.equal(row.state, 'pinned');
        assert.equal(decodeMediaRef(row.pinned_ref).versionId, '1');
      } else assert.equal(row.pinned_ref, null);
    }));
}

test('an independently CAS-pinned version wins during reconciliation; replay never substitutes discovered identity', async () =>
  withIntentFixture(async (c) => {
    const request = await requested(c, 'reconcile-cas-race');
    await c.put(request.upload);
    const list = c.deps.transport.listVersions;
    c.deps.transport.listVersions = async (...args) => {
      const page = await list(...args);
      const winning = await c.put(request.upload);
      const result = await completed(c, request.intent, winning);
      assert.equal(result.ok, true);
      return page;
    };
    const result = await reconciled(c, request.intent);
    assert.equal(result.ok, true);
    assert.equal(result.value.versionId, '2');
    assert.equal(
      c.database
        .prepare('SELECT count_used FROM contribution_quota_windows WHERE member_id=?')
        .get(request.intent.profileId).count_used,
      1,
    );
  }));

test('pinned retry uses the existing verifier/quota transaction without inventing an inventory winner', async () =>
  withIntentFixture(async (c) => {
    const request = await requested(c, 'reconcile-pinned-retry');
    const version = await c.put(request.upload);
    c.deps.probe = async () => {
      throw new Error('interrupted verification');
    };
    assert.equal((await completed(c, request.intent, version)).ok, false);
    delete c.deps.probe;
    c.deps.transport.listVersions = async () => {
      throw new Error('must not inventory pinned source');
    };
    const result = await reconciled(c, request.intent);
    assert.equal(result.ok, true);
    assert.equal(result.value.versionId, version);
  }));

async function requested(context, key = 'intent-upload-1', extra = {}) {
  const result = await requestUploadIntent(
    context.database,
    context.actor,
    { ...context.input(key), ...extra },
    context.deps,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
async function completed(context, intent, version) {
  return completeUploadIntent(
    context.database,
    context.actor,
    { intentId: intent.id, versionId: version },
    context.deps,
  );
}
function scalar(db, sql) {
  return Object.values(db.prepare(sql).get())[0];
}

test('real request→PUT→complete→processed survives restart and preserves private immutable identity', async () =>
  withIntentFixture(async (c) => {
    const before = scalar(c.database, 'SELECT COUNT(*) FROM contributions');
    const request = await requested(c);
    assert.equal(request.intent.cycleId, c.group.cycle.id);
    assert.notEqual(request.intent.profileId, 'intent-owner');
    assert.equal(scalar(c.database, 'SELECT COUNT(*) FROM contributions'), before);
    const version = await c.put(request.upload);
    c.reopen();
    const result = await completed(c, request.intent, version);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value.state, 'completed');
    const row = c.database
      .prepare(
        'SELECT source_path AS path, source_generation AS generation FROM media_jobs WHERE id = ?',
      )
      .get(result.value.jobId);
    assert.equal(row.generation, 1);
    assert.equal(decodeMediaRef(row.path).versionId, version);
    const tick = await runWorkerTick(c.database, {
      ffmpegBin: 'ffmpeg',
      stagingDir: c.root + '/staging',
      outputDir: c.root + '/processed',
      mediaStore: c.deps.store,
      mediaEnvironment: 'test',
      groupId: c.actor.groupId,
    });
    assert.equal(tick.record.status, 'ready');
    assert.equal((await completed(c, request.intent, version)).ok, true);
    assert.equal(scalar(c.database, 'SELECT COUNT(*) FROM contributions'), before + 1);
    assert.deepEqual(await readdir(c.deps.scratchDir), []);
    const persisted = JSON.stringify(c.database.prepare('SELECT * FROM upload_intents').all());
    assert.ok(!persisted.includes(c.actor.sessionToken));
    assert.ok(!persisted.includes(request.upload.url));
    assert.ok(
      !JSON.stringify(
        getUploadIntentStatus(c.database, c.actor, request.intent.id, c.deps),
      ).includes('media-object:'),
    );
  }));

test('client-processed retro uploads store a no-reapply mode; legacy and native modes still register', async () =>
  withIntentFixture(async (c) => {
    const invalid = await requestUploadIntent(
      c.database,
      c.actor,
      { ...c.input('intent-retro-invalid'), mode: 'vhs', clientProcessed: 'yes' },
      c.deps,
    );
    assert.deepEqual(invalid, { ok: false, reason: 'invalid_request' });
    const modes = [];
    for (const [key, extra] of [
      ['intent-retro-client', { mode: 'vhs', clientProcessed: true }],
      ['intent-retro-native', { mode: 'disposable-flash' }],
      ['intent-retro-legacy', { mode: 'soft-focus' }],
    ]) {
      const request = await requested(c, key, extra);
      const version = await c.put(request.upload);
      const result = await completed(c, request.intent, version);
      assert.equal(result.ok, true, JSON.stringify(result));
      modes.push(
        c.database.prepare('SELECT mode FROM media_jobs WHERE id = ?').get(result.value.jobId).mode,
      );
    }
    assert.deepEqual(modes, ['client:vhs', 'disposable-flash', 'soft-focus']);
  }));

test('idempotency is scoped, rejects payload changes, survives reopen and never spends allowance twice', async () =>
  withIntentFixture(async (c) => {
    const first = await requested(c);
    c.reopen();
    const same = await requested(c);
    assert.equal(first.intent.id, same.intent.id);
    assert.deepEqual(
      await requestUploadIntent(
        c.database,
        c.actor,
        { ...c.input('intent-upload-1'), durationSeconds: 1, trimEndSeconds: 1 },
        c.deps,
      ),
      { ok: false, reason: 'idempotency_conflict' },
    );
    const version = await c.put(same.upload);
    const results = await Promise.all([
      completed(c, same.intent, version),
      completed(c, same.intent, version),
    ]);
    assert.ok(results.every((result) => result.ok));
    assert.equal(results[0].value.jobId, results[1].value.jobId);
    assert.equal(
      c.database
        .prepare(
          'SELECT count_used AS count, seconds_used AS seconds FROM contribution_quota_windows WHERE member_id = ?',
        )
        .get(first.intent.profileId).count,
      1,
    );
  }));

for (const kind of [
  'missing_session',
  'outsider',
  'demo',
  'closed_cycle',
  'invalid_size',
  'invalid_type',
  'invalid_sha',
  'invalid_trim',
]) {
  test(`request denies ${kind} before signing`, async () =>
    withIntentFixture(async (c) => {
      let actor = c.actor;
      let input = c.input('intent-upload-1');
      if (kind === 'missing_session') actor = { ...actor, sessionToken: 'invalid' };
      if (kind === 'outsider') actor = { ...actor, sessionToken: c.otherToken };
      if (kind === 'demo') actor = { ...actor, groupId: 'demo-group' };
      if (kind === 'closed_cycle')
        c.database
          .prepare("UPDATE cycles SET status = 'revealing' WHERE id = ?")
          .run(c.group.cycle.id);
      if (kind === 'invalid_size') input.byteLength = 50 * 1024 * 1024 + 1;
      if (kind === 'invalid_type') input.contentType = 'application/octet-stream';
      if (kind === 'invalid_sha') input.sha256 = '';
      if (kind === 'invalid_trim') input.trimEndSeconds = 16;
      assert.equal((await requestUploadIntent(c.database, actor, input, c.deps)).ok, false);
      assert.equal(c.capabilities.size, 0);
    }));
}

test('pending intent quota is atomic at request; completion rechecks ledger and expiry releases holds', async () =>
  withIntentFixture(async (c) => {
    const intents = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        requestUploadIntent(c.database, c.actor, c.input(`quota-intent-${i}`), c.deps),
      ),
    );
    assert.equal(intents.filter((result) => result.ok).length, 5);
    assert.equal(intents.at(-1).reason, 'quota_exceeded');
    const first = intents[0].value;
    const version = await c.put(first.upload);
    c.database.prepare('UPDATE contribution_quota_windows SET count_used = 5').run();
    assert.deepEqual(await completed(c, first.intent, version), {
      ok: false,
      reason: 'quota_exceeded',
    });
    c.database.prepare('UPDATE contribution_quota_windows SET count_used = 0').run();
    c.now = new Date(c.now.getTime() + 16 * 60000);
    const request = await requested(c, 'quota-after-expiry');
    assert.notEqual(request.intent.id, first.intent.id);
  }));

test('first completion version is CAS-pinned; before/after HEAD overwrite and lost PUT response cannot replace it', async () =>
  withIntentFixture(async (c) => {
    const request = await requested(c);
    const first = await c.put(request.upload);
    const second = await c.put(request.upload); // replay after a lost PUT response
    const head = c.double.transport.headObject;
    let overwritten = false;
    c.double.transport.headObject = async (input) => {
      const result = await head(input);
      if (!overwritten) {
        overwritten = true;
        await c.put(request.upload);
      }
      return result;
    };
    const [accepted, conflicting] = await Promise.all([
      completed(c, request.intent, first),
      completed(c, request.intent, second),
    ]);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.deepEqual(conflicting, { ok: false, reason: 'version_conflict' });
    assert.equal(
      decodeMediaRef(c.database.prepare('SELECT pinned_ref FROM upload_intents').get().pinned_ref)
        .versionId,
      first,
    );
    assert.deepEqual(await completed(c, request.intent, second), {
      ok: false,
      reason: 'version_conflict',
    });
  }));

for (const kind of [
  'missing_identity',
  'missing_object',
  'wrong_size',
  'checksum_mismatch',
  'revocation',
  'rollover',
  'expired',
]) {
  test(`completion ${kind} fails closed without contribution/quota mutation`, async () =>
    withIntentFixture(async (c) => {
      const request = await requested(c);
      const version = await c.put(request.upload);
      const before = scalar(c.database, 'SELECT COUNT(*) FROM contributions');
      if (kind === 'missing_identity') {
        assert.deepEqual(await completed(c, request.intent, 'null'), {
          ok: false,
          reason: 'invalid_request',
        });
        return;
      }
      if (kind === 'missing_object') c.double.versions.clear();
      if (kind === 'wrong_size') c.double.versions.values().next().value.ContentLength++;
      if (kind === 'checksum_mismatch') c.double.versions.values().next().value.bytes.fill(0);
      const probe = c.deps.probe;
      if (['revocation', 'rollover', 'expired'].includes(kind))
        c.deps.probe = async (path, mediaType) => {
          const { probeClipWithFfmpeg } = await import('../dist/ffmpeg.js');
          const result = await probeClipWithFfmpeg('ffmpeg', path);
          if (kind === 'revocation') {
            c.database
              .prepare('UPDATE real_account_sessions SET revoked_at = ?')
              .run(c.now.toISOString());
            forgetAllIdentities(c.database);
          }
          if (kind === 'rollover')
            c.database
              .prepare('UPDATE groups SET current_cycle_id = NULL WHERE id = ?')
              .run(c.actor.groupId);
          if (kind === 'expired') c.now = new Date(c.now.getTime() + 16 * 60000);
          return { ...result, mediaType };
        };
      assert.equal((await completed(c, request.intent, version)).ok, false);
      c.deps.probe = probe;
      assert.equal(scalar(c.database, 'SELECT COUNT(*) FROM contributions'), before);
      assert.equal(
        c.database
          .prepare('SELECT count_used AS count FROM contribution_quota_windows WHERE member_id = ?')
          .get(request.intent.profileId).count,
        0,
      );
    }));
}

test('wrong owner and environment status/completion disclose no intent or storage capability', async () =>
  withIntentFixture(async (c) => {
    const request = await requested(c);
    assert.deepEqual(
      getUploadIntentStatus(
        c.database,
        { ...c.actor, sessionToken: c.otherToken },
        request.intent.id,
        c.deps,
      ),
      { ok: false, reason: 'forbidden' },
    );
    assert.deepEqual(
      getUploadIntentStatus(c.database, c.actor, request.intent.id, {
        ...c.deps,
        environment: 'prod',
      }),
      { ok: false, reason: 'not_found' },
    );
    assert.equal(
      (
        await completeUploadIntent(
          c.database,
          { ...c.actor, sessionToken: c.otherToken },
          { intentId: request.intent.id, versionId: '1' },
          c.deps,
        )
      ).ok,
      false,
    );
  }));

test('bounded cleanup expires uncompleted and noncurrent versions, preserves accepted source and reports failed deletion', async () =>
  withIntentFixture(async (c) => {
    const request = await requested(c);
    const acceptedVersion = await c.put(request.upload);
    await c.put(request.upload);
    await c.put(request.upload);
    assert.equal((await completed(c, request.intent, acceptedVersion)).ok, true);
    const unused = await requested(c, 'intent-unused');
    await c.put(unused.upload);
    c.now = new Date(c.now.getTime() + 16 * 60000);
    const first = await cleanupUploadIntents(c.database, c.deps, { limit: 1, versionLimit: 1 });
    assert.ok(first.deleted + first.protected <= 1);
    const remove = c.double.transport.deleteObject;
    c.double.transport.deleteObject = async () => {
      throw new Error('private-signature-details');
    };
    const failed = await cleanupUploadIntents(c.database, c.deps);
    assert.ok(failed.failed > 0);
    c.double.transport.deleteObject = remove;
    const success = await cleanupUploadIntents(c.database, c.deps);
    assert.ok(success.deleted > 0);
    assert.equal(c.double.versions.size, 1);
    assert.equal(
      getUploadIntentStatus(c.database, c.actor, unused.intent.id, c.deps).value.state,
      'expired',
    );
    assert.equal((await completed(c, unused.intent, '4')).reason, 'expired');
  }));

test('invalid actual media and forged photo duration never bypass server verification or quota', async () =>
  withIntentFixture(async (c) => {
    const bytes = Buffer.from('not an actual photo');
    const request = await requested(c, 'intent-bad-photo', {
      mediaType: 'photo',
      contentType: 'image/jpeg',
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      durationSeconds: 0.01,
    });
    assert.equal(
      c.database.prepare('SELECT reserved_seconds FROM upload_intents').get().reserved_seconds,
      3,
    );
    const version = await c.put(request.upload, bytes);
    assert.deepEqual(await completed(c, request.intent, version), {
      ok: false,
      reason: 'invalid_media',
    });
  }));

test('two database handles complete the same pinned version exactly once', async () =>
  withIntentFixture(async (c) => {
    const request = await requested(c);
    const version = await c.put(request.upload);
    const { openDatabaseAt } = await import('../dist/db.js');
    const second = openDatabaseAt(c.config.databasePath);
    try {
      const results = await Promise.all([
        completed(c, request.intent, version),
        completeUploadIntent(
          second,
          c.actor,
          { intentId: request.intent.id, versionId: version },
          c.deps,
        ),
      ]);
      assert.ok(
        results.every((result) => result.ok),
        JSON.stringify(results),
      );
      assert.equal(results[0].value.jobId, results[1].value.jobId);
      assert.equal(
        c.database
          .prepare('SELECT COUNT(*) AS count FROM contributions WHERE cycle_id = ?')
          .get(request.intent.cycleId).count,
        1,
      );
    } finally {
      second.close();
    }
  }));

test('pinned identity survives failed verification and reopen, returns safe status for lost completion response', async () =>
  withIntentFixture(async (c) => {
    const request = await requested(c);
    const version = await c.put(request.upload);
    const get = c.double.transport.getObject;
    c.double.transport.getObject = async () => {
      throw new Error('https://private.invalid?secret');
    };
    assert.deepEqual(await completed(c, request.intent, version), {
      ok: false,
      reason: 'source_unavailable',
    });
    c.reopen();
    const safe = getUploadIntentStatus(c.database, c.actor, request.intent.id, c.deps);
    assert.equal(safe.value.state, 'pinned');
    assert.equal(safe.value.versionId, version);
    c.double.transport.getObject = get;
    assert.equal((await completed(c, request.intent, safe.value.versionId)).ok, true);
  }));

test('successor collecting cycle does not absorb an old pinned intent', async () =>
  withIntentFixture(async (c) => {
    const request = await requested(c);
    const version = await c.put(request.upload);
    c.deps.probe = async (path) => {
      const { probeClipWithFfmpeg } = await import('../dist/ffmpeg.js');
      const result = await probeClipWithFfmpeg('ffmpeg', path);
      c.database
        .prepare(
          `INSERT INTO cycles (id,group_id,prompt,starts_at,ends_at,status,lock_state,max_count,max_seconds,count_used,seconds_used,previous_cycle_id)
      SELECT 'intent-successor',group_id,prompt,starts_at,ends_at,'collecting',lock_state,max_count,max_seconds,0,0,id FROM cycles WHERE id = ?`,
        )
        .run(request.intent.cycleId);
      c.database
        .prepare("UPDATE cycles SET status = 'revealing' WHERE id = ?")
        .run(request.intent.cycleId);
      c.database
        .prepare("UPDATE groups SET current_cycle_id = 'intent-successor' WHERE id = ?")
        .run(c.actor.groupId);
      return { ...result, mediaType: 'video' };
    };
    assert.deepEqual(await completed(c, request.intent, version), {
      ok: false,
      reason: 'closed_cycle',
    });
    assert.equal(
      c.database
        .prepare('SELECT COUNT(*) AS count FROM contributions WHERE cycle_id = ?')
        .get(request.intent.cycleId).count,
      0,
    );
    assert.equal(
      c.database
        .prepare("SELECT COUNT(*) AS count FROM contributions WHERE cycle_id = 'intent-successor'")
        .get().count,
      0,
    );
  }));

test('registration failure rolls back quota, staged metadata and jobs; retry registers once', async () =>
  withIntentFixture(async (c) => {
    const request = await requested(c);
    const version = await c.put(request.upload);
    createTestTrigger(c.database, {
      name: 'fail_intent_job',
      timing: 'BEFORE',
      event: 'INSERT',
      table: 'media_jobs',
      action: { abort: 'private internal diagnostic' },
    });
    const stagedBefore = scalar(c.database, 'SELECT COUNT(*) FROM staged_sources');
    assert.deepEqual(await completed(c, request.intent, version), {
      ok: false,
      reason: 'storage_failed',
    });
    assert.equal(scalar(c.database, 'SELECT COUNT(*) FROM staged_sources'), stagedBefore);
    assert.equal(
      c.database
        .prepare('SELECT count_used AS count FROM contribution_quota_windows WHERE member_id = ?')
        .get(request.intent.profileId).count,
      0,
    );
    assert.equal(
      getUploadIntentStatus(c.database, c.actor, request.intent.id, c.deps).value.state,
      'pinned',
    );
    dropTestTrigger(c.database, 'fail_intent_job', 'media_jobs');
    assert.equal((await completed(c, request.intent, version)).ok, true);
  }));

test('actual photo uses three seconds in pending hold, committed quota and private worker', async () =>
  withIntentFixture(async (c) => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { readFile } = await import('node:fs/promises');
    const path = c.root + '/photo.jpg';
    await promisify(execFile)('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      new URL('../fixtures/sample-clip.mp4', import.meta.url).pathname,
      '-frames:v',
      '1',
      path,
    ]);
    const bytes = await readFile(path);
    const request = await requested(c, 'intent-real-photo', {
      mediaType: 'photo',
      contentType: 'image/jpeg',
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      durationSeconds: 0,
    });
    const version = await c.put(request.upload, bytes);
    const result = await completed(c, request.intent, version);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(
      c.database
        .prepare(
          'SELECT seconds_used AS seconds FROM contribution_quota_windows WHERE member_id = ?',
        )
        .get(request.intent.profileId).seconds,
      3,
    );
    const tick = await runWorkerTick(c.database, {
      ffmpegBin: 'ffmpeg',
      stagingDir: c.root + '/staging',
      outputDir: c.root + '/processed',
      mediaStore: c.deps.store,
      mediaEnvironment: 'test',
      groupId: c.actor.groupId,
    });
    assert.equal(tick.record.status, 'ready');
  }));

test('expiry cleanup refuses foreign inventory and preserves pinned source even with changed metadata fields', async () =>
  withIntentFixture(async (c) => {
    const request = await requested(c);
    const version = await c.put(request.upload);
    assert.equal((await completed(c, request.intent, version)).ok, true);
    c.now = new Date(c.now.getTime() + 16 * 60000);
    const list = c.deps.transport.listVersions;
    c.deps.transport.listVersions = async (...args) => {
      const page = await list(...args);
      return { ...page, refs: page.refs.map((ref) => ({ ...ref, sha256: '0'.repeat(64) })) };
    };
    const protectedResult = await cleanupUploadIntents(c.database, c.deps);
    assert.equal(protectedResult.protected, 1);
    assert.equal(c.double.versions.size, 1);
    c.database.prepare('UPDATE upload_intents SET cleanup_complete = 0').run();
    c.deps.transport.listVersions = async (...args) => {
      const page = await list(...args);
      return {
        ...page,
        refs: page.refs.map((ref) => ({
          ...ref,
          groupId: 'foreign',
          key: 'test/foreign/incoming/foreign-object',
        })),
      };
    };
    const rejected = await cleanupUploadIntents(c.database, c.deps);
    assert.equal(rejected.failed, 1);
    assert.equal(c.double.versions.size, 1);
  }));

test('schema proposal is additive to existing media and enforces idempotency/completion shape', async () =>
  withIntentFixture(async (c) => {
    const request = await requested(c);
    assert.throws(
      () =>
        c.database
          .prepare("UPDATE upload_intents SET state = 'completed' WHERE id = ?")
          .run(request.intent.id),
      /CHECK constraint/,
    );
    const row = c.database
      .prepare('SELECT * FROM upload_intents WHERE id = ?')
      .get(request.intent.id);
    const columns = Object.keys(row);
    assert.throws(
      () =>
        c.database
          .prepare(
            `INSERT INTO upload_intents (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          )
          .run(...columns.map((key) => (key === 'id' ? 'different-id' : row[key]))),
      /UNIQUE constraint/,
    );
    assert.equal(c.database.prepare('SELECT COUNT(*) AS count FROM media_jobs').get().count, 3); // existing Demo records are intact
    assert.equal(c.database.prepare('PRAGMA foreign_key_check').all().length, 0);
  }));

test('quota seconds, weekly expiry, and replacement conflicts remain authoritative', async () =>
  withIntentFixture(async (c) => {
    await requested(c, 'seconds-intent-first', { durationSeconds: 15, trimEndSeconds: 15 });
    await requested(c, 'seconds-intent-second', { durationSeconds: 15, trimEndSeconds: 15 });
    assert.deepEqual(
      await requestUploadIntent(c.database, c.actor, c.input('seconds-intent-third'), c.deps),
      { ok: false, reason: 'quota_exceeded' },
    );
    c.now = new Date(c.now.getTime() + 16 * 60000);
    const request = await requested(c, 'bad-replacement-intent', {
      replacesContributionId: 'unknown-contribution',
    });
    const version = await c.put(request.upload);
    assert.deepEqual(await completed(c, request.intent, version), {
      ok: false,
      reason: 'replacement_conflict',
    });
    assert.equal(
      c.database
        .prepare('SELECT count_used AS count FROM contribution_quota_windows WHERE member_id = ?')
        .get(request.intent.profileId).count,
      0,
    );
    // A capability near a week boundary never crosses into the new quota window.
    c.now = new Date('2026-10-09T11:59:00Z');
    c.database
      .prepare('UPDATE real_account_sessions SET idle_expires_at = ?')
      .run('2026-10-10T12:00:00Z');
    const bounded = await requested(c, 'week-boundary-intent');
    assert.equal(bounded.intent.expiresAt, '2026-10-09T12:00:00.000Z');
  }));

test('idempotency keys are hashed only; pinned requests return identity without new PUT capability', async () =>
  withIntentFixture(async (c) => {
    const request = await requested(c, c.actor.sessionToken);
    const version = await c.put(request.upload);
    c.deps.probe = async () => {
      throw new Error('simulated verifier interruption');
    };
    assert.equal((await completed(c, request.intent, version)).ok, false);
    const repeat = await requested(c, c.actor.sessionToken);
    assert.equal(repeat.upload, null);
    assert.equal(repeat.intent.versionId, version);
    assert.ok(
      !JSON.stringify(c.database.prepare('SELECT * FROM upload_intents').all()).includes(
        c.actor.sessionToken,
      ),
    );
  }));

test('local filesystem store supports the same request/immutable-completion contract without S3', async () =>
  withIntentFixture(async (c) => {
    const { LocalMediaStore } = await import('../dist/media/local-store.js');
    const { Readable } = await import('node:stream');
    const local = new LocalMediaStore(c.root + '/local-store', () => c.now);
    c.deps.store = local;
    c.deps.transport.backend = 'local';
    c.deps.transport.storeId = local.storeId;
    const request = await requested(c, 'physical-local-intent');
    const allocation = c.capabilities.get(request.upload.url);
    const ref = await local.put(allocation.scope, {
      prefix: 'incoming',
      name: allocation.target.key.split('/').at(-1),
      body: Readable.from([c.bytes]),
      sha256: allocation.target.sha256,
      byteLength: c.bytes.length,
      contentType: 'video/mp4',
      expiresAt: allocation.target.expiresAt,
    });
    const result = await completed(c, request.intent, ref.versionId);
    assert.equal(result.ok, true, JSON.stringify(result));
    const tick = await runWorkerTick(c.database, {
      ffmpegBin: 'ffmpeg',
      stagingDir: c.root + '/staging',
      outputDir: c.root + '/processed',
      mediaStore: local,
      mediaEnvironment: 'test',
      groupId: c.actor.groupId,
    });
    assert.equal(tick.record.status, 'ready');
    await assert.rejects(local.head(allocation.scope, ref), { code: 'missing' });
  }));
