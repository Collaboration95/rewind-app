import * as FileSystem from 'expo-file-system/legacy';

import { CaptureFileLifecycleError, type PlatformStillImage } from '../src/capture/contracts';
import {
  ExpoCaptureFileStore,
  InMemoryCaptureFileStore,
  WebCaptureFileStore,
} from '../src/capture/file-store';

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///docs/',
  EncodingType: { Base64: 'base64' },
  makeDirectoryAsync: jest.fn(),
  writeAsStringAsync: jest.fn(),
  copyAsync: jest.fn(),
  getInfoAsync: jest.fn(),
  deleteAsync: jest.fn(),
  readAsStringAsync: jest.fn(),
}));

const fs = FileSystem as unknown as {
  documentDirectory: string | null;
  makeDirectoryAsync: jest.Mock;
  writeAsStringAsync: jest.Mock;
  copyAsync: jest.Mock;
  getInfoAsync: jest.Mock;
  deleteAsync: jest.Mock;
  readAsStringAsync: jest.Mock;
};

function image(overrides: Partial<PlatformStillImage> = {}): PlatformStillImage {
  return {
    format: 'jpg',
    height: 1,
    source: 'camera',
    sourceUri: 'file:///tmp/camera.jpg',
    width: 1,
    ...overrides,
  };
}

