import { expect, test } from '@playwright/test';

import {
  allowInjectedSource,
  expectInjectedSourceInstalled,
  expectRevoked,
  expectSourceStopped,
  injectRecordingSource,
  inspectRecording,
  openInjectedCapture,
  recordFor,
  recordingSupport,
  restoreInjectedPreview,
} from './helpers/injected-recording';

test.use({ viewport: { width: 390, height: 844 } });
test.setTimeout(90_000);

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    const state = window.__injectedCapture;
    if (!state) return;
    for (const source of state.sources) {
      source.stream
        .getTracks()
        .filter((track) => track.readyState === 'live')
        .forEach((track) => track.stop());
    }
    await Promise.all(
      state.playbackAudio.filter((audio) => audio.state !== 'closed').map((audio) => audio.close()),
    );
  });
});

test('reports real MP4 recorder support without granting device permissions', async ({
  page,
}, info) => {
  await injectRecordingSource(page);
  const supported = await recordingSupport(page, info);
  await openInjectedCapture(page);
  await expectInjectedSourceInstalled(page);
  expect(await page.evaluate(() => window.__injectedCapture.sources.length)).toBe(0);
  if (supported) {
    await expect(page.getByTestId('video-permission')).toBeVisible();
  } else {
    await expect(page.getByTestId('video-unsupported')).toContainText(
      'This browser cannot record the MP4 format required for upload.',
    );
    await expect(
      page.getByRole('button', { name: 'Choose a video file', exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('video-record')).toHaveCount(0);
  }
});

test('synthetic device guard fails closed and reinstalls after navigation', async ({
  page,
}, info) => {
  await injectRecordingSource(page);
  await recordingSupport(page, info);
  await openInjectedCapture(page);
  await page.evaluate(() => {
    window.__injectedCapture.installation = null;
  });
  await expect(allowInjectedSource(page)).rejects.toThrow(
    'Synthetic device injection is absent; refusing native device access',
  );
  expect(await page.evaluate(() => window.__injectedCapture.sources.length)).toBe(0);
  await page.reload();
  await expectInjectedSourceInstalled(page);
  expect(await page.evaluate(() => window.__injectedCapture.sources.length)).toBe(0);
});

test('real injected recording preserves moving video, decoded tone, trim, retake and submission disposal', async ({
  page,
}, info) => {
  await injectRecordingSource(page);
  test.skip(
    !(await recordingSupport(page, info)),
    'Engine cannot encode uploadable MP4; capability test verifies fallback',
  );
  await openInjectedCapture(page);
  await allowInjectedSource(page);
  await recordFor(page);
  const review = page.getByTestId('video-review');
  await expect(review).toBeVisible();
  await expect(review).toContainText(/Recorded .*360 × 640 portrait · audio included/);
  await expect(review).not.toContainText('FILE FALLBACK');
  await expectSourceStopped(page, 0);
  const encoded = await inspectRecording(page, info, 0);
  expect(encoded.streams.find((stream) => stream.codec_type === 'video')).toMatchObject({
    width: 360,
    height: 640,
  });
  expect(Number(encoded.format.duration)).toBeGreaterThan(5);
  expect(Number(encoded.format.duration)).toBeLessThan(9);

  const video = review.locator('video');
  await expect(video).toHaveJSProperty('playsInline', true);
  await expect(video).toHaveJSProperty('muted', false);
  await expect(video).toHaveJSProperty('volume', 1);
  await review.locator('input').nth(0).fill('1');
  await review.locator('input').nth(1).fill('4.5');
  await page.getByRole('button', { name: 'Save trim and mode', exact: true }).click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(1, 2);
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(1.2);
  // Read decoded VIDEO pixels, rather than trusting the injected canvas counter.
  const samplePixel = () =>
    video.evaluate((v: HTMLVideoElement) => {
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const drawing = canvas.getContext('2d')!;
      drawing.drawImage(v, 0, 0);
      return Array.from(drawing.getImageData(10, 10, 1, 1).data);
    });
  const firstPixel = await samplePixel();
  await page.waitForTimeout(400);
  expect(await samplePixel()).not.toEqual(firstPixel);
  // Observe audio DECODED BY THE REAL REVIEW PLAYER, in addition to FFmpeg PCM.
  const playerRms = await video.evaluate(async (v: HTMLVideoElement) => {
    const audio = new AudioContext();
    window.__injectedCapture.playbackAudio.push(audio);
    await audio.resume();
    const source = audio.createMediaElementSource(v);
    const analyser = audio.createAnalyser();
    source.connect(analyser).connect(audio.destination);
    const samples = new Float32Array(analyser.fftSize);
    await new Promise((resolve) => setTimeout(resolve, 200));
    analyser.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    // Keep the graph audible through playback; close only after player disposal.
    return rms;
  });
  expect(playerRms).toBeGreaterThan(0.05);
  await info.attach('review-player-decoded-audio', {
    body: JSON.stringify({ rms: playerRms }),
    contentType: 'application/json',
  });
  await page.getByRole('button', { name: 'Pause preview', exact: true }).click();
  await expect(video).toHaveJSProperty('paused', true);
  const paused = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await page.waitForTimeout(350);
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(paused, 2);
  await page.getByRole('button', { name: 'Back 5 seconds', exact: true }).click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(1, 2);
  await page.getByRole('button', { name: 'Forward 5 seconds', exact: true }).click();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeCloseTo(4.5, 2);
  await expect(video).toHaveJSProperty('paused', true);
  // Exercise the time-update trim boundary, not only the seek buttons.
  await video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 4.1;
  });
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThanOrEqual(4.5);
  await expect(video).toHaveJSProperty('paused', true);
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeCloseTo(4.5, 2);

  await page.getByRole('button', { name: 'Retake', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(page.getByTestId('video-review-player')).toHaveCount(0);
  await expectRevoked(page, 0);
  await page.evaluate(async () => {
    await Promise.all(window.__injectedCapture.playbackAudio.map((audio) => audio.close()));
  });
  await restoreInjectedPreview(page);
  await recordFor(page);
  await expect(review).toBeVisible();
  await expectSourceStopped(page, 1);
  await inspectRecording(page, info, 1);
  await review.locator('input').nth(0).fill('1');
  await review.locator('input').nth(1).fill('4.5');
  await page.getByRole('button', { name: 'Save trim and mode', exact: true }).click();
  const requestPromise = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/contributions/upload',
  );
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/contributions/upload',
  );
  await page.getByRole('button', { name: 'Upload clip', exact: true }).click();
  const body = (await requestPromise).postDataJSON();
  expect(body).toMatchObject({
    durationSeconds: 3.5,
    trimStartSeconds: 1,
    trimEndSeconds: 4.5,
    hasAudio: true,
    width: 360,
    height: 640,
    mimeType: 'video/mp4',
  });
  expect(body.sourceDurationSeconds).toBeGreaterThan(5);
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(201);
  await expect(review).toHaveCount(0);
  await expect(page.getByTestId('video-review-player')).toHaveCount(0);
  await expectRevoked(page, 1);
});

