import { expect, test } from '@playwright/test';

import { openGroupHome, signedIn } from './helpers/real-account';

test.use(signedIn);

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
    await openGroupHome(page);

    const navigation = page.getByTestId('real-group-navigation');
    const home = page.getByTestId('real-group-home');

    // The allowance row replaces "Loading…" once the ledger settles; wait for
    // it before scrolling, otherwise late content can move Home back under the dock.
    await expect(page.getByTestId('real-group-allowance')).not.toContainText('Loading');
    await page.getByTestId('real-group-allowance').scrollIntoViewIfNeeded();
    await page.mouse.move(screenSize.width / 2, screenSize.height / 3);
    await page.mouse.wheel(0, 2000);
    await expect
      .poll(() =>
        page
          .getByTestId('real-group-experience')
          .evaluate(
            (scroller) => scroller.scrollTop + scroller.clientHeight - scroller.scrollHeight,
          ),
      )
      .toBeGreaterThanOrEqual(-1);

    const navigationBox = await navigation.boundingBox();
    const homeBox = await home.boundingBox();

    expect(navigationBox).not.toBeNull();
    expect(homeBox).not.toBeNull();
    expect(navigationBox!.height).toBeGreaterThanOrEqual(68);
    expect(navigationBox!.y + navigationBox!.height).toBeLessThanOrEqual(screenSize.height + 1);
    expect(homeBox!.y + homeBox!.height).toBeLessThanOrEqual(navigationBox!.y + 1);
  });
}
