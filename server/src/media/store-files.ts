import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hashFile } from './integrity';
import {
  MediaStoreError,
  type MediaObjectRef,
  type MediaPrefix,
  type MediaScope,
  type MediaStore,
} from './store';

/** Caller removes the private scratch directory after FFmpeg finishes. */
export async function materializeStoredMedia(
  store: MediaStore,
  scope: MediaScope,
  ref: MediaObjectRef,
  scratchRoot: string,
): Promise<{ path: string; dispose: () => Promise<void> }> {
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(resolve(scratchRoot, '.private-media-'));
  const path = resolve(directory, 'input');
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    await store.head(scope, ref);
    const handle = await open(path, 'wx', 0o600);
    try {
      for await (const chunk of store.read(scope, ref)) await handle.writeFile(chunk);
    } finally {
      await handle.close();
    }
    return { path, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
export async function putProcessedFile(
  store: MediaStore,
  scope: MediaScope,
  path: string,
  prefix: Exclude<MediaPrefix, 'incoming'>,
): Promise<MediaObjectRef> {
  const integrity = await hashFile(path);
  if (!integrity) throw new MediaStoreError('integrity_mismatch');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await store.put(scope, {
      prefix,
      name: randomUUID(),
      body: handle.createReadStream({ autoClose: false }),
      ...integrity,
      contentType: 'video/mp4',
    });
  } finally {
    await handle.close();
  }
}
