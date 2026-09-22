import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

import {
  ArchiveDownloadError,
  createArchiveDownloadQueue,
  downloadReleasedArchiveMedia,
} from '../src/archive/archive-download';
import { getReleasedArchiveFilename, type ReleasedArchiveMedia } from '../src/domain/archive';

const films: ReleasedArchiveMedia[] = [
  {
    id: 'film-1',
    cycleId: 'cycle-2026-09-18',
    publishedAt: '2026-09-18T19:00:00.000Z',
    downloadUrl: 'https://runtime.test/films/film-1/download',
  },
  {
    id: 'film-2',
    cycleId: 'cycle-2026-09-25',
    publishedAt: '2026-09-25T19:00:00.000Z',
    downloadUrl: 'https://runtime.test/films/film-2/download',
  },
];

const clips: ReleasedArchiveMedia[] = [
  {
    id: 'clip-1',
    contributionId: 'contribution-1',
    cycleId: 'cycle-2026-09-18',
    createdAt: '2026-09-18T08:15:00.000Z',
    downloadUrl: 'https://runtime.test/clips/clip-1/download',
  },
  {
    id: 'clip-2',
    contributionId: 'contribution-2',
    cycleId: 'cycle-2026-09-25',
    createdAt: '2026-09-25T08:15:00.000Z',
    downloadUrl: 'https://runtime.test/clips/clip-2/download',
  },
];

