import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { openDatabase } = await import('../../dist/db.js');

/** A five-member group with one ready clip, film and download, for tests that
 * exercise shared group, cycle, chat and media logic below the HTTP layer. */
export const FIXTURE = Object.freeze({
  profiles: [
    { id: 'demo-1', displayName: 'Amber', avatarLabel: 'Amber, sample member' },
    { id: 'demo-2', displayName: 'Birch', avatarLabel: 'Birch, sample member' },
    { id: 'demo-3', displayName: 'Clover', avatarLabel: 'Clover, sample member' },
    { id: 'demo-4', displayName: 'Dune', avatarLabel: 'Dune, sample member' },
    { id: 'demo-5', displayName: 'Echo', avatarLabel: 'Echo, sample member' },
  ],
  group: { id: 'demo-group', name: 'Weekend People', currentCycleId: 'demo-cycle' },
  cycle: {
    id: 'demo-cycle',
    prompt: 'What made you pause and smile?',
    durationMs: 11 * 24 * 60 * 60 * 1000,
    maxCount: 5,
    maxSeconds: 30,
  },
  acceptedAt: '2026-09-01T00:00:00.000Z',
  message: { id: 'demo-message', body: 'A synthetic message for policy checks.' },
  contribution: { id: 'demo-contribution', durationSeconds: 3 },
  mediaJobs: [
    { id: 'demo-clip', kind: 'clip' },
    { id: 'demo-film', kind: 'film' },
    { id: 'demo-download', kind: 'download' },
  ],
});

export const SAMPLE_CLIP_PATH = resolve(process.cwd(), 'server/fixtures/sample-clip.mp4');

/** Open a migrated database and add the fixture group once. */
export function openFixtureDatabase(config, { seedNow } = {}) {
  const database = openDatabase(config);
  seedFixtureGroup(database, seedNow);
  return database;
}