describe('ExpoCaptureFileStore', () => {
  const store = new ExpoCaptureFileStore();

  beforeEach(() => {
    fs.documentDirectory = 'file:///docs/';
    fs.makeDirectoryAsync.mockResolvedValue(undefined);
    fs.writeAsStringAsync.mockResolvedValue(undefined);
    fs.copyAsync.mockResolvedValue(undefined);
    fs.deleteAsync.mockResolvedValue(undefined);
    fs.readAsStringAsync.mockResolvedValue('QUJD');
    fs.getInfoAsync.mockResolvedValue({ exists: true, isDirectory: false, size: 42 });
  });

  it('refuses to copy when the platform has no app storage', async () => {
    fs.documentDirectory = null;
    await expect(store.copyToManagedCache(image(), 'cap-1')).rejects.toThrow(
      'App storage is unavailable',
    );
    expect(fs.makeDirectoryAsync).not.toHaveBeenCalled();
  });

  it.each(['../escape', 'a/b', 'with space', '', 'dot.name'])(
    'rejects the unsafe identifier %j before touching the file system',
    async (imageId) => {
      await expect(store.copyToManagedCache(image(), imageId)).rejects.toBeInstanceOf(
        CaptureFileLifecycleError,
      );
      expect(fs.makeDirectoryAsync).not.toHaveBeenCalled();
      expect(fs.copyAsync).not.toHaveBeenCalled();
    },
  );

  it('copies a native temp file into the app-owned folder and reports its size', async () => {
    const managed = await store.copyToManagedCache(image(), 'cap-1');

    expect(managed).toEqual({ uri: 'file:///docs/rewind-stills/cap-1.jpg', byteLength: 42 });
    expect(fs.makeDirectoryAsync).toHaveBeenCalledWith('file:///docs/rewind-stills/', {
      intermediates: true,
    });
    expect(fs.copyAsync).toHaveBeenCalledWith({
      from: 'file:///tmp/camera.jpg',
      to: 'file:///docs/rewind-stills/cap-1.jpg',
    });
    expect(fs.writeAsStringAsync).not.toHaveBeenCalled();
  });

  it('writes inline base64 verbatim when it carries no data-URL prefix', async () => {
    await store.copyToManagedCache(image({ base64: 'QUJD', format: 'png' }), 'cap-2');

    expect(fs.writeAsStringAsync).toHaveBeenCalledWith(
      'file:///docs/rewind-stills/cap-2.png',
      'QUJD',
      { encoding: 'base64' },
    );
    expect(fs.copyAsync).not.toHaveBeenCalled();
  });

  it('strips the data-URL header from base64 and from a data: source', async () => {
    await store.copyToManagedCache(
      image({ base64: 'data:image/jpeg;base64,REVG', sourceUri: 'file:///ignored' }),
      'cap-3',
    );
    expect(fs.writeAsStringAsync).toHaveBeenLastCalledWith(
      'file:///docs/rewind-stills/cap-3.jpg',
      'REVG',
      { encoding: 'base64' },
    );

    await store.copyToManagedCache(
      image({ sourceUri: 'data:image/jpeg;base64,R0hJ', base64: undefined }),
      'cap-4',
    );
    expect(fs.writeAsStringAsync).toHaveBeenLastCalledWith(
      'file:///docs/rewind-stills/cap-4.jpg',
      'R0hJ',
      { encoding: 'base64' },
    );
  });

  it.each([
    ['is missing', { exists: false }],
    ['is a directory', { exists: true, isDirectory: true, size: 10 }],
    ['is empty', { exists: true, isDirectory: false, size: 0 }],
  ])('deletes the copy and reports a verification failure when the file %s', async (_n, info) => {
    fs.getInfoAsync.mockResolvedValue(info);

    await expect(store.copyToManagedCache(image(), 'cap-5')).rejects.toThrow(
      'could not be verified in app storage',
    );
    expect(fs.deleteAsync).toHaveBeenCalledWith('file:///docs/rewind-stills/cap-5.jpg', {
      idempotent: true,
    });
  });

  it('turns a copy failure into a retryable message and cleans up the destination', async () => {
    fs.copyAsync.mockRejectedValue(new Error('ENOSPC'));

    const failure = await store.copyToManagedCache(image(), 'cap-6').catch((error) => error);

    expect(failure).toBeInstanceOf(CaptureFileLifecycleError);
    expect(failure.message).toContain('Try taking it again');
    expect(failure.message).not.toContain('ENOSPC');
    expect(fs.deleteAsync).toHaveBeenCalledWith('file:///docs/rewind-stills/cap-6.jpg', {
      idempotent: true,
    });
  });

  it('still reports the original failure when cleanup itself fails', async () => {
    fs.makeDirectoryAsync.mockRejectedValue(new Error('read-only'));
    fs.deleteAsync.mockRejectedValue(new Error('also broken'));

    await expect(store.copyToManagedCache(image(), 'cap-7')).rejects.toThrow('Try taking it again');
  });

  it('reports whether a stored file is a non-empty regular file', async () => {
    await expect(store.exists('file:///a.jpg')).resolves.toBe(true);

    fs.getInfoAsync.mockResolvedValue({ exists: false });
    await expect(store.exists('file:///a.jpg')).resolves.toBe(false);
    fs.getInfoAsync.mockResolvedValue({ exists: true, isDirectory: true, size: 5 });
    await expect(store.exists('file:///a.jpg')).resolves.toBe(false);
    fs.getInfoAsync.mockResolvedValue({ exists: true, isDirectory: false, size: 0 });
    await expect(store.exists('file:///a.jpg')).resolves.toBe(false);
    fs.getInfoAsync.mockRejectedValue(new Error('gone'));
    await expect(store.exists('file:///a.jpg')).resolves.toBe(false);
  });

  it('reads files as base64 and removes them idempotently', async () => {
    await expect(store.readAsBase64('file:///a.jpg')).resolves.toBe('QUJD');
    expect(fs.readAsStringAsync).toHaveBeenCalledWith('file:///a.jpg', { encoding: 'base64' });

    await store.remove('file:///a.jpg');
    expect(fs.deleteAsync).toHaveBeenCalledWith('file:///a.jpg', { idempotent: true });
  });

  it('resolves an existing managed file by identifier and format', async () => {
    await expect(store.resolveManagedFile('cap-8', 'png')).resolves.toEqual({
      uri: 'file:///docs/rewind-stills/cap-8.png',
      byteLength: 42,
    });
  });

  it('resolves to null for unusable identifiers, missing storage, or bad files', async () => {
    await expect(store.resolveManagedFile('../x', 'jpg')).resolves.toBeNull();
    expect(fs.getInfoAsync).not.toHaveBeenCalled();

    fs.getInfoAsync.mockResolvedValue({ exists: false });
    await expect(store.resolveManagedFile('cap-9', 'jpg')).resolves.toBeNull();
    fs.getInfoAsync.mockResolvedValue({ exists: true, isDirectory: false, size: 0 });
    await expect(store.resolveManagedFile('cap-9', 'jpg')).resolves.toBeNull();
    fs.getInfoAsync.mockRejectedValue(new Error('io'));
    await expect(store.resolveManagedFile('cap-9', 'jpg')).resolves.toBeNull();

    fs.documentDirectory = null;
    await expect(store.resolveManagedFile('cap-9', 'jpg')).resolves.toBeNull();
  });
});