describe('archive download naming and delivery', () => {
  const originalDocument = (globalThis as { document?: unknown }).document;
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
    }
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  it('gives two films and two personal clips distinct cycle/date filenames', () => {
    const filenames = [...films, ...clips].map(getReleasedArchiveFilename);

    expect(filenames).toEqual([
      'rewind-group-film-cycle-2026-09-18-2026-09-18-film-1.mp4',
      'rewind-group-film-cycle-2026-09-25-2026-09-25-film-2.mp4',
      'rewind-personal-clip-cycle-2026-09-18-2026-09-18-clip-1.mp4',
      'rewind-personal-clip-cycle-2026-09-25-2026-09-25-clip-2.mp4',
    ]);
    expect(new Set(filenames).size).toBe(4);
  });

  it('downloads native media to unique cache paths', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    Object.defineProperty(FileSystem, 'cacheDirectory', {
      configurable: true,
      value: 'file:///cache/',
    });
    const makeDirectoryAsync = jest
      .spyOn(FileSystem, 'makeDirectoryAsync')
      .mockResolvedValue(undefined);
    const downloadAsync = jest
      .spyOn(FileSystem, 'downloadAsync')
      .mockImplementation(async (url, fileUri) => ({
        headers: {},
        mimeType: 'video/mp4',
        status: 200,
        uri: fileUri,
        md5: undefined,
      }));

    await Promise.all([...films, ...clips].map(downloadReleasedArchiveMedia));

    expect(makeDirectoryAsync).toHaveBeenCalledTimes(4);
    expect(downloadAsync).toHaveBeenCalledTimes(4);
    const destinations = downloadAsync.mock.calls.map(([, destination]) => destination);
    expect(new Set(destinations).size).toBe(4);
    expect(destinations).toEqual([
      'file:///cache/rewind-archive/rewind-group-film-cycle-2026-09-18-2026-09-18-film-1.mp4',
      'file:///cache/rewind-archive/rewind-group-film-cycle-2026-09-25-2026-09-25-film-2.mp4',
      'file:///cache/rewind-archive/rewind-personal-clip-cycle-2026-09-18-2026-09-18-clip-1.mp4',
      'file:///cache/rewind-archive/rewind-personal-clip-cycle-2026-09-25-2026-09-25-clip-2.mp4',
    ]);
  });

  it('rejects a native non-success response and removes its downloaded error body', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    Object.defineProperty(FileSystem, 'cacheDirectory', {
      configurable: true,
      value: 'file:///cache/',
    });
    jest.spyOn(FileSystem, 'makeDirectoryAsync').mockResolvedValue(undefined);
    const destination =
      'file:///cache/rewind-archive/rewind-group-film-cycle-2026-09-18-2026-09-18-film-1.mp4';
    jest.spyOn(FileSystem, 'downloadAsync').mockResolvedValue({
      headers: {},
      mimeType: 'application/json',
      status: 403,
      uri: destination,
      md5: undefined,
    });
    const deleteAsync = jest.spyOn(FileSystem, 'deleteAsync').mockResolvedValue(undefined);

    const download = downloadReleasedArchiveMedia(films[0]);
    await expect(download).rejects.toBeInstanceOf(ArchiveDownloadError);
    await expect(download).rejects.toThrow('The authorized media download failed with HTTP 403.');
    expect(deleteAsync).toHaveBeenCalledWith(destination, { idempotent: true });
  });

  it('preserves the native HTTP failure when error-body cleanup also fails', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    Object.defineProperty(FileSystem, 'cacheDirectory', {
      configurable: true,
      value: 'file:///cache/',
    });
    jest.spyOn(FileSystem, 'makeDirectoryAsync').mockResolvedValue(undefined);
    jest.spyOn(FileSystem, 'downloadAsync').mockResolvedValue({
      headers: {},
      mimeType: 'text/plain',
      status: 500,
      uri: 'file:///cache/rewind-archive/error-response',
      md5: undefined,
    });
    const cleanupFailure = new Error('cleanup failed');
    const deleteAsync = jest.spyOn(FileSystem, 'deleteAsync').mockRejectedValue(cleanupFailure);

    await expect(downloadReleasedArchiveMedia(clips[0])).rejects.toEqual(
      expect.objectContaining({
        message: 'The authorized media download failed with HTTP 500.',
        name: 'ArchiveDownloadError',
      }),
    );
    expect(deleteAsync).toHaveBeenCalledWith(
      `file:///cache/rewind-archive/${getReleasedArchiveFilename(clips[0])}`,
      { idempotent: true },
    );
  });

  it('uses an anchor download on the browser', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const mediaBlob = new Blob(['film'], { type: 'video/mp4' });
    const fetchMedia = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      blob: jest.fn().mockResolvedValue(mediaBlob),
      ok: true,
      status: 200,
    } as unknown as Response);
    const createObjectURL = jest
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:rewind-film-1');
    const revokeObjectURL = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = jest.fn();
    const remove = jest.fn();
    const anchor = { click, download: '', href: '', remove, style: {} };
    const appendChild = jest.fn();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        body: { appendChild },
        createElement: jest.fn(() => anchor),
      },
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { open: jest.fn() },
    });

    await expect(downloadReleasedArchiveMedia(films[0])).resolves.toMatchObject({
      method: 'browser',
      uri: films[0].downloadUrl,
      filename: getReleasedArchiveFilename(films[0]),
    });

    expect(fetchMedia).toHaveBeenCalledWith(films[0].downloadUrl);
    expect(createObjectURL).toHaveBeenCalledWith(mediaBlob);
    expect(click).toHaveBeenCalledTimes(1);
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:rewind-film-1');
    expect(anchor.href).toBe('blob:rewind-film-1');
    expect(anchor.download).toBe(getReleasedArchiveFilename(films[0]));
  });

  it('rejects non-success HTTP responses without opening the authorized URL', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const fetchMedia = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      blob: jest.fn(),
      ok: false,
      status: 403,
    } as unknown as Response);
    const createObjectURL = jest.spyOn(URL, 'createObjectURL');
    const click = jest.fn();
    const remove = jest.fn();
    const open = jest.fn().mockReturnValue({});
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        body: { appendChild: jest.fn() },
        createElement: jest.fn(() => ({ click, download: '', remove, style: {} })),
      },
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { open },
    });

    await expect(downloadReleasedArchiveMedia(films[0])).rejects.toThrow(
      'The authorized media download failed with HTTP 403.',
    );

    expect(fetchMedia).toHaveBeenCalledWith(films[0].downloadUrl);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it('removes the anchor and revokes the object URL when triggering the download fails', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const mediaBlob = new Blob(['clip'], { type: 'video/mp4' });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      blob: jest.fn().mockResolvedValue(mediaBlob),
      ok: true,
      status: 200,
    } as unknown as Response);
    jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:rewind-clip-1');
    const revokeObjectURL = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clickFailure = new Error('download click failed');
    const click = jest.fn(() => {
      throw clickFailure;
    });
    const remove = jest.fn();
    const anchor = { click, download: '', remove, style: {} };
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        body: { appendChild: jest.fn() },
        createElement: jest.fn(() => anchor),
      },
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { open: jest.fn() },
    });

    await expect(downloadReleasedArchiveMedia(clips[0])).rejects.toBe(clickFailure);
    expect(anchor.download).toBe(getReleasedArchiveFilename(clips[0]));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:rewind-clip-1');
  });

  it('opens the authorized URL when browser download attributes are unavailable', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const fetchMedia = jest.spyOn(globalThis, 'fetch');
    const fallbackAnchor = { click: jest.fn() };
    const open = jest.fn().mockReturnValue({});
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: jest.fn(() => fallbackAnchor) },
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { open },
    });

    await expect(downloadReleasedArchiveMedia(clips[0])).resolves.toMatchObject({
      method: 'browser',
      uri: clips[0].downloadUrl,
    });
    expect(open).toHaveBeenCalledWith(clips[0].downloadUrl, '_blank', 'noopener,noreferrer');
    expect(fetchMedia).not.toHaveBeenCalled();
    expect(fallbackAnchor.click).not.toHaveBeenCalled();
  });

  it('serializes different items and coalesces repeated taps for one item', async () => {
    let releaseFirst!: () => void;
    const download = jest.fn(
      (media: ReleasedArchiveMedia) =>
        new Promise<{ filename: string; method: 'native'; uri: string }>((resolve) => {
          if (media.id === films[0].id) {
            releaseFirst = () =>
              resolve({
                filename: getReleasedArchiveFilename(media),
                method: 'native',
                uri: `file://${media.id}`,
              });
          } else {
            resolve({
              filename: getReleasedArchiveFilename(media),
              method: 'native',
              uri: `file://${media.id}`,
            });
          }
        }),
    );
    const queue = createArchiveDownloadQueue(download);
    const first = queue(films[0]);
    const repeated = queue(films[0]);
    const second = queue(films[1]);

    await Promise.resolve();
    expect(repeated).toBe(first);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith(films[0]);

    releaseFirst();
    await first;
    await second;

    expect(download).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenNthCalledWith(2, films[1]);
  });

  it('rejects when the browser cannot open the fallback URL', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const fallbackAnchor = { click: jest.fn() };
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: jest.fn(() => fallbackAnchor) },
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { open: jest.fn().mockReturnValue(null) },
    });

    await expect(downloadReleasedArchiveMedia(films[0])).rejects.toThrow(
      'The browser could not open this authorized media.',
    );
  });
});
