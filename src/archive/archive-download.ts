import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

import { getReleasedArchiveFilename, type ReleasedArchiveMedia } from '../domain/archive';

const ARCHIVE_CACHE_FOLDER = 'rewind-archive';

export interface ArchiveDownloadResult {
  filename: string;
  method: 'browser' | 'native';
  uri: string;
}

export class ArchiveDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveDownloadError';
  }
}

interface BrowserAnchor {
  click?: () => void;
  download?: string;
  href?: string;
  rel?: string;
  style?: { display?: string };
  remove?: () => void;
}

interface BrowserDocument {
  body?: { appendChild?: (element: BrowserAnchor) => void };
  createElement: (tagName: string) => BrowserAnchor;
}

interface BrowserWindow {
  open?: (url: string, target?: string, features?: string) => unknown;
}

function browserDocument(): BrowserDocument | null {
  return typeof document === 'undefined' ? null : (document as unknown as BrowserDocument);
}

function browserWindow(): BrowserWindow | null {
  return typeof window === 'undefined' ? null : window;
}

function openBrowserFallback(url: string): void {
  const opened = browserWindow()?.open?.(url, '_blank', 'noopener,noreferrer');
  if (opened === null || opened === undefined) {
    throw new ArchiveDownloadError('The browser could not open this authorized media.');
  }
}

async function downloadBrowserMedia(url: string, filename: string): Promise<void> {
  const documentRef = browserDocument();
  let anchor: BrowserAnchor | null = null;
  try {
    anchor = documentRef?.createElement('a') ?? null;
  } catch {
    openBrowserFallback(url);
    return;
  }

  if (
    !documentRef ||
    !anchor ||
    typeof anchor.click !== 'function' ||
    typeof anchor.download !== 'string' ||
    !documentRef.body ||
    typeof documentRef.body.appendChild !== 'function' ||
    typeof fetch !== 'function' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function' ||
    typeof URL.revokeObjectURL !== 'function'
  ) {
    openBrowserFallback(url);
    return;
  }

  let objectUrl: string | null = null;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new ArchiveDownloadError(
        `The authorized media download failed with HTTP ${response.status}.`,
      );
    }

    const blob = await response.blob();
    objectUrl = URL.createObjectURL(blob);
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noreferrer';
    if (anchor.style) anchor.style.display = 'none';
    documentRef.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove?.();
    if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
  }
}

async function downloadNativeMedia(url: string, filename: string): Promise<ArchiveDownloadResult> {
  const cacheDirectory = FileSystem.cacheDirectory;
  if (!cacheDirectory) {
    throw new ArchiveDownloadError('Downloads are unavailable on this device.');
  }

  const archiveDirectory = `${cacheDirectory}${ARCHIVE_CACHE_FOLDER}`;
  await FileSystem.makeDirectoryAsync(archiveDirectory, { intermediates: true });
  const destination = `${archiveDirectory}/${filename}`;
  const result = await FileSystem.downloadAsync(url, destination);
  const succeeded = result.status >= 200 && result.status < 300;
  if (!succeeded) {
    try {
      await FileSystem.deleteAsync(destination, { idempotent: true });
    } catch {
      // Keep the HTTP failure authoritative when best-effort cleanup is unavailable.
    }
    throw new ArchiveDownloadError(
      `The authorized media download failed with HTTP ${result.status}.`,
    );
  }
  return { filename, method: 'native', uri: result.uri };
}

export async function downloadReleasedArchiveMedia(
  media: ReleasedArchiveMedia,
): Promise<ArchiveDownloadResult> {
  const filename = getReleasedArchiveFilename(media);
  if (Platform.OS === 'web') {
    await downloadBrowserMedia(media.downloadUrl, filename);
    return { filename, method: 'browser', uri: media.downloadUrl };
  }
  return downloadNativeMedia(media.downloadUrl, filename);
}

export function createArchiveDownloadQueue(
  download: (
    media: ReleasedArchiveMedia,
  ) => Promise<ArchiveDownloadResult> = downloadReleasedArchiveMedia,
): (media: ReleasedArchiveMedia) => Promise<ArchiveDownloadResult> {
  let tail = Promise.resolve();
  const inFlight = new Map<string, Promise<ArchiveDownloadResult>>();

  return (media) => {
    const key = `${media.id}:${media.downloadUrl}`;
    const existing = inFlight.get(key);
    if (existing) return existing;

    const task = tail.then(() => download(media));
    inFlight.set(key, task);
    tail = task.then(
      () => undefined,
      () => undefined,
    );
    void task.then(
      () => {
        if (inFlight.get(key) === task) inFlight.delete(key);
      },
      () => {
        if (inFlight.get(key) === task) inFlight.delete(key);
      },
    );
    return task;
  };
}
