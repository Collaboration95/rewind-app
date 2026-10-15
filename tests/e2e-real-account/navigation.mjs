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

export async function signOutThroughUi(page) {
  await page.getByTestId('real-account-settings-button').click();
  await page.getByTestId('real-group-sign-out').click();
  await expect(page.getByTestId('real-sign-out-dialog')).toBeVisible();
  await page.getByTestId('real-group-sign-out-confirm').click();
  await expect(page.getByTestId('welcome-entry')).toBeVisible();
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
