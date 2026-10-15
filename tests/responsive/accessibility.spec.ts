import { default as PlaywrightAxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { openGroupHome, SECURE_ORIGIN, signedIn } from './helpers/real-account';

test.use({ serviceWorkers: 'block' });

async function tabUntilFocused(page: Page, target: Locator, limit = 80) {
  for (let step = 0; step < limit; step += 1) {
    if (await target.evaluate((element) => document.activeElement === element).catch(() => false)) {
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error(`Keyboard tab order did not reach ${target}`);
}

async function expectNoSeriousAxeViolations(page: Page, state: string) {
  // Measure settled colours, not a frame of an entrance fade.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  const results = await new PlaywrightAxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );
  expect(serious, `${state}: ${JSON.stringify(serious, null, 2)}`).toEqual([]);
}

async function expectFocusVisible(page: Page) {
  const focused = page.locator(':focus');
  await expect(focused).toBeVisible();
  await expect(focused).not.toHaveAttribute('aria-hidden', 'true');
}

test.describe('signed out', () => {
  // HTTPS, so the account forms are enabled as a member would see them.
  test.use({ baseURL: SECURE_ORIGIN, ignoreHTTPSErrors: true });

  test('Welcome, sign-in and registration have no serious or critical Axe violations', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('welcome-entry')).toBeVisible();
    await expectNoSeriousAxeViolations(page, 'welcome');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('real-account-username')).toBeVisible();
    await expectNoSeriousAxeViolations(page, 'sign in');
    await page.getByRole('button', { name: 'Back to welcome' }).click();
    await page.getByRole('button', { name: 'Create an account' }).click();
    await expect(page.getByTestId('registration-username')).toBeVisible();
    await expectNoSeriousAxeViolations(page, 'registration');
  });

  test('keyboard reaches each entry form from Welcome', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('welcome-entry')).toBeVisible();
    await tabUntilFocused(page, page.getByRole('button', { name: 'Sign in' }));
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('real-account-username')).toBeVisible();
    await page.keyboard.press('Tab');
    await expectFocusVisible(page);
    await tabUntilFocused(page, page.getByRole('button', { name: 'Back to welcome' }));
    await page.keyboard.press('Enter');
    await tabUntilFocused(page, page.getByRole('button', { name: 'Create an account' }));
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('registration-username')).toBeVisible();
    await tabUntilFocused(page, page.getByTestId('registration-username'));
    await expectFocusVisible(page);
  });
});

test.describe('signed in', () => {
  test.use(signedIn);

  test('Home, Settings, Camera, Chat, and Archive have no serious or critical Axe violations', async ({
    page,
  }) => {
    await openGroupHome(page);
    await expectNoSeriousAxeViolations(page, 'home');

    await page.getByTestId('real-account-settings-button').click();
    await expect(page.getByTestId('real-settings-main')).toBeVisible();
    await expectNoSeriousAxeViolations(page, 'settings');
    await page.getByTestId('real-settings-back').click();

    await page.getByTestId('real-group-capture-action').click();
    await expect(page.getByTestId('camera-screen')).toBeVisible();
    await expectNoSeriousAxeViolations(page, 'camera');
    await page.getByTestId('capture-back-to-group').click();

    await page.getByTestId('real-group-nav-chat').click();
    await expect(
      page.getByTestId('real-chat-screen').or(page.getByTestId('real-chat-empty')).first(),
    ).toBeVisible();
    await expectNoSeriousAxeViolations(page, 'chat');

    await page.getByTestId('real-group-nav-archive').click();
    await expect(page.getByTestId('real-archive-first')).toBeVisible();
    await expectNoSeriousAxeViolations(page, 'archive');
  });

  test('sign-out dialog keeps keyboard focus inside, restores its trigger, and has no serious or critical violations', async ({
    page,
  }) => {
    await openGroupHome(page);
    await page.getByTestId('real-account-settings-button').click();
    const trigger = page.getByTestId('real-group-sign-out');
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByTestId('real-sign-out-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.locator('[aria-modal="true"]')).toHaveAttribute('role', 'dialog');
    await expect(page.getByRole('dialog', { name: 'Sign out confirmation' })).toBeVisible();
    await expectNoSeriousAxeViolations(page, 'dialog');

    const layer = page.getByTestId('real-sign-out-dialog-layer');
    const focusInLayer = () =>
      layer.evaluate((element) => element.contains(document.activeElement));
    await expect.poll(focusInLayer).toBe(true);
    const backgroundButton = page.getByTestId('real-settings-delete');
    await backgroundButton.evaluate((element) => (element as HTMLElement).focus());
    await expect(backgroundButton).not.toBeFocused();
    const stay = dialog.getByRole('button', { name: 'Stay signed in' });
    const signOut = dialog.getByRole('button', { name: 'Sign out' });
    await stay.focus();
    await page.keyboard.press('Tab');
    await expect(signOut).toBeFocused();
    // The rest of the page is inert, so tabbing on never lands behind the dialog.
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[inert]')))).toBe(
        false,
      );
    }
    await stay.click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('Archive loading state has no serious or critical Axe violations', async ({ page }) => {
    await openGroupHome(page);
    const releaseArchiveRequests: (() => void)[] = [];
    await page.route('**/api/archive?*', async (route) => {
      await new Promise<void>((resolve) => releaseArchiveRequests.push(resolve));
      await route.continue();
    });
    try {
      await page.getByTestId('real-group-nav-archive').click();
      await expect(page.getByTestId('real-archive')).toContainText('Loading…');
      await expectNoSeriousAxeViolations(page, 'loading');
      releaseArchiveRequests.splice(0).forEach((release) => release());
      await expect(page.getByTestId('real-archive-first')).toBeVisible();
    } finally {
      releaseArchiveRequests.splice(0).forEach((release) => release());
      await page.unroute('**/api/archive?*');
    }
  });

  /*
   * The browser tab order is exercised directly, so no navigation check is
   * satisfied by a pointer-only interaction.
   */
  test('keyboard navigation keeps focus on visible controls and reaches each main tab', async ({
    page,
  }) => {
    await openGroupHome(page);
    for (const tab of ['chat', 'archive', 'home'] as const) {
      const navigationItem = page.getByTestId(`real-group-nav-${tab}`);
      await tabUntilFocused(page, navigationItem);
      await page.keyboard.press('Enter');
      await expect(navigationItem).toHaveAttribute('aria-current', 'page');
      await page.keyboard.press('Tab');
      await expectFocusVisible(page);
    }
    await tabUntilFocused(page, page.getByTestId('real-group-capture-action'));
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('camera-screen')).toBeVisible();
    await tabUntilFocused(page, page.getByTestId('capture-back-to-group'));
    await expectFocusVisible(page);
  });
});
