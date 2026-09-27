import { expect, test } from '@playwright/test';

const screenSizes = [
  { height: 568, name: 'compact phone', width: 320 },
  { height: 667, name: 'iPhone SE', width: 375 },
  { height: 740, name: 'small Android phone', width: 360 },
  { height: 844, name: 'standard phone', width: 390 },
  { height: 800, name: 'desktop browser', width: 1280 },
];

test('phone Home exposes the prompt, allowance and next action before the illustration', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const chooser = page.getByTestId('demo-entry-demo-1');
  await expect(chooser.or(page.getByTestId('main-navigation'))).toBeVisible();
  if (await chooser.isVisible()) await chooser.click();
  const action = page.getByTestId(/home-reveal-/).getByRole('button');
  await expect(action).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId('cycle-prompt')).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId('cycle-quota')).toBeInViewport({ ratio: 1 });
  expect((await action.boundingBox())!.y).toBeLessThan(
    (await page.getByTestId('darkroom-filmstrip').boundingBox())!.y,
  );
  await expect(page.getByRole('button', { name: /Choose .*sample member/ })).toHaveCount(0);
  await page.getByTestId('nav-settings').click();
  await expect(page.getByRole('button', { name: /Choose .*sample member/ })).toHaveCount(5);
});

for (const screenSize of screenSizes) {
  test(`${screenSize.name} keeps Home content clear of the main navigation`, async ({ page }) => {
    await page.setViewportSize(screenSize);
    await page.goto('/');

    const navigation = page.getByTestId('main-navigation');
    const lastHomeContent = page.getByTestId('home-content-end');
    const entryChoice = page.getByTestId('demo-entry-demo-1');

    // A clean browser context can either restore the offline Demo fixture or
    // show the explicit chooser when stale local access was invalidated.
    await expect(navigation.or(entryChoice)).toBeVisible();
    if (await entryChoice.isVisible()) await entryChoice.click();

    await expect(navigation).toBeVisible();

    // The ledger can replace its loading panel with a larger result after the
    // first layout. Wait for that request to settle before scrolling the final
    // Home item, otherwise late content can move it back below the nav.
    await expect(page.getByTestId(/contribution-ledger-(ready|denied|error)/)).toBeVisible();
    await lastHomeContent.scrollIntoViewIfNeeded();
    await expect(lastHomeContent).toBeVisible();

    const navigationBox = await navigation.boundingBox();
    const lastHomeContentBox = await lastHomeContent.boundingBox();

    expect(navigationBox).not.toBeNull();
    expect(lastHomeContentBox).not.toBeNull();
    expect(navigationBox!.height).toBeGreaterThanOrEqual(68);
    expect(navigationBox!.y + navigationBox!.height).toBeLessThanOrEqual(screenSize.height + 1);
    expect(lastHomeContentBox!.y + lastHomeContentBox!.height).toBeLessThanOrEqual(
      navigationBox!.y + 1,
    );
  });
}
