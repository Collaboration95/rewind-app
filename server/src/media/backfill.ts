import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LocalMediaStore } from './local-store';
import {
  decodeMediaRef,
  isMediaRef,
  mediaKey,
  sameMediaRef,
  validateRef,
  verifiedBody,
  MEDIA_STORE_MAX_BYTES,
  type MediaObjectRef,
  type MediaPrefix,
  type MediaStore,
} from './store';

/** Offline preparation only. Quiesce HTTP/workers and hold an operator-owned
 * exclusive dataset lock throughout inventory/backfill. No runtime cutover,
 * DB updates, source deletion, credential lookup or SDK construction occurs. */
export interface InventoryOptions {
  databasePath: string;
  environment: string;
  stagingRoot: string;
  processedRoot: string;
  privateRoot?: string;
  /** Explicit retention deadline required when copying a legacy staged source. */
  incomingExpiresAt?: string;
}
interface RetainedReference {
  table: 'media_jobs' | 'staged_sources' | 'upload_intents';
  id: string;
  column: string;
  value: string;
  groupId: string;
  prefix: MediaPrefix;
  sha256: string;
  byteLength: number;
  contentType: string;
  expiresAt: string | null;
  integrityBasis: 'db-checksum' | 'observed-source-baseline';
}
interface Inventory {
  version: 1;
  options: InventoryOptions;
  databaseDigest: string;
  references: RetainedReference[];
}
export interface BackfillManifest {
  digest: string;
  inventory: Inventory;
}
export class BackfillError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'BackfillError';
  }
}
function fail(code: string): never {
  throw new BackfillError(code);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** Reject every symlink component, including configured roots and artifact
 * parents. Paths must be absolute and canonical, not aliases such as /tmp. */
async function safePath(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) fail('unsafe_path');
  let current = parse(path).root;
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) fail('unsafe_path');
  }
  if ((await realpath(path)) !== path) fail('unsafe_path');
}
async function safeFile(path: string, root: string) {
  const child = relative(root, path);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))
    fail('foreign_path');
  await safePath(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stat = await handle.stat();
  if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > MEDIA_STORE_MAX_BYTES) {
    await handle.close();
    fail('invalid_file');
  }
  return handle;
}
async function hashDisk(path: string, root: string) {
  const handle = await safeFile(path, root);
  try {
    const before = await handle.stat();
    const hash = createHash('sha256');
    let byteLength = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      byteLength += chunk.length;
      if (byteLength > MEDIA_STORE_MAX_BYTES) fail('invalid_file');
      hash.update(chunk);
    }
    const after = await handle.stat();
    await safePath(path);
    const named = await lstat(path);
    if (
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      byteLength !== before.size
    )
      fail('source_changed');
    return { sha256: hash.digest('hex'), byteLength };
  } finally {
    await handle.close();
  }
}

