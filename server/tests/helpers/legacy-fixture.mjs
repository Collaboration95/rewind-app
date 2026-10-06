/**
 * Seed the fixture group into a pre-upgrade database using only columns from
 * migration 001, so upgrade tests can check how later migrations backfill it.
 * Mirrors fixture-group.mjs ids: demo-group, demo-1..demo-5, demo-cycle,
 * demo-contribution (3 s by demo-1) and three ready media jobs.
 */
export function seedLegacyFixture(database, now = '2026-09-01T00:00:00.000Z') {
  const endsAt = new Date(Date.parse(now) + 11 * 24 * 60 * 60 * 1000).toISOString();
  const profile = database.prepare(
    'INSERT INTO profiles (id, display_name, avatar_label, is_synthetic) VALUES (?, ?, ?, 1)',
  );
  const member = database.prepare(
    "INSERT INTO memberships (group_id, member_id, role, accepted_at) VALUES ('demo-group', ?, ?, ?)",
  );
  database
    .prepare(
      "INSERT INTO groups (id, name, current_cycle_id) VALUES ('demo-group', 'Weekend People', 'demo-cycle')",
    )
    .run();
  for (let index = 1; index <= 5; index += 1) {
    profile.run(`demo-${index}`, `Member ${index}`, `Member ${index}, sample member`);
    member.run(`demo-${index}`, index === 1 ? 'owner' : 'member', now);
  }
  database
    .prepare(
      `INSERT INTO cycles
        (id, group_id, prompt, starts_at, ends_at, status, lock_state, max_count, max_seconds)
       VALUES ('demo-cycle', 'demo-group', 'What made you pause and smile?', ?, ?,
         'collecting', 'locked', 5, 30)`,
    )
    .run(now, endsAt);
  database
    .prepare(
      `INSERT INTO contributions (id, cycle_id, member_id, duration_seconds, created_at)
       VALUES ('demo-contribution', 'demo-cycle', 'demo-1', 3, ?)`,
    )
    .run(now);
  const job = database.prepare(
    `INSERT INTO media_jobs (id, group_id, contribution_id, kind, status, output_path, created_at)
     VALUES (?, 'demo-group', ?, ?, 'ready', NULL, ?)`,
  );
  job.run('demo-clip', 'demo-contribution', 'clip', now);
  job.run('demo-film', null, 'film', now);
  job.run('demo-download', null, 'download', now);
}
