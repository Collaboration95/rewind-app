import { expect } from '@playwright/test';

export async function verifyNoGroup(page) {
  const empty = page.getByTestId('real-group-none');
  await expect(empty).toBeVisible();
  await expect(
    empty.getByRole('heading', { name: 'You’re not in a group yet', exact: true }),
  ).toBeVisible();
  await expect(empty.getByTestId('real-group-join-start')).toBeVisible();
  await expect(empty.getByTestId('real-group-create-choice')).toBeVisible();
}

export async function signOutThroughUi(page, { invitation = false } = {}) {
  await page.getByTestId('real-account-settings-button').click();
  await page.getByTestId('real-group-sign-out').click();
  await expect(page.getByTestId('real-sign-out-dialog')).toBeVisible();
  const revoked = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/auth/logout',
  );
  await page.getByTestId('real-group-sign-out-confirm').click();
  expect((await revoked).status()).toBe(200);
  await expect(page.getByTestId('real-group-home')).toHaveCount(0);
  if (invitation) {
    // A retained invitation opens sign-in so a new session can return to it.
    await expect(page.getByTestId('invite-sign-in-intent')).toBeVisible();
    await expect(page.getByTestId('real-account-submit')).toBeVisible();
  } else {
    await expect(page.getByTestId('welcome-entry')).toBeVisible();
  }
  expect(await page.evaluate(async () => (await fetch('/api/auth/session')).status)).toBe(401);
}

export async function closeSettings(page) {
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByTestId('real-settings-main')).toHaveCount(0);
}

export async function openChat(page, groupId) {
  const connected = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === `/api/realtime/groups/${encodeURIComponent(groupId)}/events` &&
      url.searchParams.get('metadataOnly') !== 'true'
    );
  });
  await page.getByTestId('real-group-nav-chat').click();
  const response = await connected;
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^text\/event-stream/);
  await expect(page.getByTestId('real-chat-composer')).toBeEnabled();
}