function snapshot(databasePath: string) {
  // Do not use openDatabase: that helper migrates, seeds and changes PRAGMAs.
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('BEGIN');
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') fail('invalid_database');
    const tables = [
      'media_jobs',
      'staged_sources',
      'compilation_job_inputs',
      'contributions',
      'cycles',
      'groups',
      'memberships',
      'upload_intents',
      'media_metadata',
    ] as const;
    const rows = Object.fromEntries(
      tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    ) as Record<(typeof tables)[number], Record<string, unknown>[]>;
    return rows;
  } finally {
    db.close();
  }
}
function text(row: Record<string, unknown>, key: string): string {
  if (typeof row[key] !== 'string' || !row[key]) fail('invalid_database_reference');
  return row[key] as string;
}
async function inventory(options: InventoryOptions): Promise<Inventory> {
  await safePath(options.databasePath);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      await safePath(options.databasePath + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const root of [options.stagingRoot, options.processedRoot, options.privateRoot])
    if (root) await safePath(root);
  mediaKey({ environment: options.environment, groupId: 'validation' }, 'processed', 'validation');
  const rows = snapshot(options.databasePath);
  const jobs = new Map(rows.media_jobs.map((row) => [row.id, row]));
  const cycles = new Map(rows.cycles.map((row) => [row.id, row]));
  const contributions = new Map(rows.contributions.map((row) => [row.id, row]));
  const groups = new Set(rows.groups.map((row) => row.id));
  for (const row of rows.media_jobs) {
    if (!groups.has(row.group_id)) fail('foreign_database_reference');
    if (row.cycle_id && cycles.get(row.cycle_id)?.group_id !== row.group_id)
      fail('foreign_database_reference');
    if (row.contribution_id) {
      const contribution = contributions.get(row.contribution_id);
      if (
        !contribution ||
        cycles.get(contribution.cycle_id)?.group_id !== row.group_id ||
        (row.cycle_id && contribution.cycle_id !== row.cycle_id)
      )
        fail('foreign_database_reference');
    }
    if (row.status === 'ready' && !row.output_path) fail('missing_database_reference');
  }
  for (const row of rows.contributions) {
    if (!row.media_job_id) continue;
    const job = jobs.get(row.media_job_id);
    if (
      !job ||
      job.kind !== 'clip' ||
      job.contribution_id !== row.id ||
      cycles.get(row.cycle_id)?.group_id !== job.group_id ||
      (job.cycle_id && job.cycle_id !== row.cycle_id)
    )
      fail('foreign_contribution_reference');
  }
  for (const row of rows.compilation_job_inputs) {
    const film = jobs.get(row.job_id),
      clip = jobs.get(row.clip_job_id);
    const contribution = contributions.get(row.contribution_id);
    if (
      !film ||
      !clip ||
      !contribution ||
      film.kind !== 'film' ||
      clip.kind !== 'clip' ||
      film.group_id !== clip.group_id ||
      !film.cycle_id ||
      film.cycle_id !== clip.cycle_id ||
      clip.contribution_id !== contribution.id ||
      contribution.cycle_id !== film.cycle_id
    )
      fail('foreign_compilation_reference');
  }
  const references: RetainedReference[] = [];
  async function add(
    row: Record<string, unknown>,
    table: RetainedReference['table'],
    idColumn: string,
    column: string,
    prefix: MediaPrefix,
  ) {
    if (row[column] === null) return;
    const value = text(row, column),
      groupId = text(row, 'group_id');
    if (!groups.has(groupId)) fail('foreign_database_reference');
    const scope = { environment: options.environment, groupId };
    let observed: { sha256: string; byteLength: number };
    const metadata = rows.media_metadata.find((item) => item.source_uri === row.source_uri);
    let contentType =
      prefix === 'incoming' && typeof metadata?.mime_type === 'string'
        ? metadata.mime_type
        : row.media_type === 'photo'
          ? 'image/jpeg'
          : 'video/mp4';
    let expiresAt = prefix === 'incoming' ? (options.incomingExpiresAt ?? null) : null;
    const persisted = prefix === 'incoming' ? null : row.output_sha256;
    const expectedSize = prefix === 'incoming' ? row.byte_length : row.output_bytes;
    if (isMediaRef(value)) {
      const ref = decodeMediaRef(value);
      validateRef(scope, ref, 'local');
      if (ref.prefix !== prefix || !options.privateRoot) fail('foreign_media_reference');
      const store = new LocalMediaStore(options.privateRoot);
      validateRef(scope, ref, 'local', store.storeId);
      const path = resolve(options.privateRoot, ref.key, ref.versionId);
      await safePath(path);
      await safePath(`${path}.json`);
      await verifyObject(store, ref);
      observed = { sha256: ref.sha256, byteLength: ref.byteLength };
      contentType = ref.contentType;
      expiresAt = ref.expiresAt;
    } else {
      observed = await hashDisk(
        value,
        prefix === 'incoming' ? options.stagingRoot : options.processedRoot,
      );
    }
    if (
      prefix !== 'incoming' &&
      (persisted !== observed.sha256 || expectedSize !== observed.byteLength)
    )
      fail('output_integrity_mismatch');
    if (prefix === 'incoming' && expectedSize != null && expectedSize !== observed.byteLength)
      fail('source_integrity_mismatch');
    // Reuse store validation for the explicit destination retention contract.
    validateRef(scope, {
      ...scope,
      backend: 'local',
      storeId: 'inventory',
      prefix,
      key: mediaKey(scope, prefix, 'inventory'),
      versionId: 'inventory',
      ...observed,
      contentType,
      expiresAt,
    });
    references.push({
      table,
      id: text(row, idColumn),
      column,
      value,
      groupId,
      prefix,
      ...observed,
      contentType,
      expiresAt,
      integrityBasis:
        prefix === 'incoming' && !isMediaRef(value) ? 'observed-source-baseline' : 'db-checksum',
    });
  }
  for (const row of rows.staged_sources) {
    if (row.status === 'staged' && !row.source_path) fail('missing_database_reference');
    if (
      !rows.memberships.some(
        (member) => member.group_id === row.group_id && member.member_id === row.member_id,
      )
    )
      fail('foreign_database_reference');
    await add(row, 'staged_sources', 'source_id', 'source_path', 'incoming');
  }
  for (const row of rows.media_jobs) {
    // A bound job must still name the exact retained source generation/group.
    if (row.source_path && row.source_uri) {
      const source = rows.staged_sources.find((item) => item.source_uri === row.source_uri);
      if (
        !source ||
        source.group_id !== row.group_id ||
        source.source_path !== row.source_path ||
        source.claim_generation !== row.source_generation
      )
        fail('foreign_source_reference');
      await add(
        { ...row, byte_length: source.byte_length },
        'media_jobs',
        'id',
        'source_path',
        'incoming',
      );
    } else await add(row, 'media_jobs', 'id', 'source_path', 'incoming');
    await add(row, 'media_jobs', 'id', 'output_path', row.kind === 'clip' ? 'processed' : 'films');
  }
  // Completed/expired upload receipts are lifecycle history, not retained
  // source bytes (workers legitimately delete them). Active pinned refs count.
  for (const row of rows.upload_intents.filter((item) => item.state === 'pinned')) {
    if (row.environment !== options.environment) fail('foreign_media_reference');
    await add(row, 'upload_intents', 'id', 'pinned_ref', 'incoming');
  }
  const owners = new Map<string, string>();
  for (const ref of references) {
    const owner = owners.get(ref.value);
    if (owner && owner !== ref.groupId) fail('foreign_source_reference');
    owners.set(ref.value, ref.groupId);
  }
  if (digest(rows) !== digest(snapshot(options.databasePath))) fail('database_changed');
  return { version: 1, options, databaseDigest: digest(rows), references };
}
async function verifyObject(store: MediaStore, ref: MediaObjectRef) {
  validateRef(ref, ref);
  if (!sameMediaRef(await store.head(ref, ref), ref)) fail('destination_integrity_mismatch');
  // Verify independently even if an injected adapter fails to check EOF.
  for await (const chunk of verifiedBody(store.read(ref, ref), ref)) void chunk;
}
async function exclusiveFile(path: string, body: string) {
  await safePath(dirname(path));
  const handle = await open(path, 'wx', 0o400);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const parent = await open(dirname(path), constants.O_RDONLY);
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
export async function createBackfillManifest(
  options: InventoryOptions,
  path: string,
): Promise<BackfillManifest> {
  const value = await inventory(options);
  const manifest = { digest: digest(value), inventory: value };
  await exclusiveFile(path, canonical(manifest) + '\n');
  return manifest;
}
async function loadManifest(path: string, expectedDigest: string): Promise<BackfillManifest> {
  await safePath(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const body = await handle.readFile('utf8');
    const manifest = JSON.parse(body) as BackfillManifest;
    if (
      !/^[a-f0-9]{64}$/.test(expectedDigest) ||
      manifest.digest !== expectedDigest ||
      manifest.inventory.version !== 1 ||
      digest(manifest.inventory) !== expectedDigest ||
      canonical(manifest) + '\n' !== body
    )
      fail('invalid_manifest');
    return manifest;
  } finally {
    await handle.close();
  }
}
interface JournalRecord {
  manifestDigest: string;
  previous: string;
  referenceIndex: number;
  destination: MediaObjectRef;
  digest: string;
}
export interface BackfillOptions {
  manifestPath: string;
  /** Trusted digest returned by exclusive manifest creation. */
  manifestDigest: string;
  journalPath: string;
  destination: MediaStore;
  destinationIdentity: { backend: MediaObjectRef['backend']; storeId: string };
}
/** SQLite's FULL-synchronous journal records exact versions atomically and
 * releases its writer lock on process death. PUT-before-receipt crashes can
 * still leave an unreferenced version: MediaStore cannot discover it. No
 * garbage collection or cutover is attempted. Keep the dataset quiescent. */
export async function backfillRetainedMedia(options: BackfillOptions): Promise<{
  transferred: number;
  reused: number;
  cutover: 'not_implemented';
}> {
  const manifest = await loadManifest(options.manifestPath, options.manifestDigest);
  if (digest(await inventory(manifest.inventory.options)) !== manifest.digest)
    fail('inventory_changed');
  const journalPath = options.journalPath;
  if (!isAbsolute(journalPath) || resolve(journalPath) !== journalPath) fail('unsafe_path');
  const sourceOptions = manifest.inventory.options;
  for (const root of [
    sourceOptions.stagingRoot,
    sourceOptions.processedRoot,
    sourceOptions.privateRoot,
  ]) {
    if (!root) continue;
    const child = relative(root, journalPath);
    if (!child || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child)))
      fail('journal_overlaps_source');
  }
  if (journalPath === sourceOptions.databasePath || journalPath === options.manifestPath)
    fail('journal_overlaps_source');
  await safePath(dirname(journalPath));
  let created = false;
  try {
    const file = await open(journalPath, 'wx', 0o600);
    await file.close();
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await safePath(journalPath);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      await safePath(journalPath + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const journal = new DatabaseSync(journalPath);
  let transaction = false;
  function begin() {
    journal.exec('BEGIN IMMEDIATE');
    transaction = true;
  }
  function commit() {
    journal.exec('COMMIT');
    transaction = false;
  }
  function check(ref: MediaObjectRef, entry: RetainedReference) {
    const scope = { environment: sourceOptions.environment, groupId: entry.groupId };
    validateRef(
      scope,
      ref,
      options.destinationIdentity.backend,
      options.destinationIdentity.storeId,
    );
    if (
      ref.prefix !== entry.prefix ||
      ref.key !== mediaKey(scope, entry.prefix, digest(entry)) ||
      ref.sha256 !== entry.sha256 ||
      ref.byteLength !== entry.byteLength ||
      ref.contentType !== entry.contentType ||
      ref.expiresAt !== entry.expiresAt
    )
      fail('invalid_journal_reference');
  }
  try {
    // No initialization of arbitrary existing databases. Empty files are safe
    // to initialize after a crash between exclusive creation and schema commit.
    const tables = journal.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    if (
      !created &&
      tables.length &&
      canonical(tables.map((row) => row.name).sort()) !== canonical(['header', 'receipts'])
    )
      fail('invalid_journal');
    journal.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
    begin();
    if (!tables.length) {
      journal.exec(
        'CREATE TABLE header (identity TEXT NOT NULL); CREATE TABLE receipts (reference_index INTEGER PRIMARY KEY, record TEXT NOT NULL)',
      );
      journal.prepare('INSERT INTO header VALUES (?)').run(
        canonical({
          version: 1,
          manifestDigest: manifest.digest,
          destination: options.destinationIdentity,
        }),
      );
    }
    const headers = journal.prepare('SELECT identity FROM header').all();
    if (
      headers.length !== 1 ||
      headers[0].identity !==
        canonical({
          version: 1,
          manifestDigest: manifest.digest,
          destination: options.destinationIdentity,
        })
    )
      fail('invalid_journal_identity');
    let previous = manifest.digest;
    const records = journal
      .prepare('SELECT reference_index,record FROM receipts ORDER BY reference_index')
      .all();
    for (const [index, row] of records.entries()) {
      const record = JSON.parse(String(row.record)) as JournalRecord;
      const { digest: recordDigest, ...payload } = record;
      const entry = manifest.inventory.references[index];
      if (
        !entry ||
        row.reference_index !== index ||
        record.referenceIndex !== index ||
        record.manifestDigest !== manifest.digest ||
        record.previous !== previous ||
        digest(payload) !== recordDigest ||
        canonical(record) !== row.record
      )
        fail('invalid_journal');
      check(record.destination, entry);
      previous = recordDigest;
    }
    commit();
    // Persist the directory entry as well as SQLite's transaction receipt.
    const parent = await open(dirname(journalPath), constants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    let transferred = 0,
      reused = 0;
    for (const [index, entry] of manifest.inventory.references.entries()) {
      begin();
      // Re-read inside the writer transaction: another offline process may
      // have completed this exact entry since the initial journal validation.
      const saved = journal
        .prepare('SELECT record FROM receipts WHERE reference_index=?')
        .get(index);
      if (saved) {
        const record = JSON.parse(String(saved.record)) as JournalRecord;
        const { digest: recordDigest, ...payload } = record;
        if (
          record.referenceIndex !== index ||
          record.manifestDigest !== manifest.digest ||
          digest(payload) !== recordDigest ||
          canonical(record) !== saved.record
        )
          fail('invalid_journal');
        check(record.destination, entry);
        await verifyObject(options.destination, record.destination);
        reused++;
        commit();
        continue;
      }
      const scope = { environment: sourceOptions.environment, groupId: entry.groupId };
      let handle;
      let source: AsyncIterable<Uint8Array>;
      if (isMediaRef(entry.value)) {
        const ref = decodeMediaRef(entry.value);
        source = new LocalMediaStore(sourceOptions.privateRoot!).read(scope, ref);
      } else {
        handle = await safeFile(
          entry.value,
          entry.prefix === 'incoming' ? sourceOptions.stagingRoot : sourceOptions.processedRoot,
        );
        source = handle.createReadStream({ autoClose: false });
      }
      try {
        const ref = await options.destination.put(scope, {
          prefix: entry.prefix,
          name: digest(entry),
          sha256: entry.sha256,
          byteLength: entry.byteLength,
          contentType: entry.contentType,
          expiresAt: entry.expiresAt,
          body: verifiedBody(source, entry),
        });
        check(ref, entry);
        const last = journal
          .prepare('SELECT record FROM receipts ORDER BY reference_index DESC LIMIT 1')
          .get();
        previous = last
          ? (JSON.parse(String(last.record)) as JournalRecord).digest
          : manifest.digest;
        const payload = {
          manifestDigest: manifest.digest,
          previous,
          referenceIndex: index,
          destination: ref,
        };
        const record = { ...payload, digest: digest(payload) };
        journal.prepare('INSERT INTO receipts VALUES (?,?)').run(index, canonical(record));
        commit();
        // Persist pending version before GET: interruption resumes its full
        // verification, not a replacement upload. A failed GET never marks
        // cutover readiness; all versions are verified on every invocation.
        await verifyObject(options.destination, ref);
        transferred++;
      } finally {
        await handle?.close();
      }
    }
    if (digest(await inventory(sourceOptions)) !== manifest.digest) fail('inventory_changed');
    return { transferred, reused, cutover: 'not_implemented' };
  } finally {
    if (transaction) journal.exec('ROLLBACK');
    journal.close();
  }
}
