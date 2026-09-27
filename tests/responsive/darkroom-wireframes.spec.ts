import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('wireframe state labels remain text even when a select option contains markup', async ({
  page,
}) => {
  await page.setContent(readFileSync('doc/planning/darkroom-wireframes.html', 'utf8'));
  await page.selectOption('#page', 'home');
  const payload = '<img src=x onerror="document.body.dataset.injected=1">';
  await page.locator('#state').evaluate((element, value) => {
    const select = element as HTMLSelectElement;
    select.add(new Option(value, value));
  }, payload);
  await page.selectOption('#state', payload);
  await expect(page.locator('#roll-state')).toHaveText(payload.toUpperCase());
  await expect(page.locator('#screen img')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveAttribute('data-injected', '1');
  await page.selectOption('#state', 'collecting');
  await page.selectOption('#page', 'camera');
  await page.getByRole('button', { name: 'Simulate still review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review still' })).toBeVisible();
});
