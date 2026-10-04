import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const portraitMp4 = readFileSync(join(process.cwd(), 'tests/fixtures/portrait-h264-aac.mp4'));
const mislabeledWebm = readFileSync(join(process.cwd(), 'tests/fixtures/mislabeled-webm.mp4'));

async function openVideoFallback(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: class {
        static isTypeSupported() {
          return false;
        }
      },
    });
  });
  await openVideoRoute(page);
  const unsupported = page.getByTestId('video-unsupported');
  await expect(unsupported).toBeVisible();
  // Option 2: the web app records with the phone's own camera sheet.
  await expect(unsupported).toContainText('Opens your phone camera.');
}

async function openVideoRoute(page: Page) {
  await page.goto('/');
  const navigation = page.getByTestId('main-navigation');
  const entry = page.getByTestId('demo-entry-demo-1');
  const welcome = page.getByTestId('welcome-entry');
  await expect(navigation.or(entry).or(welcome)).toBeVisible();
  if (await entry.isVisible()) {
    await entry.click();
  } else {
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Try Demo' }).click();
    await entry.click();
  }
  await expect(navigation).toBeVisible();
  await page.getByTestId('nav-camera').click();
  await expect(page.getByTestId('camera-screen')).toBeVisible();
  await page.getByTestId('camera-record-clip').click();
}

async function chooseVideo(page: Page, name: string, buffer: Buffer, mimeType: string) {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Record video' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ buffer, mimeType, name });
}

test('accepts a camera-sheet H.264/AAC MP4 and keeps review/upload metadata truthful', async ({
  page,
}) => {
  await openVideoFallback(page);
  await chooseVideo(page, 'portrait-h264-aac.mp4', portraitMp4, 'video/mp4');

  const review = page.getByTestId('video-review');
  await expect(review).toBeVisible();
  await expect(review).toContainText(/Recorded 2\.3 seconds · 720 × 1280 · audio included/);
  await expect(review).not.toContainText('FILE FALLBACK');
  await expect(review).not.toContainText('audio verified');

  const endSeconds = Number(await review.locator('input').nth(1).inputValue());
  expect(endSeconds).toBeGreaterThan(2.2);
  expect(endSeconds).toBeLessThan(2.3);

  const uploadRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/contributions/upload',
  );
  const uploadResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/contributions/upload',
  );
  const uploadButton = page.getByRole('button', { name: 'Upload clip' });
  await uploadButton.scrollIntoViewIfNeeded();
  const uploadBounds = await uploadButton.boundingBox();
  const navigationBounds = await page.getByTestId('main-navigation').boundingBox();
  expect(uploadBounds).not.toBeNull();
  expect(navigationBounds).not.toBeNull();
  expect(uploadBounds!.y + uploadBounds!.height).toBeLessThanOrEqual(navigationBounds!.y);
  await uploadButton.click();
  const uploadRequest = await uploadRequestPromise;
  const uploadBody = JSON.parse(uploadRequest.postData() ?? '{}') as Record<string, unknown>;
  expect(uploadBody.mimeType).toBe('video/mp4');
  expect(uploadBody.hasAudio).toBe(true);
  expect(uploadBody.width).toBe(720);
  expect(uploadBody.height).toBe(1280);
  expect(uploadBody.durationSeconds).toBeGreaterThan(2.2);
  expect(uploadBody.durationSeconds).toBeLessThan(2.3);
  const uploadResponse = await uploadResponsePromise;
  expect(uploadResponse.status(), await uploadResponse.text()).toBe(201);
  await expect(page.getByText('Upload queued as one pending contribution.')).toBeVisible();
});

test('keeps captured review inline with working play, pause, bounded seek and retake', async ({
  page,
}) => {
  await openVideoFallback(page);
  await chooseVideo(page, 'portrait-h264-aac.mp4', portraitMp4, 'video/mp4');

  const review = page.getByTestId('video-review');
  const video = review.locator('video');
  await expect(video).toHaveJSProperty('playsInline', true);
  await expect(video).toHaveJSProperty('muted', false);
  await review.locator('input').nth(0).fill('0.3');
  await review.locator('input').nth(1).fill('1.8');

  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0.5);
  await expect(page.getByTestId('video-review-time')).not.toHaveText('0.3 / 1.8 seconds');
  await page.getByRole('button', { name: 'Pause preview', exact: true }).click();
  await expect(video).toHaveJSProperty('paused', true);
  const pausedTime = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
  // Sample the real media clock over time; a label toggle alone cannot prove pause.
  await page.waitForTimeout(350);
  expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(
    pausedTime,
    2,
  );

  await page.getByRole('button', { name: 'Back 5 seconds', exact: true }).click();
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeCloseTo(0.3, 2);
  await page.getByRole('button', { name: 'Forward 5 seconds', exact: true }).click();
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeCloseTo(1.8, 2);
  await expect(video).toHaveJSProperty('paused', true);
  await expect(page.getByRole('button', { name: 'Upload clip', exact: true })).toBeEnabled();

  await page.getByRole('button', { name: 'Retake', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(page.getByTestId('video-review-player')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Record video' })).toBeVisible();
});

test('rejects a renamed WebM even when its caller-controlled type says video/mp4', async ({
  page,
}) => {
  await openVideoFallback(page);
  await chooseVideo(page, 'mislabeled-webm.mp4', mislabeledWebm, 'video/mp4');

  await expect(page.getByRole('alert')).toHaveText('Choose an MP4 video file.');
  await expect(page.getByTestId('video-review')).toHaveCount(0);
});

test('orientation guidance and camera controls stay reachable through short landscape rotation', async ({
  page,
}) => {
  // Layout and file-choice only: no camera grant, recording or actual Safari lock evidence.
  await page.setViewportSize({ width: 393, height: 852 });
  await openVideoFallback(page);
  const guidance = page.getByTestId('video-portrait-guidance');
  await expect(guidance).toContainText('Record in portrait or landscape');
  await page.setViewportSize({ width: 852, height: 300 });
  const navigation = page.getByTestId('main-navigation');
  const choose = page.getByRole('button', { name: 'Record video', exact: true });
  const back = page.getByRole('button', { name: 'Back', exact: true });
  for (const control of [guidance, choose, back]) {
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport({ ratio: 1 });
    const bounds = await control.boundingBox();
    const navigationBounds = await navigation.boundingBox();
    expect(bounds).not.toBeNull();
    expect(navigationBounds).not.toBeNull();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(navigationBounds!.y + 1);
    expect(navigationBounds!.y + navigationBounds!.height).toBeLessThanOrEqual(301);
  }
  await choose.click({ trial: true });
  await back.click();
  await expect(page.getByTestId('camera-screen')).toBeVisible();
  await page.setViewportSize({ width: 393, height: 852 });
  await page.getByTestId('camera-record-clip').click();
  await expect(guidance).toBeVisible();
  await expect(choose).toBeVisible();
});
