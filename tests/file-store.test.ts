import { WebCaptureFileStore } from '../src/capture/file-store';
import type { PlatformStillImage } from '../src/capture/contracts';

const webImage: PlatformStillImage = {
  base64: 'AA==',
  format: 'jpg',
  height: 1,
  source: 'camera',
  sourceUri: 'data:image/jpeg;base64,AA==',
  width: 1,
};

describe('WebCaptureFileStore', () => {
  it('stores, verifies, and removes a browser data-URL capture as a Blob', async () => {
    const store = new WebCaptureFileStore();
    const managed = await store.copyToManagedCache(webImage, 'web-capture');

    expect(managed.byteLength).toBeGreaterThan(0);
    await expect(store.exists(managed.uri)).resolves.toBe(true);
    await store.remove(managed.uri);
    await expect(store.exists(managed.uri)).resolves.toBe(false);
  });

  it('rejects invalid capture identifiers before creating browser state', async () => {
    const store = new WebCaptureFileStore();
    await expect(store.copyToManagedCache(webImage, '../outside')).rejects.toThrow(
      'capture identifier is invalid',
    );
  });
});
