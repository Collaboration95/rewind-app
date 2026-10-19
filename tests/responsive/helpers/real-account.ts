import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, type Page } from '@playwright/test';

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

/** Open the signed-in group's Home with its dock. */
export async function openGroupHome(page: Page) {
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
