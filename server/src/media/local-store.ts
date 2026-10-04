import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import {
  MediaStoreError,
  putRef,
  sameMediaRef,
  validateRef,
  verifiedBody,
  type MediaObjectRef,
  type MediaPut,
  type MediaScope,
  type MediaStore,
} from './store';

/** Private version files are immutable and never mapped to an HTTP/public URL. */
export class LocalMediaStore implements MediaStore {
  readonly storeId: string;
  private readonly root: string;
  constructor(
    root: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.root = resolve(root);
    this.storeId = createHash('sha256').update(this.root).digest('hex');
  }
  private async path(
    scope: MediaScope,
    ref: MediaObjectRef,
    allowExpired = false,
    create = false,
  ): Promise<string> {
    validateRef(scope, ref, 'local', this.storeId, this.now(), allowExpired);
    if (!/^[a-f0-9-]{36}$/.test(ref.versionId)) throw new MediaStoreError('invalid_ref');
    const path = resolve(this.root, ref.key, ref.versionId);
    if (create) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Reject a symlink in any parent, including the configured root itself.
    if (
      (await realpath(dirname(path))) !==
      resolve(await realpath(this.root), relative(this.root, dirname(path)))
    )
      throw new MediaStoreError('scope_mismatch');
    return path;
  }
  async put(scope: MediaScope, input: MediaPut): Promise<MediaObjectRef> {
    const ref = putRef(scope, input, 'local', this.storeId, randomUUID(), this.now());
    const path = await this.path(scope, ref, false, true);
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        for await (const chunk of verifiedBody(input.body, ref)) await handle.writeFile(chunk);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await writeFile(`${path}.json`, JSON.stringify(ref), { flag: 'wx', mode: 0o600 });
      return ref;
    } catch (error) {
      await rm(path, { force: true });
      await rm(`${path}.json`, { force: true });
      throw error;
    }
  }
  async head(scope: MediaScope, ref: MediaObjectRef): Promise<MediaObjectRef> {
    try {
      const path = await this.path(scope, ref);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await handle.stat()).isFile() || (await handle.stat()).size !== ref.byteLength)
          throw new MediaStoreError('integrity_mismatch');
      } finally {
        await handle.close();
      }
      const stored = JSON.parse(await readFile(`${path}.json`, 'utf8')) as MediaObjectRef;
      if (!sameMediaRef(ref, stored)) throw new MediaStoreError('integrity_mismatch');
      return stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MediaStoreError('missing');
      throw error;
    }
  }
  async *read(scope: MediaScope, ref: MediaObjectRef): AsyncIterable<Uint8Array> {
    await this.head(scope, ref);
    const handle = await open(
      await this.path(scope, ref),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      yield* verifiedBody(handle.createReadStream({ autoClose: false }), ref);
    } finally {
      await handle.close();
    }
  }
  async delete(scope: MediaScope, ref: MediaObjectRef): Promise<void> {
    try {
      const path = await this.path(scope, ref, true);
      await rm(path, { force: true });
      await rm(`${path}.json`, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (error instanceof MediaStoreError) throw error;
      throw new MediaStoreError('cleanup_failed');
    }
  }
}
