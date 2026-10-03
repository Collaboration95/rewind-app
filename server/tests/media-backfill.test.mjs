import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { openDatabase } from '../dist/db.js';
import { parseConfig } from '../dist/config.js';
import { LocalMediaStore } from '../dist/media/local-store.js';
import { encodeMediaRef } from '../dist/media/store.js';
import { createBackfillManifest, backfillRetainedMedia } from '../dist/media/backfill.js';
import { s3Double, s3Store } from './helpers/private-media-store.mjs';

function journalRecords(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare('SELECT record FROM receipts ORDER BY reference_index')
      .all()
      .map((row) => JSON.parse(row.record));
  } finally {
    db.close();
  }
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(run) {
  const root = await mkdtemp('/private/tmp/rewind-backfill-test-');
  const config = parseConfig({ REWIND_DATA_DIR: root });
  const database = openDatabase(config);
  const stagingRoot = resolve(root, 'media/staging');
  const processedRoot = resolve(root, 'media/processed');
  const privateRoot = resolve(root, 'private');
  for (const dir of [stagingRoot, processedRoot, privateRoot])
    await mkdir(dir, { recursive: true });
  const sourcePath = resolve(stagingRoot, 'retained.mp4');
  const sourceBytes = Buffer.from('retained source bytes');
  await writeFile(sourcePath, sourceBytes);
  database
    .prepare(
      `INSERT INTO staged_sources
    (source_id,source_uri,idempotency_key_hash,group_id,member_id,source_path,byte_length,status,created_at,claim_generation)
    VALUES ('source-170','staged://source170','hash170','demo-group','demo-1',?,?,'staged','2026-10-03',1)`,
    )
    .run(sourcePath, sourceBytes.length);
  database
    .prepare(
      `INSERT INTO media_jobs
    (id,group_id,kind,status,created_at,source_uri,source_generation,source_path)
    VALUES ('source-job-170','demo-group','clip','pending','2026-10-03','staged://source170',1,?)`,
    )
    .run(sourcePath);
  // Seeded real schema/film/clip/download data remain in scope, not a mock DB.
  const options = {
    databasePath: config.databasePath,
    environment: 'test',
    stagingRoot,
    processedRoot,
    privateRoot,
    incomingExpiresAt: '2099-01-01T00:00:00Z',
  };
  const manifestPath = resolve(root, 'manifest.json');
  const journalPath = resolve(root, 'journal.sqlite');
  const destination = new LocalMediaStore(resolve(root, 'destination'));
  const invocation = (
    manifest,
    store = destination,
    identity = { backend: 'local', storeId: destination.storeId },
  ) => ({
    manifestPath,
    manifestDigest: manifest.digest,
    journalPath,
    destination: store,
    destinationIdentity: identity,
  });
  const before = () =>
    database
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map(({ name }) => [name, database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
  try {
    await run({
      root,
      database,
      options,
      manifestPath,
      journalPath,
      destination,
      sourcePath,
      sourceBytes,
      invocation,
      before,
    });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('immutable read-only inventory identifies retained references and never seeds/migrates/updates DB', async () =>
  fixture(async (c) => {
    const rows = c.before();
    c.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const dbBytes = await readFile(c.options.databasePath);
    const manifest = await createBackfillManifest(c.options, c.manifestPath);
    assert.equal(manifest.inventory.references.length, 5);
    assert.deepEqual(
      new Set(manifest.inventory.references.map((r) => `${r.table}:${r.column}`)),
      new Set(['staged_sources:source_path', 'media_jobs:source_path', 'media_jobs:output_path']),
    );
    assert.equal(
      manifest.inventory.references.filter((r) => r.integrityBasis === 'observed-source-baseline')
        .length,
      2,
    );
    assert.ok(manifest.inventory.references.some((r) => r.prefix === 'films'));
    assert.deepEqual(c.before(), rows);
    assert.deepEqual(await readFile(c.options.databasePath), dbBytes);
    const original = await readFile(c.manifestPath);
    await assert.rejects(createBackfillManifest(c.options, c.manifestPath), { code: 'EEXIST' });
    assert.deepEqual(await readFile(c.manifestPath), original);
    assert.deepEqual(await readFile(c.sourcePath), c.sourceBytes);
  }));

test('interrupted destination GET resumes exact durable version and re-verifies every reused object', async () =>
  fixture(async (c) => {
    const rows = c.before();
    const manifest = await createBackfillManifest(c.options, c.manifestPath);
    let puts = 0,
      gets = 0,
      interrupt = true;
    const wrapped = {
      put: (...args) => {
        puts++;
        return c.destination.put(...args);
      },
      head: (...args) => c.destination.head(...args),
      read: async function* (...args) {
        gets++;
        if (interrupt && gets === 2) throw new Error('simulated interrupted external read');
        yield* c.destination.read(...args);
      },
      delete() {
        assert.fail('no source/destination deletion authorized');
      },
    };
    await assert.rejects(
      backfillRetainedMedia(c.invocation(manifest, wrapped)),
      /simulated interrupted/,
    );
    const prior = journalRecords(c.journalPath);
    assert.equal(prior.length, 2);
    interrupt = false;
    const resumed = await backfillRetainedMedia(c.invocation(manifest, wrapped));
    assert.deepEqual(resumed, { transferred: 3, reused: 2, cutover: 'not_implemented' });
    assert.equal(puts, 5);
    const repeat = await backfillRetainedMedia(c.invocation(manifest, wrapped));
    assert.deepEqual(repeat, { transferred: 0, reused: 5, cutover: 'not_implemented' });
    assert.equal(puts, 5);
    const all = journalRecords(c.journalPath);
    assert.deepEqual(all.slice(0, 2), prior);
    assert.equal(gets, 12);
    assert.deepEqual(c.before(), rows);
    assert.deepEqual(await readFile(c.sourcePath), c.sourceBytes);
  }));

test('same-length destination corruption fails restart without replacement or deletion', async () =>
  fixture(async (c) => {
    const manifest = await createBackfillManifest(c.options, c.manifestPath);
    await backfillRetainedMedia(c.invocation(manifest));
    const first = journalRecords(c.journalPath)[0].destination;
    await writeFile(
      resolve(c.root, 'destination', first.key, first.versionId),
      Buffer.alloc(first.byteLength, 65),
    );
    const journal = await readFile(c.journalPath);
    await assert.rejects(backfillRetainedMedia(c.invocation(manifest)), {
      code: 'integrity_mismatch',
    });
    assert.deepEqual(await readFile(c.journalPath), journal);
    assert.deepEqual(await readFile(c.sourcePath), c.sourceBytes);
  }));

for (const corruption of [
  'missing',
  'output-bytes',
  'output-checksum',
  'missing-checksum',
  'foreign-contribution',
  'source-size',
  'foreign-path',
  'leaf-symlink',
  'parent-symlink',
  'foreign-group',
  'foreign-generation',
  'film-input',
]) {
  test(`inventory fails closed on ${corruption} and publishes no manifest`, async () =>
    fixture(async (c) => {
      const output = c.database
        .prepare("SELECT output_path AS path FROM media_jobs WHERE id='demo-clip'")
        .get().path;
      if (corruption === 'missing') await rm(output);
      if (corruption === 'output-bytes') await writeFile(output, 'bad output');
      if (corruption === 'output-checksum')
        c.database
          .prepare("UPDATE media_jobs SET output_sha256=? WHERE id='demo-clip'")
          .run('a'.repeat(64));
      if (corruption === 'missing-checksum')
        c.database.prepare("UPDATE media_jobs SET output_sha256=NULL WHERE id='demo-clip'").run();
      if (corruption === 'foreign-contribution')
        c.database
          .prepare("UPDATE contributions SET media_job_id='absent' WHERE id='demo-contribution'")
          .run();
      if (corruption === 'source-size') await writeFile(c.sourcePath, 'truncated');
      if (corruption === 'foreign-path')
        c.database
          .prepare("UPDATE media_jobs SET output_path=? WHERE id='demo-clip'")
          .run(c.sourcePath);
      if (corruption === 'leaf-symlink') {
        const original = await readFile(output);
        await rm(output);
        await writeFile(resolve(c.root, 'outside'), original);
        await symlink(resolve(c.root, 'outside'), output);
      }
      if (corruption === 'parent-symlink') {
        const nested = resolve(c.options.processedRoot, 'nested');
        await symlink(c.options.processedRoot, nested);
        c.database
          .prepare("UPDATE media_jobs SET output_path=? WHERE id='demo-clip'")
          .run(resolve(nested, output.split('/').at(-1)));
      }
      if (corruption === 'foreign-group') {
        c.database
          .prepare("INSERT INTO groups(id,name,current_cycle_id) VALUES ('foreign','Foreign',NULL)")
          .run();
        c.database.prepare("UPDATE media_jobs SET group_id='foreign' WHERE id='demo-clip'").run();
      }
      if (corruption === 'foreign-generation')
        c.database
          .prepare("UPDATE media_jobs SET source_generation=2 WHERE id='source-job-170'")
          .run();
      if (corruption === 'film-input') {
        c.database
          .prepare(
            `INSERT INTO compilation_job_inputs(job_id,clip_job_id,contribution_id,position)
        VALUES ('demo-film','demo-download','demo-contribution',0)`,
          )
          .run();
      }
      await assert.rejects(createBackfillManifest(c.options, c.manifestPath));
      await assert.rejects(readFile(c.manifestPath), { code: 'ENOENT' });
    }));
}

test('empty retained inventory is explicit and source baseline cannot claim historical checksum verification', async () =>
  fixture(async (c) => {
    c.database.exec(
      'DELETE FROM staged_sources; DELETE FROM contributions; DELETE FROM media_jobs',
    );
    const manifest = await createBackfillManifest(c.options, c.manifestPath);
    assert.deepEqual(manifest.inventory.references, []);
    assert.deepEqual(await backfillRetainedMedia(c.invocation(manifest)), {
      transferred: 0,
      reused: 0,
      cutover: 'not_implemented',
    });
  }));

test('manifest tampering, changed DB/source, journal corruption and wrong destination fail before writes', async () =>
  fixture(async (c) => {
    const manifest = await createBackfillManifest(c.options, c.manifestPath);
    const original = await readFile(c.manifestPath);
    await chmod(c.manifestPath, 0o600);
    await writeFile(
      c.manifestPath,
      original.toString().replace('observed-source-baseline', 'db-checksum'),
    );
    await assert.rejects(backfillRetainedMedia(c.invocation(manifest)), {
      code: 'invalid_manifest',
    });
    await writeFile(c.manifestPath, original);
    c.database.prepare("UPDATE media_jobs SET status='failed' WHERE id='source-job-170'").run();
    await assert.rejects(backfillRetainedMedia(c.invocation(manifest)), {
      code: 'inventory_changed',
    });
    c.database.prepare("UPDATE media_jobs SET status='pending' WHERE id='source-job-170'").run();
    await writeFile(c.sourcePath, Buffer.alloc(c.sourceBytes.length, 66));
    await assert.rejects(backfillRetainedMedia(c.invocation(manifest)), {
      code: 'inventory_changed',
    });
    await writeFile(c.sourcePath, c.sourceBytes);
    await backfillRetainedMedia(c.invocation(manifest));
    const originalJournal = await readFile(c.journalPath);
    const editor = new DatabaseSync(c.journalPath);
    try {
      editor
        .prepare(
          `UPDATE receipts SET record=replace(record, '"versionId":"', '"versionId":"tampered-') WHERE reference_index=0`,
        )
        .run();
    } finally {
      editor.close();
    }
    await assert.rejects(backfillRetainedMedia(c.invocation(manifest)), {
      code: 'invalid_journal',
    });
    await writeFile(c.journalPath, originalJournal);
    await assert.rejects(
      backfillRetainedMedia(
        c.invocation(manifest, c.destination, { backend: 'local', storeId: 'other' }),
      ),
      { code: 'invalid_journal_identity' },
    );
    const corrupt = new DatabaseSync(c.journalPath);
    try {
      corrupt.prepare('DELETE FROM receipts WHERE reference_index=0').run();
    } finally {
      corrupt.close();
    }
    await assert.rejects(backfillRetainedMedia(c.invocation(manifest)), {
      code: 'invalid_journal',
    });
  }));

test('local versioned refs are verified against configured store, group and DB digest', async () =>
  fixture(async (c) => {
    const bytes = Buffer.from('stored private output');
    const store = new LocalMediaStore(c.options.privateRoot);
    const ref = await store.put(
      { environment: 'test', groupId: 'demo-group' },
      {
        prefix: 'processed',
        name: 'private-output',
        body: (async function* () {
          yield bytes;
        })(),
        sha256: sha(bytes),
        byteLength: bytes.length,
        contentType: 'video/mp4',
      },
    );
    c.database
      .prepare(
        "UPDATE media_jobs SET output_path=?,output_sha256=?,output_bytes=? WHERE id='demo-clip'",
      )
      .run(encodeMediaRef(ref), sha(bytes), bytes.length);
    const manifest = await createBackfillManifest(c.options, c.manifestPath);
    await backfillRetainedMedia(c.invocation(manifest));
    const foreign = { ...ref, environment: 'other', key: ref.key.replace('test/', 'other/') };
    c.database
      .prepare("UPDATE media_jobs SET output_path=? WHERE id='demo-clip'")
      .run(encodeMediaRef(foreign));
    await assert.rejects(createBackfillManifest(c.options, resolve(c.root, 'foreign.json')), {
      code: 'scope_mismatch',
    });
  }));

test('existing private S3 adapter exercises only simulated external boundary and pins all GETs', async () =>
  fixture(async (c) => {
    const manifest = await createBackfillManifest(c.options, c.manifestPath);
    const double = s3Double();
    const store = s3Store(double);
    const call = c.invocation(manifest, store, { backend: 's3', storeId: 'private-test-bucket' });
    assert.equal((await backfillRetainedMedia(call)).transferred, 5);
    assert.equal((await backfillRetainedMedia(call)).reused, 5);
    assert.equal(double.calls.filter(([name]) => name === 'put').length, 5);
    assert.equal(double.calls.filter(([name]) => name === 'delete').length, 0);
    for (const [operation, input] of double.calls) {
      assert.equal(input.ExpectedBucketOwner, '123456789012');
      if (operation === 'get' || operation === 'head')
        assert.ok(input.VersionId && input.VersionId !== 'null');
    }
    const value = double.versions.values().next().value;
    value.bytes = Buffer.alloc(value.ContentLength, 67);
    await assert.rejects(backfillRetainedMedia(call), { code: 'integrity_mismatch' });
  }));

test('read-only existing connection can observe same references without initialization side effects', async () =>
  fixture(async (c) => {
    const readonly = new DatabaseSync(c.options.databasePath, { readOnly: true });
    try {
      const count = readonly.prepare('SELECT count(*) AS n FROM media_jobs').get().n;
      await createBackfillManifest(c.options, c.manifestPath);
      assert.equal(readonly.prepare('SELECT count(*) AS n FROM media_jobs').get().n, count);
      assert.throws(() => readonly.exec('DELETE FROM media_jobs'));
    } finally {
      readonly.close();
    }
  }));

test('abrupt child process exit resumes committed exact versions without stale locks', async () =>
  fixture(async (c) => {
    const manifest = await createBackfillManifest(c.options, c.manifestPath);
    const script = `
    const { backfillRetainedMedia } = await import('./server/dist/media/backfill.js');
    const { LocalMediaStore } = await import('./server/dist/media/local-store.js');
    const options = JSON.parse(process.argv[1]);
    const store = new LocalMediaStore(options.root + '/destination');
    let gets = 0;
    options.destination = {
      put: (...args) => store.put(...args), head: (...args) => store.head(...args),
      read: async function* (...args) {
        if (++gets === 2) process.exit(17);
        yield* store.read(...args);
      },
      delete: () => { throw new Error('unexpected delete'); },
    };
    await backfillRetainedMedia(options);
  `;
    const call = c.invocation(manifest);
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        script,
        JSON.stringify({ ...call, destination: undefined, root: c.root }),
      ],
      { stdio: 'ignore' },
    );
    assert.equal(
      await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', resolve);
      }),
      17,
    );
    const saved = journalRecords(c.journalPath);
    assert.equal(saved.length, 2);
    assert.deepEqual(await backfillRetainedMedia(call), {
      transferred: 3,
      reused: 2,
      cutover: 'not_implemented',
    });
    assert.deepEqual(journalRecords(c.journalPath).slice(0, 2), saved);
    assert.deepEqual(await readFile(c.sourcePath), c.sourceBytes);
  }));

