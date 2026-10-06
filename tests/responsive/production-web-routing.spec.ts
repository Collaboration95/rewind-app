import { expect, test, type APIRequestContext } from '@playwright/test';

test('fresh web install offers only real-account entry, with no Demo', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByTestId('welcome-entry')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create an account' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Try Demo/i })).toHaveCount(0);
  await expect(page.getByTestId('demo-entry-demo-1')).toHaveCount(0);
  await expect(page.getByText(/Demo member/i)).toHaveCount(0);

  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('real-account-username')).toBeVisible();
  await expect(page.getByRole('button', { name: /Try Demo/i })).toHaveCount(0);
});

test('mobile welcome keeps the brand and entry actions together and vertically balanced', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const brand = await page.getByTestId('entry-brand').boundingBox();
  const actions = await page.getByTestId('welcome-entry').boundingBox();
  expect(brand).not.toBeNull();
  expect(actions).not.toBeNull();

  const gap = actions!.y - (brand!.y + brand!.height);
  const contentCenter = (brand!.y + actions!.y + actions!.height) / 2;
  expect(gap).toBeLessThan(96);
  expect(actions!.y + actions!.height).toBeLessThanOrEqual(844);
  expect(Math.abs(contentCenter - 844 / 2)).toBeLessThan(120);
});

test('mobile signup starts close to the brand without a large empty band', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account' }).click();

  const heading = await page.getByRole('heading', { name: 'Create account' }).boundingBox();
  const username = await page.getByText('Username', { exact: true }).boundingBox();
  expect(heading).not.toBeNull();
  expect(username).not.toBeNull();
  expect(heading!.y).toBeLessThan(120);
  expect(username!.y - (heading!.y + heading!.height)).toBeLessThan(64);
});

test('web entry opens account registration and blocks credentials without HTTPS configuration', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible();
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByTestId('registration-password')).toBeVisible();
  await expect(page.getByLabel('Confirm password')).toBeVisible();
  await expect(
    page.getByText(/account creation requires the same-origin HTTPS service/i),
  ).toBeVisible();
  await expect(page.getByTestId('registration-submit')).toBeDisabled();

  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(
    page.getByText(/password will not be sent over an insecure connection/i),
  ).toBeVisible();
  await expect(page.getByTestId('real-account-submit')).toBeDisabled();
});

test('deep application routes return the exported web shell', async ({ page }) => {
  const response = await page.goto('/groups/any-group/archive');

  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-type']).toContain('text/html');
  await expect(page.locator('#root')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('runtime_unavailable');
});

test('same-origin API proxy reaches the runtime and preserves its status', async ({ request }) => {
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  expect(health.headers()['content-type']).toContain('application/json');
  expect(health.headers()['cache-control']).toBe('no-store');
  await expect(health.json()).resolves.toMatchObject({
    ok: true,
    service: 'rewind-local-runtime',
  });

  const missing = await request.get('/api/route-that-does-not-exist');
  expect(missing.status()).toBe(404);
  expect(missing.headers()['content-type']).toContain('application/json');
  expect(missing.headers()['cache-control']).toBe('no-store');
  const missingBody = await missing.text();
  expect(missingBody).not.toContain('<!DOCTYPE html>');
  expect(missingBody).not.toContain('index.html');
  expect(missingBody).not.toContain('/app/');
});

test('the exported shell exposes install metadata and an honest offline API fallback', async ({
  context,
  page,
  request,
}) => {
  const manifestResponse = await request.get('/manifest.json');
  expect(manifestResponse.status()).toBe(200);
  expect(manifestResponse.headers()['content-type']).toContain('application/json');
  await expect(manifestResponse.json()).resolves.toMatchObject({
    display: 'standalone',
    name: 'Rewind',
    start_url: '/',
    theme_color: '#f6ede3',
  });

  const serviceWorkerResponse = await request.get('/sw.js');
  expect(serviceWorkerResponse.status()).toBe(200);
  expect(await serviceWorkerResponse.text()).toContain(
    'Server-backed actions are unavailable offline',
  );

  await page.goto('/');
  await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller));
  await context.setOffline(true);
  try {
    const offlineHealth = await page.evaluate(async () => {
      const response = await fetch('/api/health');
      return { body: await response.json(), status: response.status };
    });
    expect(offlineHealth.status).toBe(503);
    expect(offlineHealth.body).toMatchObject({ error: 'runtime_unavailable' });
    expect(offlineHealth.body.message).toContain('unavailable offline');
  } finally {
    await context.setOffline(false);
  }
});

test('the installed shell reloads root and starts a deep SPA route offline', async ({
  context,
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller));
  await expect(page.locator('#root')).toContainText('Rewind');

  let deepPage: Awaited<ReturnType<typeof context.newPage>> | undefined;
  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#root')).toContainText('Rewind');

    deepPage = await context.newPage();
    await deepPage.goto('/groups/any-group/archive', { waitUntil: 'domcontentloaded' });
    expect(new URL(deepPage.url()).pathname).toBe('/groups/any-group/archive');
    await expect(deepPage.locator('#root')).toContainText('Rewind');
  } finally {
    await deepPage?.close();
    await context.setOffline(false);
  }
});

test('the shell is uncached while Expo assets are immutable', async ({ request }) => {
  const shell = await request.get('/');
  expect(shell.status()).toBe(200);
  expect(shell.headers()['cache-control']).toBe('no-store');

  const assetPath = await findExportedAsset(request);
  const asset = await request.get(assetPath);
  expect(asset.status()).toBe(200);
  expect(asset.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
});

test('the smoke boundary is local-only and does not require a cloud endpoint', async ({ page }) => {
  await page.goto('/');
  expect(new URL(page.url()).hostname).toBe('127.0.0.1');
  const runtime = await page.request.get('/api/health');
  expect(new URL(runtime.url()).hostname).toBe('127.0.0.1');
});

async function findExportedAsset(request: APIRequestContext) {
  const index = await request.get('/');
  const html = await index.text();
  const match = html.match(/(?:src|href)="([^"]+\.(?:js|css))"/);
  if (!match?.[1]) throw new Error('The Expo export did not reference a JS or CSS asset.');
  return match[1];
}
