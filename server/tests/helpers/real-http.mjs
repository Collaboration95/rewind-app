import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const { createRealAccount, authenticateRealAccount } = await import('../../dist/auth/index.js');
const { REAL_CYCLE_DURATION_MS } = await import('../../dist/groups/real.js');
const { probeClipWithFfmpeg } = await import('../../dist/ffmpeg.js');

/** Loopback HTTP may carry real credentials only with this local-dev flag. */
export const REAL_AUTH_ENV = Object.freeze({ REWIND_ALLOW_INSECURE_LOCAL_AUTH: 'true' });

const PASSWORD = 'synthetic fixture password';

/** Write a 2 s 180x320 clip with audio and return its probed metadata. */
export async function generateTestClip(ffmpegBin, outputPath) {
  await promisify(execFile)(ffmpegBin, [
    ...['-hide_banner', '-loglevel', 'error', '-y'],
    ...['-f', 'lavfi', '-i', 'testsrc=size=180x320:rate=12:duration=2'],
    ...['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=2'],
    ...['-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'],
    ...['-c:a', 'aac', '-shortest', outputPath],
  ]);
  return probeClipWithFfmpeg(ffmpegBin, outputPath);
}

/** Create a real account and an authenticated real session (no group yet). */
export async function realAccount(database, username, now = new Date()) {
  const created = await createRealAccount(database, username, username, PASSWORD, now);
  assert.equal(created.ok, true);
  const login = await authenticateRealAccount(
    database,
    username,
    PASSWORD,
    `client-${username}`,
    now,
  );
  assert.equal(login.status, 'authenticated');
  return {
    account: created.account,
    token: login.token,
    headers: { Authorization: `Bearer ${login.token}` },
  };
}

/**
 * Sign in a real account bound to an existing fixture profile (default the
 * `demo-group` member `demo-1`) and select that group, so shared routes resolve
 * the same group, cycle and member the fixture rows already use. The first
 * account bound to a group becomes its real owner.
 */
export async function signInAs(
  database,
  profileId = 'demo-1',
  { groupId = 'demo-group', now = new Date(), username = `member-${profileId}-${groupId}` } = {},
) {
  const member = await realAccount(database, username, now);
  const at = now.toISOString();
  database
    .prepare(
      `INSERT OR IGNORE INTO real_group_metadata
        (group_id, owner_account_id, max_members, cycle_duration_ms, created_at)
       VALUES (?, ?, 10, ?, ?)`,
    )
    .run(groupId, member.account.id, REAL_CYCLE_DURATION_MS, at);
  const owner = database
    .prepare('SELECT owner_account_id AS id FROM real_group_metadata WHERE group_id = ?')
    .get(groupId).id;
  database
    .prepare(
      'INSERT INTO real_profiles (id, account_id, display_name, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(profileId, member.account.id, username, at);
  database
    .prepare(
      `INSERT INTO real_group_memberships (group_id, account_id, profile_id, role, accepted_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      groupId,
      member.account.id,
      profileId,
      owner === member.account.id ? 'owner' : 'member',
      at,
    );
  database
    .prepare('INSERT INTO real_account_group_selections (account_id, group_id) VALUES (?, ?)')
    .run(member.account.id, groupId);
  return member;
}