test('journal cannot overlap retained source roots or source database', async () =>
  fixture(async (c) => {
    const manifest = await createBackfillManifest(c.options, c.manifestPath);
    for (const journalPath of [c.sourcePath, c.options.databasePath, c.manifestPath])
      await assert.rejects(backfillRetainedMedia({ ...c.invocation(manifest), journalPath }), {
        code: 'journal_overlaps_source',
      });
    assert.deepEqual(await readFile(c.sourcePath), c.sourceBytes);
  }));

test('staged source MIME follows persisted metadata including PNG', async () =>
  fixture(async (c) => {
    c.database
      .prepare(
        `INSERT INTO media_metadata
    (source_uri,mime_type,byte_length,duration_seconds,width,height,has_audio,verified_at)
    VALUES ('staged://source170','image/png',?,3,320,240,1,'2026-10-03')`,
      )
      .run(c.sourceBytes.length);
    const manifest = await createBackfillManifest(c.options, c.manifestPath);
    assert.ok(
      manifest.inventory.references
        .filter((r) => r.prefix === 'incoming')
        .every((r) => r.contentType === 'image/png'),
    );
    await backfillRetainedMedia(c.invocation(manifest));
  }));

test('processed photo contributions retain MP4 output MIME during legacy backfill', async () =>
  fixture(async (c) => {
    const changed = c.database
      .prepare(
        "UPDATE media_jobs SET media_type='photo' WHERE kind='clip' AND output_path IS NOT NULL",
      )
      .run();
    assert.ok(Number(changed.changes) > 0);
    const manifest = await createBackfillManifest(c.options, c.manifestPath);
    const processed = manifest.inventory.references.filter((ref) => ref.prefix === 'processed');
    assert.ok(processed.length > 0);
    assert.ok(processed.every((ref) => ref.contentType === 'video/mp4'));
    await backfillRetainedMedia(c.invocation(manifest));
    assert.ok(
      journalRecords(c.journalPath)
        .filter((row) => row.destination.prefix === 'processed')
        .every((row) => row.destination.contentType === 'video/mp4'),
    );
  }));
