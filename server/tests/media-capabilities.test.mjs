import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';

const { parseConfig } = await import('../dist/config.js');
const { openDatabase } = await import('../dist/db.js');
const { createRealAccount, authenticateRealAccount, revokeRealSession } =
  await import('../dist/auth/index.js');
const { createRealGroup } = await import('../dist/groups/real.js');
const { MediaCapabilities, MEDIA_CAPABILITY_TTL_MS } =
  await import('../dist/archive/capabilities.js');

const now = new Date('2026-10-02T12:00:00.000Z');

test('media capabilities pin one real session/group/released asset and fail closed after revocation, expiry or substitution', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/rewind-media-capabilities-`);
  const database = openDatabase(parseConfig({ REWIND_DATA_DIR: dataDir }));
  try {
    const created = await createRealAccount(
      database,
      'cap-owner',
      'Capability Owner',
      'synthetic capability password',
      now,
    );
    assert.equal(created.ok, true);
    const group = createRealGroup(
      database,
      created.account,
      { name: 'Scoped media', prompt: 'Memory', maxMembers: 2 },
      now,
    );
    const auth = await authenticateRealAccount(
      database,
      'cap-owner',
      'synthetic capability password',
      'test',
      now,
    );
    assert.equal(auth.status, 'authenticated');
    const token = auth.token;
    const outputPath = `${dataDir}/private-film.mp4`,
      sha256 = createHash('sha256').update('fixture').digest('hex');
    database
      .prepare(
        "UPDATE cycles SET status = 'revealing', release_status = 'published', release_published_at = ? WHERE id = ?",
      )
      .run(now.toISOString(), group.cycle.id);
    database
      .prepare(
        `INSERT INTO media_jobs (id, group_id, kind, status, cycle_id, output_path, created_at, output_sha256, output_bytes, output_verified_at)
      VALUES ('cap-film', ?, 'film', 'ready', ?, ?, ?, ?, 7, ?)`,
      )
      .run(
        group.group.id,
        group.cycle.id,
        outputPath,
        now.toISOString(),
        sha256,
        now.toISOString(),
      );
    const capabilities = new MediaCapabilities();
    const path = capabilities.issue(
      {
        sessionToken: token,
        accountId: created.account.id,
        groupId: group.group.id,
        memberId: group.memberId,
        jobId: 'cap-film',
        kind: 'film',
        purpose: 'play',
        outputPath,
        sha256,
        byteLength: 7,
      },
      now,
    );
    assert.equal(path.includes(token), false);
    assert.equal(path.includes(outputPath), false);
    const key = path.split('/').at(-1);
    assert.equal(capabilities.resolve(database, key, now)?.jobId, 'cap-film');
    assert.equal(capabilities.resolve(database, key, now, 'forged-other-session'), null);
    assert.equal(
      capabilities.resolve(database, key, new Date(now.getTime() + MEDIA_CAPABILITY_TTL_MS)),
      null,
    );
    const nextPath = capabilities.issue(
      {
        sessionToken: token,
        accountId: created.account.id,
        groupId: group.group.id,
        memberId: group.memberId,
        jobId: 'cap-film',
        kind: 'film',
        purpose: 'download',
        outputPath,
        sha256,
        byteLength: 7,
      },
      now,
    );
    const nextKey = nextPath.split('/').at(-1);
    database
      .prepare("UPDATE media_jobs SET output_sha256 = ? WHERE id = 'cap-film'")
      .run('a'.repeat(64));
    assert.equal(capabilities.resolve(database, nextKey, now), null);
    database.prepare("UPDATE media_jobs SET output_sha256 = ? WHERE id = 'cap-film'").run(sha256);
    database
      .prepare("UPDATE cycles SET release_status = 'unpublished' WHERE id = ?")
      .run(group.cycle.id);
    assert.equal(capabilities.resolve(database, nextKey, now), null);
    database
      .prepare("UPDATE cycles SET release_status = 'published' WHERE id = ?")
      .run(group.cycle.id);
    revokeRealSession(database, token, now);
    assert.equal(capabilities.resolve(database, nextKey, now), null);
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
