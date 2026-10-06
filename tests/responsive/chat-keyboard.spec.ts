import { expect, test } from '@playwright/test';

import { openGroupHome, signedIn } from './helpers/real-account';

test.use(signedIn);

for (const viewport of [
  { width: 375, height: 667 },
  { width: 402, height: 874 },
]) {
  test(`${viewport.width}×${viewport.height} keeps the composer inside gutters and sends without losing keyboard focus`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openGroupHome(page);
    await page.getByTestId('real-group-nav-chat').click();
    const composer = page.getByTestId('real-chat-composer');
    const send = page.getByTestId('real-chat-send');
    const dock = page.getByTestId('real-group-navigation');
    await expect(composer).toBeVisible();
    // iOS Safari automatically zooms focused inputs with text below 16 px.
    expect(
      await composer.evaluate((input) => parseFloat(getComputedStyle(input).fontSize)),
    ).toBeGreaterThanOrEqual(16);

    const checkGutters = async () => {
      const width = await page.evaluate(() => window.visualViewport!.width);
      for (const control of [
        composer.locator('..'),
        send,
        page.getByTestId('real-group-menu-button'),
        page.getByTestId('real-account-settings-button'),
      ]) {
        const box = await control.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(12);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width - 12);
      }
      const sendBox = await send.boundingBox();
      expect(sendBox!.width).toBeGreaterThanOrEqual(44);
      expect(sendBox!.height).toBeGreaterThanOrEqual(44);
    };
    await checkGutters();

    // Supplement the simulator run with deterministic viewport event coverage.
    // This models keyboard geometry; it does not open an iOS software keyboard.
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, 'height', {
        configurable: true,
        value: window.innerHeight - 300,
      });
    });
    const message = `Keyboard check ${viewport.width} ${Date.now()}`;
    await composer.fill(message);
    await page.evaluate(() => window.visualViewport!.dispatchEvent(new Event('resize')));
    await expect(dock).toHaveCount(0);
    await checkGutters();
    await send.click();
    await expect(composer).toHaveValue('');
    await expect(composer).toBeFocused();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await expect(dock).toHaveCount(0);
    await checkGutters();
    await composer.evaluate((input) => (input as HTMLTextAreaElement).blur());
    await page.evaluate(() => {
      delete (window.visualViewport as unknown as { height?: number }).height;
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect(dock).toBeVisible();
    await checkGutters();
  });
}