describe('InMemoryCaptureFileStore', () => {
  it('stores, resolves, reads and removes captures keyed by id and format', async () => {
    const store = new InMemoryCaptureFileStore();
    const managed = await store.copyToManagedCache(image({ base64: 'QUJDREVG' }), 'm-1');

    expect(managed).toEqual({ uri: 'memory://rewind-stills/m-1.jpg', byteLength: 6 });
    expect(store.size).toBe(1);
    expect(store.has(managed.uri)).toBe(true);
    await expect(store.exists(managed.uri)).resolves.toBe(true);
    await expect(store.readAsBase64(managed.uri)).resolves.toBe('QUJDREVG');
    await expect(store.resolveManagedFile('m-1', 'jpg')).resolves.toEqual(managed);
    await expect(store.resolveManagedFile('m-1', 'png')).resolves.toBeNull();

    await store.remove(managed.uri);
    expect(store.size).toBe(0);
    await expect(store.exists(managed.uri)).resolves.toBe(false);
    await expect(store.resolveManagedFile('m-1', 'jpg')).resolves.toBeNull();
  });

  it('falls back to a one-byte placeholder when the capture has no inline data', async () => {
    const store = new InMemoryCaptureFileStore();
    const managed = await store.copyToManagedCache(image({ format: 'png' }), 'm-2');

    expect(managed.byteLength).toBe(1);
    await expect(store.readAsBase64(managed.uri)).resolves.toBe('AQID');
  });

  it('rejects reads of unknown captures with a lifecycle error', async () => {
    await expect(
      new InMemoryCaptureFileStore().readAsBase64('memory://missing'),
    ).rejects.toBeInstanceOf(CaptureFileLifecycleError);
  });
});

