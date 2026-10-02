import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { expect, firefox, test } from '@playwright/test';

import { redactRealAccountDiagnostic } from '../../scripts/real-account-e2e-utils.mjs';

const password = 'Fixture-Only-Password-2026!';

function fixtureValue(name, value) {
  if (!value) throw new Error(`Missing required real-account fixture setting ${name}.`);
  return value;
}

function safeApiPath(pathname) {
  return pathname
    .replace(/\/real\/groups\/[^/]+/g, '/real/groups/:id')
    .replace(/\/real\/invites\/[^/]+/g, '/real/invites/:id');
}

async function registerAndSignIn(page, username, { invitation = false } = {}) {
  if (invitation) {
    await expect(page.getByTestId('invite-sign-in-intent')).toBeVisible();
    await page.getByTestId('sign-in-create-account').click();
  } else {
    await page.goto('/');
    await expect(page.getByTestId('welcome-entry')).toBeVisible();
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
  }

  await page.getByTestId('registration-username').fill(username);
  await page.getByTestId('registration-password').fill(password);
  await page.getByTestId('registration-password-confirmation').fill(password);
  await page.getByTestId('registration-submit').click();
  await expect(page.getByTestId('registration-success')).toBeVisible();
  await page.getByTestId('registration-continue-to-sign-in').click();
  if (invitation) await expect(page.getByTestId('invite-sign-in-intent')).toBeVisible();
  await page.getByTestId('real-account-username').fill(username);
  await page.getByTestId('real-account-password').fill(password);
  await page.getByTestId('real-account-submit').click();
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
      current?.oldStatus === 'revealing' &&
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

    const inviteResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === 'POST' &&
        url.pathname === `/api/real/groups/${encodeURIComponent(ownerGroupId)}/invites`
      );
    });
    await page.getByTestId('real-group-create-invite').click();
    const inviteResponse = await inviteResponsePromise;
    expect(inviteResponse.status()).toBe(201);
    const inviteBody = await inviteResponse.json();
    const invite = inviteBody.invite;
    expect(invite?.status).toBe('active');
    expect(invite?.groupId).toBe(ownerGroupId);
    expect(Date.parse(invite?.expiresAt)).toBeGreaterThan(Date.now());

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

    const oldCycleId = seedCurrentCycleDue(databasePath, ownerGroupId);
    await waitForSchedulerAdvance(databasePath, ownerGroupId, oldCycleId);

    await page.getByTestId('real-group-sign-out').click();
    await page.goto('/');
    await expect(page.getByTestId('welcome-entry')).toBeVisible();
    await registerAndSignIn(page, outsiderUsername);
    await expect(page.getByRole('heading', { name: 'Choose a group' })).toBeVisible();
    const forbiddenGroup = await page.evaluate(async (groupId) => {
      const response = await fetch(`/api/real/groups/${encodeURIComponent(groupId)}`, {
        credentials: 'same-origin',
      });
      return { status: response.status, body: await response.json() };
    }, ownerGroupId);
    expect(forbiddenGroup.status).toBe(404);
    expect(forbiddenGroup.body.error).toBe('forbidden');
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
