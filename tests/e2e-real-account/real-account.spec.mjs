import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, firefox, test } from '@playwright/test';

import {
  installChatResponseLoss,
  verifyMemberChat,
  verifyOwnerChat,
} from './chat-verification.mjs';
import {
  createGroupInvitation,
  switchGroupThroughUi,
  verifyForeignGroupDenied,
  verifySelectedGroupContext,
} from './group-switch-verification.mjs';

import { redactRealAccountDiagnostic } from '../../scripts/real-account-e2e-utils.mjs';

const password = 'Fixture-Only-Password-2026!';

function fixtureValue(name, value) {
  if (!value) throw new Error(`Missing required real-account fixture setting ${name}.`);
  return value;
}

function safeApiPath(pathname) {
  return pathname
    .replace(/\/real\/groups\/[^/]+/g, '/real/groups/:id')
    .replace(/\/real\/invites\/[^/]+/g, '/real/invites/:id')
    .replace(/\/media\/access\/[^/]+/g, '/media/access/:capability');
}

async function registerAndSignIn(page, username, { invitation = false } = {}) {
  if (invitation) {
    await expect(page.getByTestId('invite-sign-in-intent')).toBeVisible();
    await page.getByTestId('sign-in-create-account').click();
  } else {
    await page.goto('/');
    await expect(page.getByTestId('welcome-entry')).toBeVisible();
    await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  }

  await page.getByTestId('registration-username').fill(username);
  await page.getByTestId('registration-password').fill(password);
  await page.getByTestId('registration-password-confirmation').fill(password);
  // Registration signs straight in; a saved invitation continues afterwards.
  await page.getByTestId('registration-submit').click();
  await expect(page.getByTestId('welcome-entry')).toBeHidden();
}

async function readCurrentGroup(page) {
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/real/groups/current', { credentials: 'same-origin' });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(result.status, 200);
  assert.ok(result.body.group?.group?.id);
  return result.body.group;
}

function seedCurrentCycleDue(databasePath, groupId) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    const current = database
      .prepare(
        `SELECT cycles.id, cycles.starts_at AS startsAt, cycles.ends_at AS endsAt, cycles.status
         FROM groups JOIN cycles ON cycles.id = groups.current_cycle_id
         WHERE groups.id = ?`,
      )
      .get(groupId);
    assert.ok(current, 'the real owner group has a current cycle');
    assert.equal(current.status, 'collecting');
    const durationMs = Date.parse(current.endsAt) - Date.parse(current.startsAt);
    assert.ok(Number.isSafeInteger(durationMs) && durationMs > 0);
    const dueAt = Date.now() - 60_000;
    database
      .prepare('UPDATE cycles SET starts_at = ?, ends_at = ? WHERE id = ? AND group_id = ?')
      .run(
        new Date(dueAt - durationMs).toISOString(),
        new Date(dueAt).toISOString(),
        current.id,
        groupId,
      );
    return current.id;
  } finally {
    database.close();
  }
}

function readCycleAdvance(databasePath, groupId, oldCycleId) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    return database
      .prepare(
        `SELECT old.status AS oldStatus, successor.id AS successorId,
                successor.previous_cycle_id AS previousCycleId,
                groups.current_cycle_id AS currentCycleId,
                (SELECT COUNT(*) FROM cycle_lifecycle_events
                 WHERE cycle_id = old.id AND transition = 'next_cycle_created') AS nextCycleEvents
         FROM cycles AS old
         JOIN groups ON groups.id = old.group_id
         LEFT JOIN cycles AS successor ON successor.previous_cycle_id = old.id
         WHERE old.id = ? AND groups.id = ?`,
      )
      .get(oldCycleId, groupId);
  } finally {
    database.close();
  }
}

async function waitForSchedulerAdvance(databasePath, groupId, oldCycleId) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const current = readCycleAdvance(databasePath, groupId, oldCycleId);
    if (
      ['revealing', 'premiere', 'archived'].includes(current?.oldStatus) &&
      current.successorId &&
      current.previousCycleId === oldCycleId &&
      current.currentCycleId === current.successorId &&
      current.nextCycleEvents === 1
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    'The real cycle scheduler did not persist closure and the next-cycle transition.',
  );
}

