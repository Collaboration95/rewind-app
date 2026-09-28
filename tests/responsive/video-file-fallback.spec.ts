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
  await expect(unsupported).toContainText(
    'This browser cannot record the MP4 format required for upload.',
  );
  await expect(unsupported).toContainText(
    'Choose a portrait MP4 no longer than 15 seconds with an audio track',
  );
}

async function openVideoRoute(page: Page) {
  await page.goto('/');
  const navigation = page.getByTestId('main-navigation');
  const entry = page.getByTestId('demo-entry-demo-1');
  const welcome = page.getByRole('heading', { name: 'Welcome to Rewind' });
  await expect(navigation.or(entry).or(welcome)).toBeVisible();
  if (await entry.isVisible()) {
    await entry.click();
  } else {
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

test('records from browser camera and microphone after the member action and uploads through the video API', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const mp4Bytes = Array.from(portraitMp4);
  await page.addInitScript((fixtureBytes) => {
    const target = window as typeof window & { __capturePromptCount?: number };
    target.__capturePromptCount = 0;
    let permissionGranted = false;
    const originalQuery = navigator.permissions.query.bind(navigator.permissions);
    Object.defineProperty(navigator.permissions, 'query', {
      configurable: true,
      value: (descriptor: PermissionDescriptor) => {
        if (descriptor.name === 'camera' || descriptor.name === 'microphone') {
          return Promise.resolve({
            onchange: null,
            state: permissionGranted ? 'granted' : 'prompt',
          } as PermissionStatus);
        }
        return originalQuery(descriptor);
      },
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        target.__capturePromptCount = (target.__capturePromptCount ?? 0) + 1;
        permissionGranted = true;
        const canvas = document.createElement('canvas');
        canvas.width = 720;
        canvas.height = 1280;
        const videoTrack = canvas.captureStream(10).getVideoTracks()[0];
        const audioContext = new AudioContext();
        const audioTrack = audioContext.createMediaStreamDestination().stream.getAudioTracks()[0];
        return new MediaStream([videoTrack, audioTrack]);
      },
    });
    const bytes = Uint8Array.from(fixtureBytes);
    class FixtureMediaRecorder {
      static isTypeSupported(type: string) {
        return type.startsWith('video/mp4');
      }
      state: RecordingState = 'inactive';
      mimeType = 'video/mp4';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob([bytes], { type: this.mimeType }) } as BlobEvent);
        this.onstop?.();
      }
    }
    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: FixtureMediaRecorder,
    });
  }, mp4Bytes);

  await openVideoRoute(page);
  await expect(page.getByTestId('video-permission')).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as typeof window & { __capturePromptCount?: number }).__capturePromptCount,
    ),
  ).toBe(0);
  await page.getByRole('button', { name: 'Allow camera and microphone' }).click();
  await expect(page.getByTestId('video-live-preview')).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as typeof window & { __capturePromptCount?: number }).__capturePromptCount,
    ),
  ).toBe(1);

  await page.getByTestId('video-record').click();
  await expect(page.getByTestId('video-recording')).toBeVisible();
  await page.getByRole('button', { name: 'Stop and review' }).click();
  const review = page.getByTestId('video-review');
  await expect(review).toBeVisible();
  await expect(review).toContainText('Recorded 2.3 seconds');

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
  const uploadResponse = await uploadResponsePromise;
  expect(uploadResponse.status(), await uploadResponse.text()).toBe(201);
  await expect(page.getByText('Upload queued as one pending contribution.')).toBeVisible();
});
