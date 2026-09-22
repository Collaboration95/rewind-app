import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const portraitMp4 = readFileSync(join(process.cwd(), 'tests/fixtures/portrait-h264-aac.mp4'));
const mislabeledWebm = readFileSync(join(process.cwd(), 'tests/fixtures/mislabeled-webm.mp4'));

async function openVideoFallback(page: Page) {
  await page.goto('/');
  const navigation = page.getByTestId('main-navigation');
  const entry = page.getByTestId('demo-entry-demo-1');
  await expect(navigation.or(entry)).toBeVisible();
  if (await entry.isVisible()) await entry.click();
  await expect(navigation).toBeVisible();
  await page.getByTestId('nav-camera').click();
  await expect(page.getByTestId('camera-screen')).toBeVisible();
  await page.getByTestId('camera-record-clip').click();
  await expect(page.getByTestId('video-unsupported')).toBeVisible();
}

async function chooseVideo(page: Page, name: string, buffer: Buffer, mimeType: string) {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose a video file' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ buffer, mimeType, name });
}

test('accepts a generated portrait H.264/AAC MP4 and keeps review/upload metadata truthful', async ({
  page,
}) => {
  await openVideoFallback(page);
  await chooseVideo(page, 'portrait-h264-aac.mp4', portraitMp4, 'video/mp4');

  const review = page.getByTestId('video-review');
  await expect(review).toBeVisible();
  await expect(review).toContainText(
    /Selected MP4 2\.3 seconds · 720 × 1280 portrait · audio track detected; server verifies/,
  );
  await expect(review).toContainText('FILE FALLBACK · selected locally, not recorded in Rewind');
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
  await page.getByRole('button', { name: 'Upload clip' }).click();
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

test('rejects a renamed WebM even when its caller-controlled type says video/mp4', async ({
  page,
}) => {
  await openVideoFallback(page);
  await chooseVideo(page, 'mislabeled-webm.mp4', mislabeledWebm, 'video/mp4');

  await expect(page.getByRole('alert')).toHaveText('Choose an MP4 video file.');
  await expect(page.getByTestId('video-review')).toHaveCount(0);
});
