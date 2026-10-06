import { expect, test, type Locator, type Page } from '@playwright/test';

import { openCapture, signedIn } from './helpers/real-account';

test.use(signedIn);

async function openCamera(page: Page, permission: 'prompt' | 'granted' = 'prompt') {
  // Layout fixtures only: a synthetic canvas camera, no real device or Safari acceptance.
  await page.addInitScript((state) => {
    Object.defineProperty(navigator.permissions, 'query', {
      value: async () => ({ state }),
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 360;
        canvas.height = 640;
        const drawing = canvas.getContext('2d')!;
        setInterval(() => {
          drawing.fillStyle = 'navy';
          drawing.fillRect(0, 0, canvas.width, canvas.height);
        }, 100);
        return canvas.captureStream(10);
      },
    });
  }, permission);
  await openCapture(page);
}

// The real capture view covers the whole screen; the dock is hidden there.
async function expectReachable(page: Page, control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport({ ratio: 1 });
  const controlBox = await control.boundingBox();
  expect(controlBox).not.toBeNull();
  expect(controlBox!.y).toBeGreaterThanOrEqual(0);
  expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  await control.click({ trial: true });
}

async function closeToHome(page: Page) {
  await page.getByTestId('capture-back-to-group').click();
  await expect(page.getByTestId('camera-screen')).toHaveCount(0);
  await expect(page.getByTestId('real-group-nav-home')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('[role="tab"][aria-current="page"]')).toHaveCount(1);
}

test('camera permission CTA and close remain reachable from portrait through short landscape', async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await openCamera(page);
  // The real web camera asks in-page before the browser prompt.
  await expect(page.getByTestId('camera-permission-undecided')).toBeVisible();
  const allow = page.getByRole('button', { name: 'Continue', exact: true });
  const close = page.getByTestId('capture-back-to-group');
  await expectReachable(page, allow);
  await expectReachable(page, close);
  await page.setViewportSize({ width: 852, height: 300 });
  await expectReachable(page, allow);
  await expectReachable(page, close);
  await page.setViewportSize({ width: 393, height: 852 });
  await closeToHome(page);
  await page.getByTestId('real-group-capture-action').click();
  await expectReachable(page, allow);
});

test('short landscape still review keeps seal and retake usable', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await openCamera(page, 'granted');
  const take = page.getByRole('button', { name: 'Take photo', exact: true });
  async function takeStill() {
    await take.click();
    await expect(page.getByTestId('camera-preview-panel')).toBeVisible();
  }
  await takeStill();
  await page.setViewportSize({ width: 852, height: 300 });
  await expectReachable(page, page.getByTestId('camera-seal'));
  const retake = page.getByRole('button', { name: 'Retake', exact: true });
  await expectReachable(page, retake);
  await retake.click();
  await expect(page.getByTestId('camera-preview-panel')).toHaveCount(0);
  await expectReachable(page, take);
  await takeStill();
  await expectReachable(page, page.getByTestId('capture-back-to-group'));
  await page.setViewportSize({ width: 393, height: 852 });
  await closeToHome(page);
});