async function contributeFixtureMedia(page, databasePath, groupId, suffix, video = false) {
  const photoPath = video
    ? join(process.cwd(), 'tests/fixtures/portrait-h264-aac.mp4')
    : join(dirname(databasePath), 'archive-fixture.png');
  if (!video)
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=navy:s=128x256',
      '-frames:v',
      '1',
      '-threads',
      '1',
      photoPath,
    ]);
  const result = await page.evaluate(
    async ({ base64, groupId, key, video }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const query = `groupId=${encodeURIComponent(groupId)}`;
      const staged = await fetch(
        `/api/contributions/upload/source?${query}&idempotencyKey=${key}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': video ? 'video/mp4' : 'image/png' },
          body: bytes,
        },
      );
      if (!staged.ok) return { stageStatus: staged.status };
      const { source } = await staged.json();
      const upload = await fetch(`/api/contributions/upload?${query}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mediaType: video ? 'video' : 'photo',
          idempotencyKey: key,
          sourceUri: source.uri,
          mimeType: video ? 'video/mp4' : 'image/png',
          byteLength: source.byteLength,
          durationSeconds: video ? 2 : 3,
          width: video ? 720 : 128,
          height: video ? 1280 : 256,
          hasAudio: true,
          mode: 'soft-focus',
          trimStartSeconds: 0,
          trimEndSeconds: video ? 2 : 3,
        }),
      });
      if (!upload.ok) return { stageStatus: staged.status, uploadStatus: upload.status };
      const { upload: pending } = await upload.json();
      const processed = await fetch(`/api/contributions/jobs/${pending.job.id}/process?${query}`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      return {
        stageStatus: staged.status,
        uploadStatus: upload.status,
        processStatus: processed.status,
        result: await processed.json(),
      };
    },
    {
      base64: readFileSync(photoPath).toString('base64'),
      groupId,
      key: `archive-media-${suffix}`,
      video,
    },
  );
  expect(result.stageStatus).toBe(201);
  expect(result.uploadStatus).toBe(201);
  expect(result.processStatus).toBe(200);
}

async function waitForPublication(databasePath, cycleId) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    await expect
      .poll(
        () =>
          database.prepare('SELECT release_status AS status FROM cycles WHERE id = ?').get(cycleId)
            ?.status,
        { timeout: 20000 },
      )
      .toBe('published');
  } finally {
    database.close();
  }
}

async function verifyReleasedDownloads(page, databasePath, groupId, suffix) {
  let audibleClip = false;
  for (const label of ['Download released group film', 'Download your released clip']) {
    const buttons = page.getByRole('button', { name: label, exact: true });
    expect(await buttons.count()).toBeGreaterThan(0);
    for (let index = 0; index < (await buttons.count()); index++) {
      const responsePromise = page.waitForResponse(
        (response) =>
          response.status() === 200 && Boolean(response.headers()['content-disposition']),
      );
      const downloaded = page.waitForEvent('download');
      await buttons.nth(index).click();
      const download = await downloaded;
      expect(await download.failure()).toBeNull();
      const path = join(
        dirname(databasePath),
        `download-${suffix}-${label.includes('group') ? 'film' : 'clip'}-${index}.mp4`,
      );
      await download.saveAs(path);
      const bytes = readFileSync(path);
      const response = await responsePromise;
      expect(response.headers()['content-type']).toMatch(/^video\/mp4/);
      expect(Number(response.headers()['content-length'])).toBe(bytes.length);
      expect(response.headers()['cache-control']).toBe('no-store');
      const database = new DatabaseSync(databasePath);
      try {
        const output = database
          .prepare(
            "SELECT output_bytes AS bytes FROM media_jobs WHERE group_id = ? AND kind = ? AND status = 'ready' AND output_sha256 = ?",
          )
          .get(
            groupId,
            label.includes('group') ? 'film' : 'clip',
            createHash('sha256').update(bytes).digest('hex'),
          );
        expect(output?.bytes).toBe(bytes.length);
      } finally {
        database.close();
      }
      expect(bytes.length).toBeGreaterThan(1000);
      expect(bytes.subarray(4, 8).toString()).toBe('ftyp');
      const probe = JSON.parse(
        execFileSync(
          'ffprobe',
          ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', path],
          { encoding: 'utf8' },
        ),
      );
      expect(probe.streams.some((stream) => stream.codec_type === 'video')).toBe(true);
      expect(probe.streams.some((stream) => stream.codec_type === 'audio')).toBe(true);
      const pcm = execFileSync('ffmpeg', [
        '-v',
        'error',
        '-i',
        path,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '8000',
        '-f',
        's16le',
        'pipe:1',
      ]);
      let energy = 0;
      for (let sample = 0; sample + 1 < pcm.length; sample += 2)
        energy += (pcm.readInt16LE(sample) / 32768) ** 2;
      const rms = Math.sqrt(energy / (pcm.length / 2));
      if (label.includes('group')) expect(rms).toBeGreaterThan(0.001);
      else audibleClip ||= rms > 0.001;
    }
  }
  expect(audibleClip).toBe(true);
}

