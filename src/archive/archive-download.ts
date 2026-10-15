import { Platform } from 'react-native';
import { Directory, File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';

import { getReleasedArchiveFilename, type ReleasedArchiveMedia } from '../domain/archive';

const ARCHIVE_CACHE_FOLDER = 'rewind-archive';

/**
 * `native` means the file was observed in its destination: the folder the user
 * picked on Android, or the app cache elsewhere. `cancelled` means the user
 * dismissed the destination picker, so nothing was transferred or saved.
 */
export interface ArchiveDownloadResult {
  filename: string;
  method: 'browser' | 'native' | 'cancelled';
  uri: string;
}

export class ArchiveDownloadError extends Error {
  /** `unavailable`: this device cannot export; other failures are retryable. */
  readonly code: 'failed' | 'unavailable';

  constructor(message: string, code: 'failed' | 'unavailable' = 'failed') {
    super(message);
    this.name = 'ArchiveDownloadError';
    this.code = code;
  }
}

/** Where an Android export goes. Other platforms keep their existing behaviour. */
export type ArchiveExportDestination =
  { kind: 'default' } | { kind: 'folder'; directory: Directory };

const MAX_NAME_ATTEMPTS = 25;
let operationCounter = 0;

function errorCode(error: unknown): string {
  return String((error as { code?: unknown } | null)?.code ?? '');
}

function isPickerCancelled(error: unknown): boolean {
  return (
    errorCode(error) === 'ERR_PICKER_CANCELLED' ||
    /picker was cancelled/i.test(error instanceof Error ? error.message : '')
  );
}

function isNameCollision(error: unknown): boolean {
  return (
    errorCode(error) === 'ERR_DESTINATION_ALREADY_EXISTS' ||
    /already exists/i.test(error instanceof Error ? error.message : '')
  );
}

/**
 * Ask where to save. Android opens the system folder picker (Storage Access
 * Framework); `null` means the user cancelled. Other platforms need no choice.
 */
export async function pickArchiveExportDestination(): Promise<ArchiveExportDestination | null> {
  if (Platform.OS !== 'android') return { kind: 'default' };
  if (typeof Directory?.pickDirectoryAsync !== 'function') {
    throw new ArchiveDownloadError(
      'Saving to a folder is unavailable on this device.',
      'unavailable',
    );
  }
  try {
    return { kind: 'folder', directory: await Directory.pickDirectoryAsync() };
  } catch (error) {
    if (isPickerCancelled(error)) return null;
    throw new ArchiveDownloadError('The folder picker could not be opened.', 'unavailable');
  }
}

function withNameSuffix(filename: string, attempt: number): string {
  if (attempt === 0) return filename;
  const dot = filename.lastIndexOf('.');
  return dot > 0
    ? `${filename.slice(0, dot)}-${attempt}${filename.slice(dot)}`
    : `${filename}-${attempt}`;
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

async function transferToCache(url: string, directory: string, filename: string): Promise<string> {
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const destination = `${directory}/${filename}`;
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
  return result.uri;
}

/**
 * Android: stream to an operation-owned cache folder, then let the native copy
 * (disk to the picked Storage Access Framework folder, never base64 in JS) put
 * it where the user can open it. Only that operation folder is removed after.
 */
async function exportAndroidMedia(
  url: string,
  filename: string,
  destination: ArchiveExportDestination,
): Promise<ArchiveDownloadResult> {
  const cacheDirectory = FileSystem.cacheDirectory;
  if (!cacheDirectory) {
    throw new ArchiveDownloadError('Downloads are unavailable on this device.', 'unavailable');
  }
  let chosen: ArchiveExportDestination | null = destination;
  if (chosen.kind !== 'folder') chosen = await pickArchiveExportDestination();
  if (!chosen) return { filename, method: 'cancelled', uri: '' };
  if (chosen.kind !== 'folder') {
    throw new ArchiveDownloadError('No save folder was chosen.', 'unavailable');
  }
  const directory = chosen.directory;

  operationCounter += 1;
  const operationDirectory = `${cacheDirectory}${ARCHIVE_CACHE_FOLDER}/export-${Date.now().toString(36)}-${operationCounter}`;
  try {
    let source = new File(await transferToCache(url, operationDirectory, filename));
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
      const name = withNameSuffix(filename, attempt);
      try {
        if (attempt > 0) {
          source.rename(name);
          source = new File(`${operationDirectory}/${name}`);
        }
        await source.copy(directory);
        return { filename: name, method: 'native', uri: directory.uri };
      } catch (error) {
        // A same-named file already sits in the chosen folder: save beside it.
        if (!isNameCollision(error)) throw error;
      }
    }
    throw new ArchiveDownloadError('That folder already holds too many copies of this file.');
  } catch (error) {
    if (error instanceof ArchiveDownloadError) throw error;
    throw new ArchiveDownloadError('The file could not be saved to that folder.');
  } finally {
    await FileSystem.deleteAsync(operationDirectory, { idempotent: true }).catch(() => undefined);
  }
}

async function downloadNativeMedia(
  url: string,
  filename: string,
  destination: ArchiveExportDestination,
): Promise<ArchiveDownloadResult> {
  if (Platform.OS === 'android') return exportAndroidMedia(url, filename, destination);
  const cacheDirectory = FileSystem.cacheDirectory;
  if (!cacheDirectory) {
    throw new ArchiveDownloadError('Downloads are unavailable on this device.');
  }
  const uri = await transferToCache(url, `${cacheDirectory}${ARCHIVE_CACHE_FOLDER}`, filename);
  return { filename, method: 'native', uri };
}

/** Download to `destination`; Android asks for a folder when none is given. */
export async function downloadReleasedArchiveMediaTo(
  media: ReleasedArchiveMedia,
  destination: ArchiveExportDestination,
): Promise<ArchiveDownloadResult> {
  const filename = getReleasedArchiveFilename(media);
  if (Platform.OS === 'web') {
    await downloadBrowserMedia(media.downloadUrl, filename);
    return { filename, method: 'browser', uri: media.downloadUrl };
  }
  return downloadNativeMedia(media.downloadUrl, filename, destination);
}

export function downloadReleasedArchiveMedia(
  media: ReleasedArchiveMedia,
): Promise<ArchiveDownloadResult> {
  return downloadReleasedArchiveMediaTo(media, { kind: 'default' });
}

export interface ArchiveDownloadQueue {
  (media: ReleasedArchiveMedia): Promise<ArchiveDownloadResult>;
  /**
   * Run one whole authorize/download/export operation. Operations run one at a
   * time, and a repeat of a `key` that is still running joins it, even when the
   * repeat would have obtained a different signed URL.
   */
  run<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

/** The identity of an archive asset, independent of its (changing) signed URL. */
export function archiveAssetKey(media: { id: string; contributionId?: string | null }): string {
  return media.contributionId ? `clip:${media.id}:${media.contributionId}` : `film:${media.id}`;
}

export function createArchiveDownloadQueue(
  download: (
    media: ReleasedArchiveMedia,
  ) => Promise<ArchiveDownloadResult> = downloadReleasedArchiveMedia,
): ArchiveDownloadQueue {
  let tail: Promise<unknown> = Promise.resolve();
  const inFlight = new Map<string, Promise<unknown>>();

  const run = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const existing = inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const task = tail.then(operation);
    inFlight.set(key, task);
    const settled = () => {
      if (inFlight.get(key) === task) inFlight.delete(key);
    };
    tail = task.then(settled, settled);
    return task;
  };

  const queue = ((media: ReleasedArchiveMedia) =>
    run(archiveAssetKey(media), () => download(media))) as ArchiveDownloadQueue;
  queue.run = run;
  return queue;
}
