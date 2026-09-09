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

    await expect(navigation).toBeVisible();
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
