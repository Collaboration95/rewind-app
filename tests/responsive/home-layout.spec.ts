import { expect, test } from '@playwright/test';

const screenSizes = [
  { height: 568, name: 'compact phone', width: 320 },
  { height: 667, name: 'iPhone SE', width: 375 },
  { height: 740, name: 'small Android phone', width: 360 },
  { height: 844, name: 'standard phone', width: 390 },
  { height: 800, name: 'desktop browser', width: 1280 },
];

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
