import { isAbsolute, parse } from 'node:path';
import { Readable } from 'node:stream';

import { LocalMediaStore } from './local-store';
import { PrivateS3MediaStore, type PrivateS3Transport, type S3ObjectResult } from './s3-store';
import {
  MediaStoreError,
  mediaKey,
  validateRef,
  type MediaObjectRef,
  type MediaScope,
  type MediaStore,
} from './store';
import type { UploadCapability, UploadIntentTransport, UploadTarget } from './upload-intents';

/** Configuration parsing and credential/provider policy belong to the caller. */
export type MediaRuntimeConfig =
  | { backend: 'local'; root: string; environment: string }
  | {
      backend: 's3';
      bucket: string;
      expectedBucketOwner: string;
      region: string;
      environment: string;
      /** Canonical key ARN, not an alias; HEAD returns this immutable identity. */
      kmsKeyId?: string;
    };
type S3Config = Extract<MediaRuntimeConfig, { backend: 's3' }>;
type CommandConstructor = new (input: Record<string, unknown>) => unknown;
export interface RuntimeS3Client {
  send(command: unknown): Promise<unknown>;
  destroy(): void;
}
export interface PutSigningOptions {
  expiresIn: number;
  signingDate: Date;
  signableHeaders: Set<string>;
  unhoistableHeaders: Set<string>;
}
/** Injection uses the same command/client/presigner protocol as AWS SDK v3. */
export interface S3RuntimeBindings {
  client: RuntimeS3Client;
  PutObjectCommand: CommandConstructor;
  HeadObjectCommand: CommandConstructor;
  GetObjectCommand: CommandConstructor;
  DeleteObjectCommand: CommandConstructor;
  ListObjectVersionsCommand: CommandConstructor;
  getSignedUrl(
    client: RuntimeS3Client,
    command: unknown,
    options: PutSigningOptions,
  ): Promise<string>;
}
export interface MediaRuntime {
  store: MediaStore;
  /** Disk rollback uses the existing authenticated staged-intake path. */
  uploadTransport: UploadIntentTransport | null;
  /** Idempotent; an injected client remains owned by its caller. */
  close(): void;
}
export class MediaRuntimeError extends Error {
  constructor(readonly code: 'invalid_config' | 'sdk_unavailable') {
    super(code);
    this.name = 'MediaRuntimeError';
  }
}
function validateConfig(config: MediaRuntimeConfig): void {
  if (!config || !['local', 's3'].includes(config.backend))
    throw new MediaRuntimeError('invalid_config');
  try {
    mediaKey({ environment: config.environment, groupId: 'validation' }, 'incoming', 'validation');
  } catch {
    throw new MediaRuntimeError('invalid_config');
  }
  if (config.backend === 'local') {
    if (
      typeof config.root !== 'string' ||
      !isAbsolute(config.root) ||
      parse(config.root).root === config.root
    )
      throw new MediaRuntimeError('invalid_config');
  } else if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
    !/^\d{12}$/.test(config.expectedBucketOwner) ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(config.region) ||
    (config.kmsKeyId !== undefined &&
      !/^arn:aws(?:-cn|-us-gov)?:kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]+$/.test(config.kmsKeyId))
  )
    throw new MediaRuntimeError('invalid_config');
}
async function loadSdk(config: S3Config): Promise<S3RuntimeBindings> {
  // Variable specifiers keep this optional server dependency out of the disk and
  // browser dependency graphs. Loading/construction sends no requests.
  const clientPackage = '@aws-sdk/client-s3';
  const signerPackage = '@aws-sdk/s3-request-presigner';
  try {
    const [commands, signer] = await Promise.all([import(clientPackage), import(signerPackage)]);
    for (const key of [
      'S3Client',
      'PutObjectCommand',
      'HeadObjectCommand',
      'GetObjectCommand',
      'DeleteObjectCommand',
      'ListObjectVersionsCommand',
    ])
      if (typeof commands[key] !== 'function') throw new Error();
    if (typeof signer.getSignedUrl !== 'function') throw new Error();
    const Client = commands.S3Client as new (options: Record<string, unknown>) => RuntimeS3Client;
    return {
      client: new Client({
        region: config.region,
        maxAttempts: 3,
        // SHA-256 is supplied explicitly. Avoid an additional default checksum
        // or response checksum policy changing the persisted wire contract.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      }),
      PutObjectCommand: commands.PutObjectCommand,
      HeadObjectCommand: commands.HeadObjectCommand,
      GetObjectCommand: commands.GetObjectCommand,
      DeleteObjectCommand: commands.DeleteObjectCommand,
      ListObjectVersionsCommand: commands.ListObjectVersionsCommand,
      getSignedUrl: signer.getSignedUrl,
    };
  } catch {
    throw new MediaRuntimeError('sdk_unavailable');
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new MediaStoreError('storage_failed');
  return value as Record<string, unknown>;
}
function s3Result(value: unknown): S3ObjectResult {
  const result = object(value);
  if (
    result.Body !== undefined &&
    (!result.Body ||
      typeof (result.Body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== 'function')
  )
    throw new MediaStoreError('storage_failed');
  return result as S3ObjectResult;
}
function privateTransport(sdk: S3RuntimeBindings): PrivateS3Transport {
  return {
    async putObject(input) {
      const body = Readable.from(input.Body, { objectMode: false });
      try {
        const result = await sdk.client.send(new sdk.PutObjectCommand({ ...input, Body: body }));
        // A transport that resolves before consuming the verified stream is not
        // evidence of a successful upload. The real SDK consumes it before send resolves.
        if (!body.readableEnded) throw new MediaStoreError('storage_failed');
        return s3Result(result);
      } finally {
        body.destroy();
      }
    },
    async headObject(input) {
      return s3Result(await sdk.client.send(new sdk.HeadObjectCommand({ ...input })));
    },
    async getObject(input) {
      return s3Result(await sdk.client.send(new sdk.GetObjectCommand({ ...input })));
    },
    deleteObject(input) {
      return sdk.client.send(new sdk.DeleteObjectCommand({ ...input }));
    },
  };
}
interface VersionCursor {
  storeId: string;
  environment: string;
  groupId: string;
  key: string;
  keyMarker: string;
  versionMarker: string;
}
function readCursor(cursor: string | null, target: UploadTarget): VersionCursor | null {
  if (cursor === null) return null;
  try {
    if (typeof cursor !== 'string' || cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error();
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as VersionCursor;
    if (
      value.storeId !== target.storeId ||
      value.environment !== target.environment ||
      value.groupId !== target.groupId ||
      value.key !== target.key ||
      value.keyMarker !== target.key ||
      typeof value.versionMarker !== 'string' ||
      !value.versionMarker ||
      value.versionMarker.length > 1024
    )
      throw new Error();
    return value;
  } catch {
    throw new MediaStoreError('invalid_ref');
  }
}
function uploadTransport(
  config: S3Config,
  sdk: S3RuntimeBindings,
  now: () => Date,
): UploadIntentTransport {
  function checked(scope: MediaScope, target: UploadTarget, expired = false): MediaObjectRef {
    const ref = { ...target, versionId: 'pending' };
    validateRef(scope, ref, 's3', config.bucket, now(), expired);
    if (scope.environment !== config.environment || target.prefix !== 'incoming')
      throw new MediaStoreError('scope_mismatch');
    return ref;
  }
  return {
    backend: 's3',
    storeId: config.bucket,
    async signPut(scope, target): Promise<UploadCapability> {
      const ref = checked(scope, target);
      const at = now();
      const expiresIn = Math.min(
        900,
        Math.floor((Date.parse(ref.expiresAt!) - at.getTime()) / 1000),
      );
      if (expiresIn < 1) throw new MediaStoreError('expired');
      const checksum = Buffer.from(ref.sha256, 'hex').toString('base64');
      const metadata = JSON.stringify(ref);
      const encryption = config.kmsKeyId ? 'aws:kms' : 'AES256';
      const headers: Record<string, string> = {
        'content-type': ref.contentType,
        'cache-control': 'private, no-store',
        'x-amz-checksum-sha256': checksum,
        'x-amz-meta-media-ref': metadata,
        'x-amz-expected-bucket-owner': config.expectedBucketOwner,
        'x-amz-server-side-encryption': encryption,
        ...(config.kmsKeyId
          ? { 'x-amz-server-side-encryption-aws-kms-key-id': config.kmsKeyId }
          : {}),
      };
      const command = new sdk.PutObjectCommand({
        Bucket: config.bucket,
        Key: ref.key,
        ExpectedBucketOwner: config.expectedBucketOwner,
        ContentLength: ref.byteLength,
        ContentType: ref.contentType,
        CacheControl: headers['cache-control'],
        ChecksumSHA256: checksum,
        Metadata: { 'media-ref': metadata },
        ServerSideEncryption: encryption,
        ...(config.kmsKeyId ? { SSEKMSKeyId: config.kmsKeyId } : {}),
      });
      try {
        const url = await sdk.getSignedUrl(sdk.client, command, {
          expiresIn,
          signingDate: at,
          // Browser Fetch supplies content-length from the Blob body; callers
          // must not set this forbidden browser header themselves.
          signableHeaders: new Set([...Object.keys(headers), 'content-length']),
          unhoistableHeaders: new Set(
            Object.keys(headers).filter((key) => key.startsWith('x-amz-')),
          ),
        });
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash)
          throw new Error();
        const expiresAt = new Date(at.getTime() + expiresIn * 1000).toISOString();
        if (now().getTime() >= Date.parse(expiresAt)) throw new MediaStoreError('expired');
        return { method: 'PUT', url, headers, expiresAt };
      } catch (error) {
        if (error instanceof MediaStoreError) throw error;
        throw new MediaStoreError('storage_failed');
      }
    },
    async listVersions(scope, target, cursor, limit) {
      checked(scope, target, true);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new MediaStoreError('invalid_ref');
      const marker = readCursor(cursor, target);
      try {
        const result = object(
          await sdk.client.send(
            new sdk.ListObjectVersionsCommand({
              Bucket: config.bucket,
              ExpectedBucketOwner: config.expectedBucketOwner,
              Prefix: target.key,
              MaxKeys: limit,
              ...(marker
                ? { KeyMarker: marker.keyMarker, VersionIdMarker: marker.versionMarker }
                : {}),
            }),
          ),
        );
        const versions = result.Versions ?? [];
        const deletes = result.DeleteMarkers ?? [];
        if (
          !Array.isArray(versions) ||
          !Array.isArray(deletes) ||
          versions.length + deletes.length > limit
        )
          throw new Error();
        const refs: MediaObjectRef[] = [];
        const seen = new Set<string>();
        for (const item of [...versions, ...deletes]) {
          const version = object(item);
          // Prefix listings can contain adjacent keys. They never grant deletion
          // authority outside this intent's exact incoming key.
          if (version.Key !== target.key) continue;
          if (typeof version.VersionId !== 'string' || version.VersionId === 'pending')
            throw new Error();
          const ref = { ...target, versionId: version.VersionId };
          validateRef(scope, ref, 's3', config.bucket, now(), true);
          if (seen.has(ref.versionId)) throw new Error();
          seen.add(ref.versionId);
          // Cleanup needs only identity, not mutable content metadata. Delete
          // remains exact-version, including abandoned corrupt versions/markers.
          refs.push(ref);
        }
        let nextCursor: string | null = null;
        if (result.IsTruncated === true && result.NextKeyMarker === target.key) {
          if (
            typeof result.NextVersionIdMarker !== 'string' ||
            !result.NextVersionIdMarker ||
            result.NextVersionIdMarker === marker?.versionMarker ||
            result.NextVersionIdMarker.length > 1024
          )
            throw new Error();
          nextCursor = Buffer.from(
            JSON.stringify({
              storeId: target.storeId,
              environment: target.environment,
              groupId: target.groupId,
              key: target.key,
              keyMarker: target.key,
              versionMarker: result.NextVersionIdMarker,
            } satisfies VersionCursor),
          ).toString('base64url');
        } else if (result.IsTruncated === true && typeof result.NextKeyMarker !== 'string') {
          throw new Error();
        }
        return { refs, nextCursor };
      } catch (error) {
        if (error instanceof MediaStoreError) throw error;
        throw new MediaStoreError('storage_failed');
      }
    },
  };
}

/** Lazy SDK construction performs no cloud calls. No public GET URL is exposed. */
export async function createMediaRuntime(
  config: MediaRuntimeConfig,
  options: { sdk?: S3RuntimeBindings; now?: () => Date } = {},
): Promise<MediaRuntime> {
  validateConfig(config);
  config = { ...config };
  const now = options.now ?? (() => new Date());
  if (config.backend === 'local') {
    const local = new LocalMediaStore(config.root, now);
    const environment = config.environment;
    const checked = (scope: MediaScope) => {
      if (scope.environment !== environment) throw new MediaStoreError('scope_mismatch');
      return scope;
    };
    return {
      store: {
        async put(scope, input) {
          return local.put(checked(scope), input);
        },
        async head(scope, ref) {
          return local.head(checked(scope), ref);
        },
        async *read(scope, ref) {
          yield* local.read(checked(scope), ref);
        },
        async delete(scope, ref) {
          return local.delete(checked(scope), ref);
        },
      },
      uploadTransport: null,
      close() {},
    };
  }
  const sdk = options.sdk ?? (await loadSdk(config));
  const store = new PrivateS3MediaStore(privateTransport(sdk), { ...config, now });
  let closed = false;
  return {
    store,
    uploadTransport: uploadTransport(config, sdk, now),
    close() {
      if (!closed && !options.sdk) sdk.client.destroy();
      closed = true;
    },
  };
}