/** A just-enough IndexedDB: one object store, async request/transaction events. */
function installFakeIndexedDB(
  behaviour: { failOpen?: boolean; failWrite?: boolean; failRead?: boolean } = {},
) {
  const data = new Map<string, unknown>();
  let upgrades = 0;
  const open = jest.fn(() => {
    const request: {
      result?: unknown;
      error?: Error;
      onsuccess?: () => void;
      onerror?: () => void;
      onupgradeneeded?: () => void;
    } = {};
    const database = {
      createObjectStore: jest.fn(),
      transaction: () => {
        const tx: { error?: Error; oncomplete?: () => void; onerror?: () => void } = {};
        const settle = (fail: boolean) =>
          void Promise.resolve().then(() => {
            if (fail) {
              tx.error = new Error('write failed');
              tx.onerror?.();
            } else {
              tx.oncomplete?.();
            }
          });
        return Object.assign(tx, {
          objectStore: () => ({
            put: (value: unknown, key: string) => {
              if (!behaviour.failWrite) data.set(key, value);
              settle(Boolean(behaviour.failWrite));
            },
            delete: (key: string) => {
              if (!behaviour.failWrite) data.delete(key);
              settle(Boolean(behaviour.failWrite));
            },
            clear: () => {
              if (!behaviour.failWrite) data.clear();
              settle(Boolean(behaviour.failWrite));
            },
            get: (key: string) => {
              const read: {
                result?: unknown;
                error?: Error;
                onsuccess?: () => void;
                onerror?: () => void;
              } = {};
              void Promise.resolve().then(() => {
                if (behaviour.failRead) {
                  read.error = new Error('read failed');
                  read.onerror?.();
                } else {
                  read.result = data.get(key);
                  read.onsuccess?.();
                }
              });
              return read;
            },
          }),
        });
      },
    };
    request.result = database;
    void Promise.resolve().then(() => {
      if (behaviour.failOpen) {
        request.error = new Error('open blocked');
        request.onerror?.();
        return;
      }
      if (upgrades++ === 0) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open } });
  return { data, open, upgrades: () => upgrades };
}

const jpeg = (base64 = btoa('hello')): PlatformStillImage =>
  image({ base64, sourceUri: 'data:image/jpeg;base64,' + base64 });

describe('WebCaptureFileStore', () => {
  const originalFetch = globalThis.fetch;
  const originalCreateObjectURL = URL.createObjectURL;
  let objectUrls: number;

  beforeEach(() => {
    objectUrls = 0;
    jest.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:rewind-${++objectUrls}`);
    jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  afterEach(() => {
    WebCaptureFileStore.resetAll();
    Reflect.deleteProperty(globalThis, 'indexedDB');
    jest.restoreAllMocks();
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectURL,
    });
  });

  it('round-trips the exact bytes through a blob and reads them back as base64', async () => {
    const store = new WebCaptureFileStore();
    const managed = await store.copyToManagedCache(jpeg(), 'w-1');

    expect(managed).toEqual({ uri: 'blob:rewind-1', byteLength: 5 });
    await expect(store.exists(managed.uri)).resolves.toBe(true);
    await expect(store.readAsBase64(managed.uri)).resolves.toBe(btoa('hello'));
  });

  it('decodes a data: source without separate base64, preferring explicit base64 when given', async () => {
    const store = new WebCaptureFileStore();
    const fromDataUrl = await store.copyToManagedCache(
      image({ sourceUri: `data:image/png;base64,${btoa('abcd')}`, format: 'png' }),
      'w-2',
    );
    expect(fromDataUrl.byteLength).toBe(4);

    const fromBase64 = await store.copyToManagedCache(
      image({ base64: btoa('xyz'), sourceUri: 'blob:ignored' }),
      'w-3',
    );
    expect(fromBase64.byteLength).toBe(3);
  });

  it('fetches blob: sources that carry no inline data', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, blob: async () => new Blob(['12345678']) });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });
    const store = new WebCaptureFileStore();

    const managed = await store.copyToManagedCache(image({ sourceUri: 'blob:capture' }), 'w-4');

    expect(fetchMock).toHaveBeenCalledWith('blob:capture');
    expect(managed.byteLength).toBe(8);
  });

  it.each([
    ['the capture URL cannot be fetched', () => ({ ok: false, blob: async () => new Blob(['x']) })],
    ['the fetched blob is empty', () => ({ ok: true, blob: async () => new Blob([]) })],
  ])('wraps the failure when %s', async (_name, response) => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: jest.fn().mockResolvedValue(response()),
    });
    const store = new WebCaptureFileStore();

    await expect(
      store.copyToManagedCache(image({ sourceUri: 'blob:capture' }), 'w-5'),
    ).rejects.toThrow('could not be saved in browser storage');
    await expect(store.resolveManagedFile('w-5', 'jpg')).resolves.toBeNull();
  });

  it('rejects empty or corrupt inline encodings without recording anything', async () => {
    const store = new WebCaptureFileStore();
    await expect(
      store.copyToManagedCache(image({ sourceUri: 'data:image/jpeg;base64,' }), 'w-6'),
    ).rejects.toThrow('could not be saved in browser storage');
    await expect(
      store.copyToManagedCache(image({ base64: '***not base64***' }), 'w-6'),
    ).rejects.toThrow('could not be saved in browser storage');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('rejects unsafe identifiers with a lifecycle error', async () => {
    await expect(
      new WebCaptureFileStore().copyToManagedCache(jpeg(), 'a/b'),
    ).rejects.toBeInstanceOf(CaptureFileLifecycleError);
  });

  it('uses an in-store webblob URI when object URLs are unsupported or throw', async () => {
    const store = new WebCaptureFileStore();

    (URL.createObjectURL as jest.Mock).mockImplementation(() => {
      throw new Error('no blob urls');
    });
    const thrown = await store.copyToManagedCache(jpeg(), 'w-7');
    expect(thrown.uri).toBe('webblob://rewind-stills/w-7.jpg');
    await expect(store.readAsBase64(thrown.uri)).resolves.toBe(btoa('hello'));

    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: undefined });
    const missing = await store.copyToManagedCache(jpeg(), 'w-8');
    expect(missing.uri).toBe('webblob://rewind-stills/w-8.jpg');

    // webblob URIs are not object URLs, so removal must not try to revoke them.
    await store.remove(thrown.uri);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await expect(store.exists(thrown.uri)).resolves.toBe(false);
  });

  it('treats unknown URIs as missing', async () => {
    const store = new WebCaptureFileStore();
    await expect(store.exists('blob:unknown')).resolves.toBe(false);
    await expect(store.readAsBase64('blob:unknown')).rejects.toBeInstanceOf(
      CaptureFileLifecycleError,
    );
    await expect(store.remove('blob:unknown')).resolves.toBeUndefined();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('revokes the object URL and forgets the capture on remove', async () => {
    const store = new WebCaptureFileStore();
    const managed = await store.copyToManagedCache(jpeg(), 'w-9');

    await store.remove(managed.uri);

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(managed.uri);
    await expect(store.exists(managed.uri)).resolves.toBe(false);
    await expect(store.resolveManagedFile('w-9', 'jpg')).resolves.toBeNull();
  });

  it('resolves a pending capture for the same store without minting a new URL', async () => {
    const store = new WebCaptureFileStore();
    const managed = await store.copyToManagedCache(jpeg(), 'w-10');

    await expect(store.resolveManagedFile('w-10', 'jpg')).resolves.toEqual(managed);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('lets another store instance adopt a capture made by the first', async () => {
    const first = new WebCaptureFileStore();
    const second = new WebCaptureFileStore();
    const managed = await first.copyToManagedCache(jpeg(), 'w-11');

    const adopted = await second.resolveManagedFile('w-11', 'jpg');

    expect(adopted).toEqual({ uri: 'blob:rewind-2', byteLength: 5 });
    await expect(second.readAsBase64(adopted!.uri)).resolves.toBe(btoa('hello'));
    // The original handle stays valid for the store that made it.
    await expect(first.exists(managed.uri)).resolves.toBe(true);
  });

  it('returns null when nothing is pending or persisted', async () => {
    await expect(new WebCaptureFileStore().resolveManagedFile('never', 'jpg')).resolves.toBeNull();
  });

  it('revokes every blob URL and drops all captures on resetAll', async () => {
    const a = new WebCaptureFileStore();
    const b = new WebCaptureFileStore();
    const one = await a.copyToManagedCache(jpeg(), 'w-12');
    const two = await b.copyToManagedCache(jpeg(), 'w-13');

    WebCaptureFileStore.resetAll();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(one.uri);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(two.uri);
    await expect(a.exists(one.uri)).resolves.toBe(false);
    await expect(b.exists(two.uri)).resolves.toBe(false);
    await expect(a.resolveManagedFile('w-12', 'jpg')).resolves.toBeNull();
  });

  describe('with persistent storage', () => {
    it('persists captures so a fresh session can restore them after a reload', async () => {
      const db = installFakeIndexedDB();
      const store = new WebCaptureFileStore();
      await store.copyToManagedCache(jpeg(btoa('persisted')), 'p-1');
      expect(db.data.get('p-1')).toBeInstanceOf(Blob);
      expect(db.upgrades()).toBe(1);

      WebCaptureFileStore.resetAll(); // page reload: in-memory state is gone
      const restored = await new WebCaptureFileStore().resolveManagedFile('p-1', 'jpg');

      expect(restored).toMatchObject({ byteLength: 9 });
    });

    it('deletes the persisted copy when the capture is removed', async () => {
      const db = installFakeIndexedDB();
      const store = new WebCaptureFileStore();
      const managed = await store.copyToManagedCache(jpeg(), 'p-2');

      await store.remove(managed.uri);

      expect(db.data.has('p-2')).toBe(false);
    });

    it('clearPersistent wipes everything stored', async () => {
      const db = installFakeIndexedDB();
      await new WebCaptureFileStore().copyToManagedCache(jpeg(), 'p-3');
      expect(db.data.size).toBe(1);

      await WebCaptureFileStore.clearPersistent();

      expect(db.data.size).toBe(0);
    });

    it('ignores persisted values that are not blobs', async () => {
      const db = installFakeIndexedDB();
      db.data.set('p-4', 'not a blob');

      await expect(new WebCaptureFileStore().resolveManagedFile('p-4', 'jpg')).resolves.toBeNull();
    });

    it('fails the capture when the database refuses the write', async () => {
      installFakeIndexedDB({ failWrite: true });
      const store = new WebCaptureFileStore();

      await expect(store.copyToManagedCache(jpeg(), 'p-5')).rejects.toThrow(
        'could not be saved in browser storage',
      );
      await expect(store.resolveManagedFile('p-5', 'jpg')).resolves.toBeNull();
    });

    it('fails the capture when the database cannot be opened', async () => {
      installFakeIndexedDB({ failOpen: true });

      await expect(new WebCaptureFileStore().copyToManagedCache(jpeg(), 'p-6')).rejects.toThrow(
        'could not be saved in browser storage',
      );
    });

    it('surfaces read errors when restoring a persisted capture', async () => {
      installFakeIndexedDB({ failRead: true });

      await expect(new WebCaptureFileStore().resolveManagedFile('p-7', 'jpg')).rejects.toThrow(
        'read failed',
      );
    });

    it('surfaces clear failures from clearPersistent', async () => {
      installFakeIndexedDB({ failWrite: true });

      await expect(WebCaptureFileStore.clearPersistent()).rejects.toThrow('write failed');
    });
  });

  it('clearPersistent is a no-op without IndexedDB', async () => {
    await expect(WebCaptureFileStore.clearPersistent()).resolves.toBeUndefined();
  });
});