export function seedFixtureGroup(database, seedNow) {
  const existing = database.prepare('SELECT COUNT(*) AS count FROM profiles').get();
  if (Number(existing.count) > 0) return;
  const nowDate = seedNow === undefined ? new Date(FIXTURE.acceptedAt) : new Date(seedNow);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('The fixture seed time is invalid.');
  const now = nowDate.toISOString();
  const cycleEndsAt = new Date(nowDate.getTime() + FIXTURE.cycle.durationMs).toISOString();
  const databaseFile = database
    .prepare('PRAGMA database_list')
    .all()
    .find((entry) => entry.name === 'main')?.file;
  if (!databaseFile) throw new Error('Fixture media seeding requires a file-backed database.');
  const processedDir = resolve(databaseFile, '..', 'media', 'processed');
  const sample = readFileSync(SAMPLE_CLIP_PATH);
  const sampleSha256 = createHash('sha256').update(sample).digest('hex');
  mkdirSync(processedDir, { recursive: true });
  mkdirSync(resolve(databaseFile, '..', 'media', 'staging'), { recursive: true });
  const clipPath = resolve(processedDir, 'fixture-clip.mp4');
  const filmPath = resolve(processedDir, 'fixture-film.mp4');
  writeFileSync(clipPath, sample);
  writeFileSync(filmPath, sample);
  database.exec('BEGIN');
  try {
    const profileInsert = database.prepare(
      'INSERT INTO profiles (id, display_name, avatar_label, is_synthetic) VALUES (?, ?, ?, 1)',
    );
    for (const profile of FIXTURE.profiles) {
      profileInsert.run(profile.id, profile.displayName, profile.avatarLabel);
    }
    database
      .prepare('INSERT INTO groups (id, name, current_cycle_id) VALUES (?, ?, ?)')
      .run(FIXTURE.group.id, FIXTURE.group.name, FIXTURE.group.currentCycleId);
    database
      .prepare(
        `INSERT INTO cycles
          (id, group_id, prompt, starts_at, ends_at, status, lock_state, max_count, max_seconds, count_used, seconds_used)
         VALUES (?, ?, ?, ?, ?, 'collecting', 'locked', ?, ?, 0, 0)`,
      )
      .run(
        FIXTURE.cycle.id,
        FIXTURE.group.id,
        FIXTURE.cycle.prompt,
        now,
        cycleEndsAt,
        FIXTURE.cycle.maxCount,
        FIXTURE.cycle.maxSeconds,
      );
    const membershipInsert = database.prepare(
      'INSERT INTO memberships (group_id, member_id, role, accepted_at) VALUES (?, ?, ?, ?)',
    );
    for (const [index, profile] of FIXTURE.profiles.entries()) {
      membershipInsert.run(FIXTURE.group.id, profile.id, index === 0 ? 'owner' : 'member', now);
    }
    database
      .prepare(
        `INSERT INTO contributions
          (id, cycle_id, member_id, duration_seconds, created_at, quota_window_start_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        FIXTURE.contribution.id,
        FIXTURE.cycle.id,
        FIXTURE.profiles[0].id,
        FIXTURE.contribution.durationSeconds,
        now,
        now,
      );
    database
      .prepare(
        `INSERT INTO contribution_quota_windows
          (id, cycle_id, member_id, window_start_at, window_end_at,
           max_count, max_seconds, count_used, seconds_used)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        `fixture-quota-${FIXTURE.cycle.id}-${FIXTURE.profiles[0].id}`,
        FIXTURE.cycle.id,
        FIXTURE.profiles[0].id,
        now,
        new Date(Date.parse(now) + 7 * 24 * 60 * 60 * 1000).toISOString(),
        FIXTURE.cycle.maxCount,
        FIXTURE.cycle.maxSeconds,
        FIXTURE.contribution.durationSeconds,
      );
    const mediaInsert = database.prepare(
      `INSERT INTO media_jobs
        (id, group_id, contribution_id, kind, status, output_path, created_at, updated_at,
         output_sha256, output_bytes, output_verified_at, progress)
       VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, 100)`,
    );
    for (const job of FIXTURE.mediaJobs) {
      mediaInsert.run(
        job.id,
        FIXTURE.group.id,
        job.kind === 'clip' ? FIXTURE.contribution.id : null,
        job.kind,
        job.kind === 'clip' ? clipPath : filmPath,
        now,
        now,
        sampleSha256,
        sample.byteLength,
        now,
      );
    }
    database
      .prepare(
        'INSERT INTO messages (id, group_id, member_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(FIXTURE.message.id, FIXTURE.group.id, FIXTURE.profiles[0].id, FIXTURE.message.body, now);
    database
      .prepare(
        `INSERT INTO realtime_events (group_id, message_id, event_type, occurred_at)
         VALUES (?, ?, 'message', ?)`,
      )
      .run(FIXTURE.group.id, FIXTURE.message.id, now);
    database
      .prepare(
        'INSERT INTO reactions (id, message_id, member_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('demo-reaction', FIXTURE.message.id, FIXTURE.profiles[1].id, '✨', now);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/** Start a media scenario with an empty clip set when it supplies its own
 * inputs. Remove both sample records and bytes so they cannot become orphans. */
export function clearFixtureMedia(database) {
  const ids = FIXTURE.mediaJobs.map((job) => `'${job.id}'`).join(', ');
  const paths = database
    .prepare(`SELECT DISTINCT output_path AS path FROM media_jobs WHERE id IN (${ids})`)
    .all();
  database.exec(`
    DELETE FROM media_jobs WHERE id IN (${ids});
    DELETE FROM contributions WHERE id = '${FIXTURE.contribution.id}';
    DELETE FROM contribution_quota_windows
      WHERE id = 'fixture-quota-${FIXTURE.cycle.id}-${FIXTURE.profiles[0].id}';
  `);
  for (const { path } of paths) {
    if (path) rmSync(path, { force: true });
  }
}
