import { expect, test, type APIRequestContext } from '@playwright/test';

test('deep application routes return the exported web shell', async ({ page }) => {
  const response = await page.goto('/groups/demo-group/capsule');

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
