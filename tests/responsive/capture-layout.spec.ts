import { expect, test, type Locator, type Page } from '@playwright/test';

async function openCamera(page: Page, permission: 'prompt' | 'denied' = 'prompt') {
  // Layout fixtures only: no real camera request or Safari/native acceptance.
  await page.addInitScript((state) => {
    Object.defineProperty(navigator.permissions, 'query', {
      value: async () => ({ state }),
    });
    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: class {
        static isTypeSupported() {
          return true;
        }
      },
    });
  }, permission);
  await page.goto('/');
  await expect(page.getByTestId('welcome-entry')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Try Demo', exact: true }).click();
  await page.getByTestId('demo-entry-demo-1').click();
  await expect(page.getByTestId('main-navigation')).toBeVisible();
  await page.getByTestId('nav-camera').click();
}

async function expectReachable(page: Page, control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport({ ratio: 1 });
  const controlBox = await control.boundingBox();
  const navBox = await page.getByTestId('main-navigation').boundingBox();
  expect(controlBox).not.toBeNull();
  expect(navBox).not.toBeNull();
  expect(controlBox!.y).toBeGreaterThanOrEqual(0);
  expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(navBox!.y + 1);
  expect(navBox!.y + navBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  await control.click({ trial: true });
}

test('permission CTA and navigation remain reachable from portrait through short landscape', async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await openCamera(page);
  const allow = page.getByRole('button', { name: 'Allow camera access', exact: true });
  await expectReachable(page, allow);
  await page.setViewportSize({ width: 852, height: 300 });
  await expectReachable(page, allow);
  await page.getByTestId('nav-home').click();
  await expect(page.getByTestId('camera-screen')).toHaveCount(0);
  await expect(page.getByTestId('nav-home')).toContainText('SELECTED');
  await page.getByTestId('nav-camera').click();
  await page.setViewportSize({ width: 393, height: 852 });
  await expectReachable(page, allow);
});

test('short landscape file review keeps retake and discard usable above navigation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await openCamera(page, 'denied');
  const choose = page.getByRole('button', { name: 'Choose an image file', exact: true });
  async function selectImage() {
    const chooser = page.waitForEvent('filechooser');
    await choose.click();
    await (await chooser).setFiles('public/icons/rewind-icon-192.png');
    await expect(page.getByTestId('camera-preview-panel')).toBeVisible();
  }
  await selectImage();
  await page.setViewportSize({ width: 852, height: 300 });
  await expectReachable(page, page.getByRole('button', { name: 'Use this still', exact: true }));
  const retake = page.getByRole('button', { name: 'Retake', exact: true });
  await expectReachable(page, retake);
  await retake.click();
  await expect(page.getByTestId('camera-preview-panel')).toHaveCount(0);
  // Re-enter to refresh denied access after retake's existing ready state.
  await page.getByTestId('nav-home').click();
  await page.getByTestId('nav-camera').click();
  await selectImage();
  const discard = page.getByRole('button', { name: 'Discard', exact: true });
  await expectReachable(page, discard);
  await discard.click();
  await expect(page.getByTestId('camera-preview-panel')).toHaveCount(0);
  await page.getByTestId('nav-home').click();
  await expect(page.getByTestId('camera-screen')).toHaveCount(0);
  await expect(page.getByTestId('nav-home')).toContainText('SELECTED');
});
