import { createHash } from 'node:crypto';

export type MediaPrefix = 'incoming' | 'processed' | 'films';
/** Scope is supplied by an already-authorized caller, never inferred from a ref. */
export interface MediaScope {
  environment: string;
  groupId: string;
}
export interface MediaObjectRef extends MediaScope {
  backend: 'local' | 's3';
  storeId: string;
  prefix: MediaPrefix;
  key: string;
  versionId: string;
  sha256: string;
  byteLength: number;
  contentType: string;
  expiresAt: string | null;
}
export interface MediaPut {
  prefix: MediaPrefix;
  name: string;
  body: AsyncIterable<Uint8Array>;
  sha256: string;
  byteLength: number;
  contentType: string;
  expiresAt?: string | null;
}
export interface MediaStore {
  put(scope: MediaScope, input: MediaPut): Promise<MediaObjectRef>;
  head(scope: MediaScope, ref: MediaObjectRef): Promise<MediaObjectRef>;
  /** Consumers must finish iteration before using bytes; verification completes at EOF. */
  read(scope: MediaScope, ref: MediaObjectRef): AsyncIterable<Uint8Array>;
  /** Deletes the exact version; expired and already-missing versions are allowed. */
  delete(scope: MediaScope, ref: MediaObjectRef): Promise<void>;
}
export type MediaStoreErrorCode =
  | 'invalid_ref'
  | 'scope_mismatch'
  | 'expired'
  | 'missing'
  | 'integrity_mismatch'
  | 'storage_failed'
  | 'cleanup_failed';
export class MediaStoreError extends Error {
  constructor(readonly code: MediaStoreErrorCode) {
    super(code);
    this.name = 'MediaStoreError';
  }
}
export const MEDIA_STORE_MAX_BYTES = 512 * 1024 * 1024;
const segment = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export function mediaKey(scope: MediaScope, prefix: MediaPrefix, name: string): string {
  if (
    !segment.test(scope.environment) ||
    !segment.test(scope.groupId) ||
    !segment.test(name) ||
    !['incoming', 'processed', 'films'].includes(prefix)
  )
    throw new MediaStoreError('invalid_ref');
  return `${scope.environment}/${scope.groupId}/${prefix}/${name}`;
}
export function validateRef(
  scope: MediaScope,
  ref: MediaObjectRef,
  backend?: MediaObjectRef['backend'],
  storeId?: string,
  now = new Date(),
  allowExpired = false,
): void {
  if (
    !ref ||
    !['local', 's3'].includes(ref.backend) ||
    typeof ref.storeId !== 'string' ||
    !ref.storeId ||
    typeof ref.key !== 'string' ||
    typeof ref.versionId !== 'string' ||
    !ref.versionId ||
    ref.versionId === 'null' ||
    ref.versionId.length > 1024 ||
    !/^[a-f0-9]{64}$/.test(ref.sha256) ||
    !Number.isSafeInteger(ref.byteLength) ||
    ref.byteLength < 1 ||
    ref.byteLength > MEDIA_STORE_MAX_BYTES ||
    !['video/mp4', 'image/jpeg', 'image/png'].includes(ref.contentType)
  )
    throw new MediaStoreError('invalid_ref');
  const name = ref.key.split('/').at(-1) ?? '';
  if (mediaKey(ref, ref.prefix, name) !== ref.key) throw new MediaStoreError('invalid_ref');
  if (
    ref.environment !== scope.environment ||
    ref.groupId !== scope.groupId ||
    (backend && backend !== ref.backend) ||
    (storeId && storeId !== ref.storeId)
  )
    throw new MediaStoreError('scope_mismatch');
  if (ref.prefix === 'incoming') {
    if (typeof ref.expiresAt !== 'string' || !Number.isFinite(Date.parse(ref.expiresAt)))
      throw new MediaStoreError('invalid_ref');
    if (!allowExpired && Date.parse(ref.expiresAt) <= now.getTime())
      throw new MediaStoreError('expired');
  } else if (ref.expiresAt !== null) throw new MediaStoreError('invalid_ref');
}
export function putRef(
  scope: MediaScope,
  input: MediaPut,
  backend: MediaObjectRef['backend'],
  storeId: string,
  versionId: string,
  now: Date,
): MediaObjectRef {
  const ref: MediaObjectRef = {
    ...scope,
    backend,
    storeId,
    prefix: input.prefix,
    key: mediaKey(scope, input.prefix, input.name),
    versionId,
    sha256: input.sha256,
    byteLength: input.byteLength,
    contentType: input.contentType,
    expiresAt: input.expiresAt ?? null,
  };
  validateRef(scope, ref, backend, storeId, now);
  return ref;
}
export function encodeMediaRef(ref: MediaObjectRef): string {
  validateRef(ref, ref, undefined, undefined, new Date(), true);
  const canonical = Object.fromEntries(
    (
      [
        'backend',
        'storeId',
        'environment',
        'groupId',
        'prefix',
        'key',
        'versionId',
        'sha256',
        'byteLength',
        'contentType',
        'expiresAt',
      ] as const
    ).map((key) => [key, ref[key]]),
  );
  return `media-object:${Buffer.from(JSON.stringify(canonical)).toString('base64url')}`;
}
export function isMediaRef(value: string): boolean {
  return value.startsWith('media-object:');
}
export function decodeMediaRef(value: string): MediaObjectRef {
  try {
    if (!isMediaRef(value) || value.length > 8192) throw new Error();
    const ref = JSON.parse(
      Buffer.from(value.slice('media-object:'.length), 'base64url').toString('utf8'),
    ) as MediaObjectRef;
    validateRef(ref, ref, undefined, undefined, new Date(), true);
    return ref;
  } catch {
    throw new MediaStoreError('invalid_ref');
  }
}
export function sameMediaRef(a: MediaObjectRef, b: MediaObjectRef): boolean {
  return (
    [
      'backend',
      'storeId',
      'environment',
      'groupId',
      'prefix',
      'key',
      'versionId',
      'sha256',
      'byteLength',
      'contentType',
      'expiresAt',
    ] as const
  ).every((key) => a[key] === b[key]);
}
export async function* verifiedBody(
  body: AsyncIterable<Uint8Array>,
  ref: Pick<MediaObjectRef, 'sha256' | 'byteLength'>,
): AsyncIterable<Uint8Array> {
  const hash = createHash('sha256');
  let length = 0;
  for await (const bytes of body) {
    length += bytes.length;
    if (length > ref.byteLength) throw new MediaStoreError('integrity_mismatch');
    hash.update(bytes);
    yield bytes;
  }
  if (length !== ref.byteLength || hash.digest('hex') !== ref.sha256)
    throw new MediaStoreError('integrity_mismatch');
}
/** Publication/retrieval callers must also compare the DB's persisted digest/size. */
export async function verifyStoredMedia(
  store: MediaStore,
  scope: MediaScope,
  ref: MediaObjectRef,
  expected: { sha256: string; byteLength: number },
): Promise<void> {
  if (expected.sha256 !== ref.sha256 || expected.byteLength !== ref.byteLength)
    throw new MediaStoreError('integrity_mismatch');
  await store.head(scope, ref);
  for await (const chunk of store.read(scope, ref)) {
    void chunk;
  }
}