test('real owner, invited member, outsider, strict local HTTPS, and automatic next cycle', async () => {
  const runNumber = fixtureValue('REWIND_REAL_ACCOUNT_RUN', process.env.REWIND_REAL_ACCOUNT_RUN);
  const profileDir = fixtureValue(
    'REWIND_REAL_ACCOUNT_PROFILE',
    process.env.REWIND_REAL_ACCOUNT_PROFILE,
  );
  const databasePath = fixtureValue('REWIND_REAL_ACCOUNT_DB', process.env.REWIND_REAL_ACCOUNT_DB);
  const webOrigin = fixtureValue(
    'REWIND_REAL_ACCOUNT_WEB_ORIGIN',
    process.env.REWIND_REAL_ACCOUNT_WEB_ORIGIN,
  );
  assert.match(webOrigin, /^https:\/\/localhost:543[1-9]$/);

  const context = await firefox.launchPersistentContext(profileDir, {
    headless: true,
    ignoreHTTPSErrors: false,
  });
  const diagnostics = [];
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.addInitScript(installChatResponseLoss);
    page.on('pageerror', (error) => diagnostics.push(`pageerror:${error.name}`));
    page.on('requestfailed', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) {
        diagnostics.push(`requestfailed:${request.method()}:${safeApiPath(url.pathname)}`);
      }
    });
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/')) {
        diagnostics.push(
          `response:${response.request().method()}:${safeApiPath(url.pathname)}:${response.status()}`,
        );
      }
    });
    const originResponse = await page.goto(`${webOrigin}/`);
    expect(originResponse?.status()).toBe(200);
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
    await expect(page.getByTestId('welcome-entry')).toBeVisible();
    expect(await page.evaluate(async () => (await fetch('/api/health')).ok)).toBe(true);

    const suffix = `${runNumber}${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const ownerUsername = `owner${suffix}`;
    const secondOwnerUsername = `otherowner${suffix}`;
    const memberUsername = `member${suffix}`;
    const outsiderUsername = `outsider${suffix}`;

    await registerAndSignIn(page, ownerUsername);
    await expect(page.getByRole('heading', { name: 'Choose a group' })).toBeVisible();
    await page.getByTestId('real-group-create-choice').click();
    await page.getByTestId('real-group-name').fill(`Fixture Group ${suffix}`);
    await page.getByTestId('real-group-create-submit').click();
    await expect(page.getByTestId('real-group-empty-contributions')).toBeVisible();
    const screenshotPath = process.env.REWIND_REAL_ACCOUNT_SCREENSHOT;
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
    const ownerGroup = await readCurrentGroup(page);
    const ownerGroupId = ownerGroup.group.id;
    const ownerChatEvent = await verifyOwnerChat(page, ownerGroupId, suffix);

    await page.getByTestId('real-group-open-archive').click();
    await expect(page.getByTestId('route-heading-archive')).toBeVisible();
    await expect(page.getByTestId('archive-empty-films')).toBeVisible();
    await expect(page.getByTestId('archive-empty-clips')).toBeVisible();
    await expect(page.getByTestId('archive-locked')).toBeVisible();
    await page.getByRole('button', { name: 'Back to group', exact: true }).click();
    await expect(page.getByTestId('real-group-empty-contributions')).toBeVisible();

    const invite = await createGroupInvitation(page, ownerGroupId);

    await page.getByTestId('real-group-sign-out').click();
    await expect(page.getByTestId('welcome-entry')).toBeVisible();

    // A distinct real owner makes stale member/profile context observable.
    await registerAndSignIn(page, secondOwnerUsername);
    await expect(page.getByRole('heading', { name: 'Choose a group' })).toBeVisible();
    await page.getByTestId('real-group-create-choice').click();
    await page.getByTestId('real-group-name').fill(`Second Group ${suffix}`);
    await page.getByTestId('real-group-create-submit').click();
    await expect(page.getByTestId('real-group-empty-contributions')).toBeVisible();
    const secondGroup = await readCurrentGroup(page);
    expect(secondGroup.group.id).not.toBe(ownerGroupId);
    await verifyForeignGroupDenied(page, ownerGroupId);
    expect((await readCurrentGroup(page)).group.id).toBe(secondGroup.group.id);
    const secondOwnerChatEvent = await verifyOwnerChat(
      page,
      secondGroup.group.id,
      `${suffix}-second`,
    );
    const secondInvite = await createGroupInvitation(page, secondGroup.group.id);
    await page.getByTestId('real-group-sign-out').click();
    await expect(page.getByTestId('welcome-entry')).toBeVisible();

    const inviteUrl = new URL('/invite', webOrigin);
    inviteUrl.searchParams.set('groupId', ownerGroupId);
    inviteUrl.searchParams.set('code', invite.code);
    inviteUrl.searchParams.set('expiresAt', invite.expiresAt);
    await page.goto(inviteUrl.toString());
    await registerAndSignIn(page, memberUsername, { invitation: true });
    await expect(page.getByTestId('real-invite-intent')).toBeVisible();
    await page.getByTestId('real-invite-accept').click();
    await expect(page.getByTestId('real-group-empty-contributions')).toBeVisible();
    await expect(page.getByTestId('real-group-members')).toContainText('2/');

    const membershipDb = new DatabaseSync(databasePath);
    try {
      const roles = membershipDb
        .prepare('SELECT role FROM real_group_memberships WHERE group_id = ? ORDER BY role')
        .all(ownerGroupId)
        .map((row) => row.role);
      expect(roles).toEqual(['member', 'owner']);
    } finally {
      membershipDb.close();
    }

    await verifyMemberChat(page, ownerGroupId, ownerChatEvent, suffix);

    // Membership in the first group must not authorize the second group.
    await verifyForeignGroupDenied(page, secondGroup.group.id);
    expect((await readCurrentGroup(page)).group.id).toBe(ownerGroupId);
    const firstContext = {
      owner: ownerUsername,
      member: memberUsername,
      otherOwner: secondOwnerUsername,
      message: ownerChatEvent.message.body,
      otherMessage: secondOwnerChatEvent.message.body,
    };
    const secondContext = {
      owner: secondOwnerUsername,
      member: memberUsername,
      otherOwner: ownerUsername,
      message: secondOwnerChatEvent.message.body,
      otherMessage: ownerChatEvent.message.body,
    };
    await verifySelectedGroupContext(page, ownerGroup.group, firstContext);
    await page.getByRole('button', { name: 'Join another group', exact: true }).click();
    await page.getByTestId('real-group-enter-code').fill(secondInvite.code);
    const joinResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/real/invites/accept',
    );
    await page.getByTestId('real-group-join-choice').click();
    const joined = await joinResponse;
    expect(joined.status()).toBe(200);
    expect((await joined.json()).group.group.id).toBe(secondGroup.group.id);
    await verifySelectedGroupContext(page, secondGroup.group, secondContext);
    await switchGroupThroughUi(page, ownerGroup.group);
    await verifySelectedGroupContext(page, ownerGroup.group, firstContext);
    await switchGroupThroughUi(page, secondGroup.group);
    await page.reload();
    await verifySelectedGroupContext(page, secondGroup.group, secondContext);
    await switchGroupThroughUi(page, ownerGroup.group);
    await page.reload();
    await verifySelectedGroupContext(page, ownerGroup.group, firstContext);

    await contributeFixtureMedia(page, databasePath, ownerGroupId, `${suffix}-photo`);
    await contributeFixtureMedia(page, databasePath, ownerGroupId, `${suffix}-video`, true);
    const oldCycleId = seedCurrentCycleDue(databasePath, ownerGroupId);
    await waitForSchedulerAdvance(databasePath, ownerGroupId, oldCycleId);
    await waitForPublication(databasePath, oldCycleId);
    await page.reload();
    await expect(page.getByTestId('real-group-home')).toBeVisible();
    await page.getByTestId('real-group-open-archive').click();
    await expect(page.getByTestId(/^archive-play-film-/).first()).toBeVisible();
    await page
      .getByTestId(/^archive-play-film-/)
      .first()
      .click();
    const playbackResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.startsWith('/api/media/access/') &&
        [200, 206].includes(response.status()),
    );
    await page.getByTestId('real-archive-play').click();
    const media = await playbackResponse;
    expect(media.headers()['content-type']).toMatch(/^video\/mp4/);
    const capabilityPath = new URL(media.url()).pathname;
    await expect
      .poll(() =>
        page
          .locator('video')
          .first()
          .evaluate((video) => video.readyState),
      )
      .toBeGreaterThanOrEqual(2);
    const video = page.locator('video').first();
    await expect(video).toHaveJSProperty('muted', false);
    expect(await video.evaluate((element) => element.volume)).toBeGreaterThan(0);
    if (await video.evaluate((element) => element.paused)) {
      const bounds = await video.boundingBox();
      expect(bounds).not.toBeNull();
      await video.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
    }
    await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeGreaterThan(0.1);
    if (screenshotPath)
      await page.screenshot({ path: `${screenshotPath}.archive.png`, fullPage: true });
    await verifyReleasedDownloads(page, databasePath, ownerGroupId, `first-${suffix}`);
    await page.getByRole('button', { name: 'Back to group', exact: true }).click();

    await contributeFixtureMedia(page, databasePath, ownerGroupId, `${suffix}-second-video`, true);
    const secondCycleId = seedCurrentCycleDue(databasePath, ownerGroupId);
    expect(secondCycleId).not.toBe(oldCycleId);
    await waitForSchedulerAdvance(databasePath, ownerGroupId, secondCycleId);
    await waitForPublication(databasePath, secondCycleId);
    await page.reload();
    expect((await readCurrentGroup(page)).group.id).toBe(ownerGroupId);
    await page.getByTestId('real-group-open-archive').click();
    await expect(page.getByTestId(/^archive-play-film-/)).toHaveCount(2);
    await verifyReleasedDownloads(page, databasePath, ownerGroupId, `second-${suffix}`);
    await page.reload();
    await page.getByTestId('real-group-open-archive').click();
    await expect(page.getByTestId(/^archive-play-film-/)).toHaveCount(2);
    expect((await readCurrentGroup(page)).group.id).toBe(ownerGroupId);
    await page.getByRole('button', { name: 'Back to group', exact: true }).click();

    await page.getByTestId('real-group-sign-out').click();
    await page.goto('/');
    await expect(page.getByTestId('welcome-entry')).toBeVisible();
    await registerAndSignIn(page, outsiderUsername);
    await expect(page.getByRole('heading', { name: 'Choose a group' })).toBeVisible();
    await verifyForeignGroupDenied(page, ownerGroupId);
    await verifyForeignGroupDenied(page, secondGroup.group.id);
    const forbiddenGroup = await page.evaluate(async (groupId) => {
      const response = await fetch(`/api/real/groups/${encodeURIComponent(groupId)}`, {
        credentials: 'same-origin',
      });
      return { status: response.status, body: await response.json() };
    }, ownerGroupId);
    expect(forbiddenGroup.status).toBe(404);
    expect(forbiddenGroup.body.error).toBe('forbidden');
    const revokedCapability = await page.evaluate(
      async (path) => (await fetch(path, { credentials: 'same-origin' })).status,
      capabilityPath,
    );
    expect([401, 403, 404]).toContain(revokedCapability);
  } catch (error) {
    const page = context.pages()[0];
    if (page) {
      try {
        const state = await page.evaluate(() => ({
          title: document.title,
          testIds: [...document.querySelectorAll('[data-testid]')]
            .slice(0, 30)
            .map((element) => element.getAttribute('data-testid')),
        }));
        diagnostics.push(`startup:${JSON.stringify(state)}`);
      } catch (diagnosticError) {
        diagnostics.push(`startup-diagnostic:${diagnosticError.name}`);
      }
    }
    throw new Error(
      `${redactRealAccountDiagnostic(error instanceof Error ? (error.stack ?? error.message) : error)}\n` +
        `Fixture diagnostics: ${redactRealAccountDiagnostic(diagnostics.slice(-30).join(' | '))}`,
    );
  } finally {
    await context.close();
  }
});
