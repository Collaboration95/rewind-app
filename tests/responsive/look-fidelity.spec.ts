import { expect, test, type Page, type Request } from '@playwright/test';

import { CAPTURE_MODES } from '../../src/domain/video';
import { openCapture, signedIn } from './helpers/real-account';

test.use({ ...signedIn, viewport: { width: 402, height: 874 } });
test.setTimeout(180_000);

/** Mean absolute 0–255 difference per RGB channel the live look may show against the sealed photo. */
const MAX_CHANNEL_DIFF = 8;

// A static white/orange camera: one deterministic frame, so preview and photo grade the same pixels.
async function installStaticCamera(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.permissions, 'query', {
      value: async () => ({ state: 'granted' }),
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 720;
        canvas.height = 1280;
        const ctx = canvas.getContext('2d')!;
        const draw = () => {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, 720, 1280);
          ctx.fillStyle = '#f08a24';
          ctx.fillRect(0, 760, 720, 520);
          ctx.beginPath();
          ctx.arc(360, 420, 170, 0, Math.PI * 2);
          ctx.fill();
        };
        draw();
        setInterval(draw, 100);
        return canvas.captureStream(10);
      },
    });
  });
}

/** Screenshot only the graded media layer, without controls or scrims on top. */
async function lookLayer(page: Page, testID: string): Promise<string> {
  const style = await page.addStyleTag({
    content: `body * { visibility: hidden !important; }
      [data-testid="${testID}"], [data-testid="${testID}"] * { visibility: visible !important; }`,
  });
  const shot = await page.screenshot({ animations: 'disabled' });
  await style.evaluate((node) => (node as HTMLElement).remove());
  return shot.toString('base64');
}

function sealedJpeg(request: Request): string | null {
  const body = request.postDataBuffer();
  if (!body) return null;
  if (body[0] === 0xff && body[1] === 0xd8) return body.toString('base64');
  const inline = /"(\/9j\/[A-Za-z0-9+/=]+)"/.exec(body.toString('utf8'));
  return inline ? inline[1] : null;
}

/** Per-channel mean absolute difference inside the displayed media rectangle. */
async function compare(page: Page, preview: string, sealed: string, fit: 'cover' | 'contain') {
  return page.evaluate(
    async ({ preview, sealed, fit }) => {
      const decode = async (base64: string, type: string) =>
        createImageBitmap(await (await fetch(`data:${type};base64,${base64}`)).blob());
      const width = innerWidth;
      const height = innerHeight;
      const shot = await decode(preview, 'image/png');
      const photo = await decode(sealed, 'image/jpeg');
      const scale = (fit === 'cover' ? Math.max : Math.min)(
        width / photo.width,
        height / photo.height,
      );
      const box = {
        w: photo.width * scale,
        h: photo.height * scale,
        x: (width - photo.width * scale) / 2,
        y: (height - photo.height * scale) / 2,
      };
      const pixels = (image: ImageBitmap, x: number, y: number, w: number, h: number) => {
        const ctx = new OffscreenCanvas(width, height).getContext('2d')!;
        ctx.drawImage(image, x, y, w, h);
        return ctx.getImageData(0, 0, width, height).data;
      };
      const a = pixels(shot, 0, 0, width, height);
      const b = pixels(photo, box.x, box.y, box.w, box.h);
      const x0 = Math.max(0, Math.ceil(box.x));
      const y0 = Math.max(0, Math.ceil(box.y));
      const x1 = Math.min(width, Math.floor(box.x + box.w));
      const y1 = Math.min(height, Math.floor(box.y + box.h));
      const sum = [0, 0, 0];
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const index = (y * width + x) * 4;
          for (let channel = 0; channel < 3; channel += 1) {
            sum[channel] += Math.abs(a[index + channel] - b[index + channel]);
          }
          count += 1;
        }
      }
      return sum.map((value) => Math.round((value / count) * 100) / 100);
    },
    { preview, sealed, fit },
  );
}

// The graded upload is aborted, so the shared member's moment allowance is not spent.
test('live and review looks match the sealed photo grading', async ({ page }) => {
  await installStaticCamera(page);
  const sealed: string[] = [];
  await page.route('**/*', (route) => {
    const jpeg = sealedJpeg(route.request());
    if (!jpeg) return route.fallback();
    sealed.push(jpeg);
    return route.abort();
  });
  await openCapture(page);
  const take = page.getByRole('button', { name: 'Take photo', exact: true });
  await expect(take).toBeEnabled();
  const live: string[] = [];
  for (const index of CAPTURE_MODES.keys()) {
    await page.getByTestId('photo-live-look-picker').getByRole('radio').nth(index).click();
    await page.waitForTimeout(500);
    live.push(await lookLayer(page, 'photo-live-look'));
  }

  await take.click();
  await expect(page.getByTestId('camera-preview-panel')).toBeVisible();
  const results: Record<string, { live: number[]; review: number[] }> = {};
  for (const [index, mode] of CAPTURE_MODES.entries()) {
    await page.getByTestId('camera-retro-look').getByRole('radio').nth(index).click();
    await page.waitForTimeout(800);
    const review = await lookLayer(page, 'photo-review-look');
    const before = sealed.length;
    await page.getByTestId('camera-seal').click();
    await expect.poll(() => sealed.length).toBeGreaterThan(before);
    await expect(page.getByTestId('camera-upload-failed')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Back to review', exact: true }).click();
    const photo = sealed[before];
    results[mode] = {
      live: await compare(page, live[index], photo, 'cover'),
      review: await compare(page, review, photo, 'contain'),
    };
  }
  console.log(JSON.stringify(results));
  for (const [mode, { live, review }] of Object.entries(results)) {
    for (const value of [...live, ...review]) {
      expect(value, `${mode} ${JSON.stringify({ live, review })}`).toBeLessThanOrEqual(
        MAX_CHANNEL_DIFF,
      );
    }
  }
});
