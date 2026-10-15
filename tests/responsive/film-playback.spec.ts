import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

import { openGroupHome, signedIn } from './helpers/real-account';

test.use({ ...signedIn, serviceWorkers: 'block' });

const filmId = 'film-playback-regression';
const cycleId = 'film-playback-cycle';
// A capability path in the runtime's shape (/media/access/<43 url-safe chars>).
const playbackPath = `/media/access/${'f'.repeat(43)}`;
const sample = readFileSync(resolve(process.cwd(), 'server/fixtures/sample-clip.mp4'));

// Match the runtime's byte-range endpoint so Chromium exposes a seekable MP4.
async function filmMedia(route: Route) {
  const range = route.request().headers().range;
  const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4' };
  if (!range) {
    await route.fulfill({
      status: 200,
      headers: { ...headers, 'Content-Length': String(sample.length) },
      body: sample,
    });
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  let start = match?.[1] ? Number(match[1]) : 0;
  let end = match?.[2] ? Number(match[2]) : sample.length - 1;
  if (match && !match[1] && match[2]) {
    start = Math.max(0, sample.length - Number(match[2]));
    end = sample.length - 1;
  }
  if (
    !match ||
    (!match[1] && !match[2]) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= sample.length ||
    end < start
  ) {
    await route.fulfill({
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${sample.length}` },
      body: '',
    });
    return;
  }
  end = Math.min(end, sample.length - 1);
  const body = sample.subarray(start, end + 1);
  await route.fulfill({
    status: 206,
    headers: {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${sample.length}`,
      'Content-Length': String(body.length),
    },
    body,
  });
}

// Keep the shared member's group unchanged. Only published metadata is supplied
// by this fixture; the actual Film/Expo view decodes the bundled MP4 in-browser.
async function publishedFilm(page: Page) {
  await page.route('**/api/archive?*', (route) =>
    route.fulfill({
      json: {
        archive: {
          films: [
            {
              id: filmId,
              cycleId,
              publishedAt: '2026-10-01T00:00:00Z',
              downloadPath: playbackPath,
              playbackPath,
            },
          ],
          clips: [],
        },
        pagination: {
          filmCursor: null,
          clipCursor: null,
          hasMoreFilms: false,
          hasMoreClips: false,
        },
      },
    }),
  );
  await page.route('**/api/cycles/*/premiere?*', (route) =>
    route.fulfill({
      json: {
        premiere: {
          state: 'ready',
          cycleId,
          filmId,
          playbackPath,
          segments: [0, 1, 2].map((startSeconds) => ({
            contributionId: `moment-${startSeconds}`,
            startSeconds,
            durationSeconds: 1,
            mine: true,
            hidden: false,
          })),
        },
      },
    }),
  );
  await page.route(`**/api${playbackPath}`, filmMedia);
}

async function openFilm(page: Page) {
  await openGroupHome(page);
  await page.getByTestId('real-group-nav-archive').click();
  await page.getByTestId(`real-archive-watch-${filmId}`).click();
  await expect(page.getByTestId('real-film')).toBeVisible();
}

for (const [width, height] of [
  [402, 874],
  [375, 667],
]) {
  test(`Film autoplays, pauses, seeks, replays and closes without media errors at ${width}×${height}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await publishedFilm(page);
    await openFilm(page);
    const video = page.locator('video');
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
      .toBeGreaterThanOrEqual(2);
    expect(await video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
    expect(await video.evaluate((v: HTMLVideoElement) => v.videoHeight)).toBeGreaterThan(0);
    await expect(video).toHaveJSProperty('paused', false);
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(video).toHaveJSProperty('paused', true);
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await page.getByTestId('real-film-next').click();
    await expect(video).toHaveJSProperty('currentTime', 1);
    await page.getByTestId('real-film-back').click();
    await expect(video).toHaveJSProperty('currentTime', 0);
    await expect(video).toHaveJSProperty('paused', true);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(video).toHaveJSProperty('paused', false);
    for (let index = 0; index < 3; index++) await page.getByTestId('real-film-next').click();
    await expect(page.getByTestId('real-film-end')).toBeVisible();
    await expect(video).toHaveJSProperty('paused', true);
    await page.getByTestId('real-film-replay').click();
    await expect(page.getByTestId('real-film-end')).toHaveCount(0);
    await expect(video).toHaveJSProperty('paused', false);
    await page.getByTestId('real-film-close').click();
    await expect(page.getByTestId('route-heading-archive')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('Film close cancels a play promise in the same browser task', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await publishedFilm(page);
  await openFilm(page);
  await expect(page.locator('video')).toHaveJSProperty('paused', false);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await page.evaluate(() => {
    (document.querySelector('[data-testid="real-film-pause"]') as HTMLElement).click();
    (document.querySelector('[data-testid="real-film-close"]') as HTMLElement).click();
  });
  await expect(page.getByTestId('route-heading-archive')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Film close while loading prevents a later canplay from starting playback', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await publishedFilm(page);
  let release!: () => void;
  const responseReady = new Promise<void>((done) => (release = done));
  let requested = false;
  await page.route(`**/api${playbackPath}`, async (route) => {
    requested = true;
    await responseReady;
    await filmMedia(route);
  });
  await openFilm(page);
  await expect.poll(() => requested).toBe(true);
  const closedVideo = await page.locator('video').elementHandle();
  expect(closedVideo).not.toBeNull();
  await expect(page.locator('video')).toHaveJSProperty('readyState', 0);
  await page.getByTestId('real-film-close').click();
  await expect(page.getByTestId('route-heading-archive')).toBeVisible();
  release();
  await expect
    .poll(() => closedVideo!.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(3);
  expect(await closedVideo!.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  expect(await closedVideo!.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(0);
  expect(errors).toEqual([]);
});
