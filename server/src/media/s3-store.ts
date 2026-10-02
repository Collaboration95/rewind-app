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

export interface S3Identity {
  Bucket: string;
  Key: string;
  VersionId: string;
  ExpectedBucketOwner: string;
}
export interface S3ObjectResult {
  VersionId?: string;
  ContentLength?: number;
  ContentType?: string;
  ChecksumSHA256?: string;
  Metadata?: Record<string, string>;
  ServerSideEncryption?: string;
  SSEKMSKeyId?: string;
  Body?: AsyncIterable<Uint8Array>;
}
/** Thin SDK bridge. No credential lookup, client construction or cloud call on import. */
export interface PrivateS3Transport {
  putObject(
    input: Omit<S3Identity, 'VersionId'> & {
      Body: AsyncIterable<Uint8Array>;
      ContentLength: number;
      ContentType: string;
      ChecksumSHA256: string;
      Metadata: Record<string, string>;
      ServerSideEncryption: 'AES256' | 'aws:kms';
      SSEKMSKeyId?: string;
      CacheControl: string;
    },
  ): Promise<S3ObjectResult>;
  headObject(input: S3Identity & { ChecksumMode: 'ENABLED' }): Promise<S3ObjectResult>;
  getObject(input: S3Identity & { ChecksumMode: 'ENABLED' }): Promise<S3ObjectResult>;
  deleteObject(input: S3Identity): Promise<unknown>;
}
export interface PrivateS3Options {
  bucket: string;
  expectedBucketOwner: string;
  environment: string;
  kmsKeyId?: string;
  now?: () => Date;
}
export class PrivateS3MediaStore implements MediaStore {
  constructor(
    private readonly transport: PrivateS3Transport,
    private readonly options: PrivateS3Options,
  ) {
    if (
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket) ||
      !/^\d{12}$/.test(options.expectedBucketOwner) ||
      !options.environment
    )
      throw new MediaStoreError('invalid_ref');
  }
  private identity(scope: MediaScope, ref: MediaObjectRef, allowExpired = false): S3Identity {
    validateRef(
      scope,
      ref,
      's3',
      this.options.bucket,
      this.options.now?.() ?? new Date(),
      allowExpired,
    );
    if (scope.environment !== this.options.environment) throw new MediaStoreError('scope_mismatch');
    return {
      Bucket: this.options.bucket,
      Key: ref.key,
      VersionId: ref.versionId,
      ExpectedBucketOwner: this.options.expectedBucketOwner,
    };
  }
  private check(ref: MediaObjectRef, result: S3ObjectResult): void {
    const metadata = result.Metadata ?? {};
    let stored: MediaObjectRef;
    try {
      stored = JSON.parse(metadata['media-ref']) as MediaObjectRef;
    } catch {
      throw new MediaStoreError('integrity_mismatch');
    }
    // PUT cannot record its response version in metadata; compare every other field.
    if (
      !sameMediaRef(ref, { ...stored, versionId: ref.versionId }) ||
      result.VersionId !== ref.versionId ||
      result.ContentLength !== ref.byteLength ||
      result.ContentType !== ref.contentType ||
      result.ChecksumSHA256 !== Buffer.from(ref.sha256, 'hex').toString('base64') ||
      result.ServerSideEncryption !== (this.options.kmsKeyId ? 'aws:kms' : 'AES256') ||
      (this.options.kmsKeyId && result.SSEKMSKeyId !== this.options.kmsKeyId)
    )
      throw new MediaStoreError('integrity_mismatch');
  }
  async put(scope: MediaScope, input: MediaPut): Promise<MediaObjectRef> {
    const ref = putRef(
      scope,
      input,
      's3',
      this.options.bucket,
      'pending',
      this.options.now?.() ?? new Date(),
    );
    const { VersionId: _version, ...identity } = this.identity(scope, ref);
    void _version;
    let pinned: MediaObjectRef | undefined;
    try {
      const result = await this.transport.putObject({
        ...identity,
        Body: verifiedBody(input.body, ref),
        ContentLength: ref.byteLength,
        ContentType: ref.contentType,
        ChecksumSHA256: Buffer.from(ref.sha256, 'hex').toString('base64'),
        Metadata: { 'media-ref': JSON.stringify(ref) },
        ServerSideEncryption: this.options.kmsKeyId ? 'aws:kms' : 'AES256',
        ...(this.options.kmsKeyId ? { SSEKMSKeyId: this.options.kmsKeyId } : {}),
        CacheControl: 'private, no-store',
      });
      if (!result.VersionId || result.VersionId === 'null')
        throw new MediaStoreError('invalid_ref');
      pinned = { ...ref, versionId: result.VersionId };
      await this.head(scope, pinned);
      return pinned;
    } catch (error) {
      if (pinned) await this.delete(scope, pinned);
      throw this.safeError(error);
    }
  }
  async head(scope: MediaScope, ref: MediaObjectRef): Promise<MediaObjectRef> {
    try {
      const result = await this.transport.headObject({
        ...this.identity(scope, ref),
        ChecksumMode: 'ENABLED',
      });
      this.check(ref, result);
      return ref;
    } catch (error) {
      throw this.safeError(error);
    }
  }
  async *read(scope: MediaScope, ref: MediaObjectRef): AsyncIterable<Uint8Array> {
    try {
      const result = await this.transport.getObject({
        ...this.identity(scope, ref),
        ChecksumMode: 'ENABLED',
      });
      this.check(ref, result);
      if (!result.Body) throw new MediaStoreError('missing');
      yield* verifiedBody(result.Body, ref);
    } catch (error) {
      throw this.safeError(error);
    }
  }
  async delete(scope: MediaScope, ref: MediaObjectRef): Promise<void> {
    const identity = this.identity(scope, ref, true);
    try {
      await this.transport.deleteObject(identity);
    } catch (error) {
      const safe = this.safeError(error);
      if (safe.code !== 'missing') throw new MediaStoreError('cleanup_failed');
    }
  }
  private safeError(error: unknown): MediaStoreError {
    if (error instanceof MediaStoreError) return error;
    const name = (error as { name?: string })?.name;
    return new MediaStoreError(
      ['NoSuchKey', 'NoSuchVersion', 'NotFound'].includes(name ?? '')
        ? 'missing'
        : 'storage_failed',
    );
  }
}
