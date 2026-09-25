import { default as PlaywrightAxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function enterDemo(page: Page) {
  await page.goto('/');
  const chooser = page.getByTestId('demo-entry-demo-1');
  if (await chooser.isVisible().catch(() => false)) await chooser.click();
  await expect(page.getByTestId('main-navigation')).toBeVisible();
}

async function expectNoSeriousAxeViolations(page: Page, state: string) {
  const results = await new PlaywrightAxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );
  expect(serious, `${state}: ${JSON.stringify(serious, null, 2)}`).toEqual([]);
}

test('Home, Settings, Camera, Chat, and Archive have no serious or critical Axe violations', async ({
  page,
}) => {
  await enterDemo(page);
  await expectNoSeriousAxeViolations(page, 'home');
  for (const route of ['home', 'settings', 'camera', 'chat', 'archive'] as const) {
    await page.getByTestId(`nav-${route}`).click();
    if (route !== 'home') {
      await expect(page.locator(`#screen-route-${route} [role="heading"]`).first()).toBeFocused();
    }
    await expectNoSeriousAxeViolations(page, route);
  }
});

test('dialog traps keyboard focus, restores its trigger, and has no serious or critical violations', async ({
  page,
}) => {
  await enterDemo(page);
  await page.getByTestId('nav-settings').click();
  const trigger = page.getByTestId('reset-demo-data');
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('reset-confirmation');
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole('dialog', { name: 'Reset local Demo data confirmation' }),
  ).toBeVisible();
  await expectNoSeriousAxeViolations(page, 'dialog');
  const controls = dialog.getByRole('button');
  const last = controls.last();
  const first = controls.first();
  await last.focus();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();
  await page.getByRole('button', { name: 'Keep local data' }).click();
  await expect(trigger).toBeFocused();
});

test('Archive loading and Demo access error states have no serious or critical Axe violations', async ({
  page,
}) => {
  await enterDemo(page);
  const releasePremiereRequests: (() => void)[] = [];
  await page.route('**/api/cycles/*/premiere**', async (route) => {
    await new Promise<void>((resolve) => releasePremiereRequests.push(resolve));
    await route.continue();
  });
  await page.getByTestId('nav-archive').click();
  await expect(page.getByTestId('archive-loading')).toBeVisible();
  await expectNoSeriousAxeViolations(page, 'loading');
  releasePremiereRequests.forEach((release) => release());
  await expect(page.getByTestId('archive-locked')).toBeVisible();
  await page.unroute('**/api/cycles/*/premiere**');
});

test('Demo access error state has no serious or critical Axe violations', async ({ page }) => {
  await page.route('**/sessions/demo', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":"runtime_unavailable","message":"The local runtime is offline."}',
    });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Choose who you are showing' })).toBeVisible();
  await page.getByTestId('demo-entry-demo-1').click();
  await expect(page.getByRole('alert')).toContainText('local runtime is offline');
  await expect(page.getByRole('button', { name: 'Retry Demo access' })).toBeVisible();
  await expectNoSeriousAxeViolations(page, 'error');
});

test('entry chooser has no serious or critical Axe violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Choose who you are showing' })).toBeVisible();
  await expectNoSeriousAxeViolations(page, 'entry');
});

/*
 * The browser tab order is deliberately exercised along with route heading
 * focus, so no navigation check is satisfied by a pointer-only interaction.
 */
test('keyboard navigation keeps focus on visible controls and reaches each main route', async ({
  page,
}) => {
  await enterDemo(page);
  for (const route of ['camera', 'chat', 'archive', 'settings', 'home'] as const) {
    await page.getByTestId(`nav-${route}`).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(`#screen-route-${route} [role="heading"]`).first()).toBeFocused();
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toBeVisible();
    await expect(focused).not.toHaveAttribute('aria-hidden', 'true');
  }
});
