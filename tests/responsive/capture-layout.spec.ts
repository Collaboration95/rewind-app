import { expect, test, type Locator, type Page } from '@playwright/test';

import { openCapture, signedIn } from './helpers/real-account';

test.use(signedIn);

async function openCamera(page: Page, permission: 'prompt' | 'granted' | 'denied' = 'prompt') {
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
        const stream = canvas.captureStream(10);
        const audio = new AudioContext();
        const oscillator = audio.createOscillator();
        const destination = audio.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
        return stream;
      },
    });
  }, permission);
  await openCapture(page);
}

// The real capture view covers the whole screen; the dock is hidden there.
async function expectReachable(page: Page, control: Locator) {
  // Orientation changes can remount a card's compact scroll container.
  await expect(async () => {
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport({ ratio: 1 });
    const controlBox = await control.boundingBox();
    expect(controlBox).not.toBeNull();
    expect(controlBox!.y).toBeGreaterThanOrEqual(0);
    expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
    await control.click({ trial: true });
  }).toPass({ timeout: 5_000 });
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

// Trial clicks prove that floating headers do not cover the controls.
async function expectFullscreen(page: Page, testID: string) {
  await expect(page.getByTestId(testID)).toHaveCSS('height', `${page.viewportSize()!.height}px`);
  const box = await page.getByTestId(testID).boundingBox();
  expect(box!.y).toBe(0);
  await expect(page.getByTestId(testID)).toHaveCSS('width', `${page.viewportSize()!.width}px`);
}

test('live photo and video controls stay clickable in portrait and landscape', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await openCamera(page, 'granted');
  for (const viewport of [
    { width: 393, height: 852 },
    { width: 852, height: 393 },
    { width: 852, height: 300 },
  ]) {
    await page.setViewportSize(viewport);
    await expectFullscreen(page, 'camera-screen');
    await expectReachable(page, page.getByTestId('capture-back-to-group'));
    await expectReachable(page, page.getByTestId('camera-capture'));
    await expectReachable(page, page.getByTestId('camera-record-clip'));
  }
  await page.getByTestId('camera-record-clip').click();
  for (const viewport of [
    { width: 852, height: 300 },
    { width: 852, height: 393 },
    { width: 393, height: 852 },
  ]) {
    await page.setViewportSize(viewport);
    await expectFullscreen(page, 'video-capture-screen');
    await expectReachable(page, page.getByTestId('video-close'));
    await expectReachable(page, page.getByTestId('video-record'));
    await expectReachable(page, page.getByTestId('video-photo-mode'));
  }
  await page.setViewportSize({ width: 852, height: 300 });
  // Force a recorder interruption without changing media validation.
  await page.evaluate(() => {
    MediaRecorder.prototype.start = function () {
      throw new Error('Layout fixture recording interruption');
    };
  });
  await page.getByTestId('video-record').click();
  const restore = page.getByTestId('video-preview-recovery');
  await expectReachable(page, restore);
  await restore.click();
  await expectReachable(page, page.getByTestId('video-record'));
  await expectReachable(page, page.getByTestId('video-photo-mode'));
});

test('blocked permission actions scroll within the card without covering close or mode switch', async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await openCamera(page, 'denied');
  await page.setViewportSize({ width: 852, height: 300 });
  await expectReachable(page, page.getByRole('button', { name: 'Check again', exact: true }));
  await expectReachable(
    page,
    page.getByRole('button', { name: 'Choose an image file', exact: true }),
  );
  await expectReachable(page, page.getByTestId('capture-back-to-group'));
  await expectReachable(page, page.getByTestId('camera-record-clip'));
  await page.getByTestId('camera-record-clip').click();
  await expectReachable(page, page.getByRole('button', { name: 'Check again', exact: true }));
  await expectReachable(
    page,
    page.getByRole('button', { name: 'Choose a video file', exact: true }),
  );
  await expectReachable(page, page.getByTestId('video-close'));
  await expectReachable(page, page.getByTestId('video-photo-mode'));
});
