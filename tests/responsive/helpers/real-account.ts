import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test as base, type Page } from '@playwright/test';

const httpsPort = process.env.REWIND_WEB_SMOKE_HTTPS_PORT || 8443;
/** The smoke server's HTTPS listener; production web builds send credentials only over HTTPS. */
export const SECURE_ORIGIN = `https://localhost:${httpsPort}`;
/** Session of the one member that global setup registers through the UI. */
export const MEMBER_STATE = join(tmpdir(), `rewind-responsive-member-${httpsPort}.json`);
const password = 'Fixture-Only-Password-2026!';

/**
 * Signed-in specs share one member and group: the runtime allows five
 * registrations per source every 15 minutes, so a fresh account per test
 * would be rate limited. Specs must not sign out (that revokes the session).
 */
export const signedIn = {
  baseURL: SECURE_ORIGIN,
  ignoreHTTPSErrors: true,
  storageState: MEMBER_STATE,
};

export function uniqueUsername(prefix = 'member') {
  return `${prefix}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/** Register (which signs in) and create a group through the real entry UI. */
export async function signUpAndCreateGroup(page: Page, username = uniqueUsername()) {
  await page.goto(`${SECURE_ORIGIN}/`);
  await expect(page.getByTestId('welcome-entry')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByTestId('registration-username').fill(username);
  await page.getByTestId('registration-password').fill(password);
  await page.getByTestId('registration-password-confirmation').fill(password);
  // Registration signs straight in.
  await page.getByTestId('registration-submit').click();
  await page.getByTestId('real-group-create-choice').click();
  await page.getByTestId('real-group-name').fill(`Responsive ${username}`);
  await page.getByTestId('real-group-create-submit').click();
  await expect(page.getByTestId('real-group-home')).toBeVisible();
}

/**
 * Wait until none of the shared member's moments is still queued or processing.
 * The capture screen treats a processing moment it does not own as interrupted
 * and shows a failed panel instead of the trim controls, so an upload left over
 * from an earlier spec (this worker or the other one) would break a review on a
 * slow runner, where the server's ffmpeg outlives the spec that started it.
 */
export async function settleContributions(page: Page) {
  const group = await page.request.get('/api/real/groups/current');
  expect(group.ok()).toBe(true);
  const groupId = ((await group.json()) as { group: { group: { id: string } } }).group.group.id;
  await expect
    .poll(
      async () => {
        const ledger = await page.request.get(
          `/api/contributions?groupId=${encodeURIComponent(groupId)}`,
        );
        const { entries } = (await ledger.json()) as { entries: { state: string }[] };
        return entries.filter((e) => e.state === 'queued' || e.state === 'processing').length;
      },
      { message: 'earlier uploads finish processing', timeout: 30_000 },
    )
    .toBe(0);
}

/** Open the signed-in group's Home with its dock. */
export async function openGroupHome(page: Page) {
  await settleContributions(page);
  await page.goto('/');
  await expect(page.getByTestId('real-group-home')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('real-group-navigation')).toBeVisible();
}

/** Open the real photo camera from the dock shutter. */
export async function openCapture(page: Page) {
  await openGroupHome(page);
  await page.getByTestId('real-group-capture-action').click();
  await expect(page.getByTestId('camera-screen')).toBeVisible();
}

const UPLOAD_LOCK = join(tmpdir(), `rewind-responsive-upload-${httpsPort}.lock`);
const UPLOAD_LOCK_STALE_MS = 180_000;

async function withUploadLock(run: () => Promise<void>) {
  for (;;) {
    try {
      mkdirSync(UPLOAD_LOCK);
      break;
    } catch {
      // Held by the other worker (or left behind by a killed run).
      try {
        if (Date.now() - statSync(UPLOAD_LOCK).mtimeMs > UPLOAD_LOCK_STALE_MS)
          rmSync(UPLOAD_LOCK, { recursive: true, force: true });
      } catch {
        // Released in the meantime.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    await run();
  } finally {
    rmSync(UPLOAD_LOCK, { recursive: true, force: true });
  }
}

/**
 * `test` for specs that upload a moment. The shared member's uploads are
 * processed by one server-side slot (a second concurrent job is refused as
 * "at its configured concurrency limit"), and a job still processing makes the
 * next capture screen show a failed panel instead of the trim controls. Both
 * stay invisible while ffmpeg is fast, so these specs take turns across workers
 * and each leaves only after its own upload has been processed.
 */
export const test = base.extend<{ uploadSlot: void }>({
  uploadSlot: [
    async ({ page }, use) => {
      await withUploadLock(async () => {
        await settleContributions(page);
        await use();
        await settleContributions(page);
      });
    },
    { auto: true, timeout: 180_000 },
  ],
});
