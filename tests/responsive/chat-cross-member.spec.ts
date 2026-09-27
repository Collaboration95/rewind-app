import { expect, test } from '@playwright/test';

test('two independent members receive each other’s messages without reloading', async ({
  browser,
  baseURL,
}) => {
  const amber = await browser.newContext();
  const birch = await browser.newContext();
  try {
    const pages = await Promise.all([amber.newPage(), birch.newPage()]);
    for (const [index, page] of pages.entries()) {
      await page.goto(baseURL!);
      await page.getByTestId(`demo-entry-demo-${index + 1}`).click();
      await page.getByTestId('nav-chat').click();
      await expect(page.getByText('Chat connection: Connected')).toBeVisible();
    }
    for (const [index, page] of pages.entries()) {
      const message = `Cross-member review ${index}-${Date.now()}`;
      await page.getByTestId('chat-composer').fill(message);
      await page.getByTestId('chat-send').click();
      await expect(
        pages[1 - index].getByTestId('chat-message').filter({ hasText: message }),
      ).toBeVisible();
    }
  } finally {
    await amber.close();
    await birch.close();
  }
});