test('real landscape and overlong recordings reject separately, dispose sources and recover portrait capture', async ({
  page,
}, info) => {
  await injectRecordingSource(page);
  test.skip(
    !(await recordingSupport(page, info)),
    'Engine cannot encode uploadable MP4; capability test verifies fallback',
  );
  await openInjectedCapture(page);
  await page.evaluate(() => {
    window.__injectedCapture.shape = 'landscape';
  });
  await allowInjectedSource(page);
  await recordFor(page, 2);
  await expect(page.getByRole('alert')).toHaveText(
    'The browser recording must be portrait video. Turn your phone upright and try again.',
  );
  await expect(page.getByTestId('video-review')).toHaveCount(0);
  await expectSourceStopped(page, 0);
  const landscape = await inspectRecording(page, info, 0);
  expect(landscape.streams.find((stream) => stream.codec_type === 'video')).toMatchObject({
    width: 640,
    height: 360,
  });
  await expectRevoked(page, 0);
  await page.evaluate(() => {
    window.__injectedCapture.shape = 'portrait';
    window.__injectedCapture.delayDurationStop = true;
  });
  await restoreInjectedPreview(page);
  await page.getByTestId('video-record').click();
  await expect(page.getByTestId('video-recording')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('Recordings must be 15 seconds or shorter.', {
    timeout: 25_000,
  });
  await expect(page.getByTestId('video-review')).toHaveCount(0);
  await expectSourceStopped(page, 1);
  const overlong = await inspectRecording(page, info, 1);
  expect(Number(overlong.format.duration)).toBeGreaterThan(15);
  expect(overlong.streams.find((stream) => stream.codec_type === 'video')).toMatchObject({
    width: 360,
    height: 640,
  });
  await expectRevoked(page, 1);
  await page.evaluate(() => {
    window.__injectedCapture.delayDurationStop = false;
  });
  await restoreInjectedPreview(page);
  await recordFor(page, 2);
  await expect(page.getByTestId('video-review')).toBeVisible();
  await expectSourceStopped(page, 2);
  await inspectRecording(page, info, 2);
  await page.getByRole('button', { name: 'Retake', exact: true }).click();
  await expectRevoked(page, 2);
  await restoreInjectedPreview(page);
  // Leave the recovered live source through normal navigation; assert it stops too.
  await page.getByTestId('nav-home').click();
  await expectSourceStopped(page, 3);
});
