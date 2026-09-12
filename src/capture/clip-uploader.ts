import {
  MAX_CLIP_DURATION_SECONDS,
  type ClipUploadInput,
  type PendingClipUpload,
} from '../domain/video';

export const MAX_CLIP_BYTES = 50 * 1024 * 1024;

export interface ClipUploadTransport {
  uploadClip(input: ClipUploadInput): Promise<PendingClipUpload>;
  cancelClipUpload(jobId: string): Promise<void>;
}

export type ClipUploadProgress =
  | { status: 'idle'; percent: 0 }
  | { status: 'validating'; percent: 0 }
  | { status: 'uploading'; percent: number }
  | { status: 'complete'; percent: 100; upload: PendingClipUpload }
  | { status: 'cancelled'; percent: 0 }
  | { status: 'failed'; percent: number; message: string };

export class ClipUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClipUploadError';
  }
}

export function validateClipUploadInput(input: ClipUploadInput): string | null {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.idempotencyKey))
    return 'Provide a retryable upload key.';
  if (
    !input.sourceUri ||
    input.mimeType !== 'video/mp4' ||
    !Number.isInteger(input.byteLength) ||
    input.byteLength <= 0 ||
    input.byteLength > MAX_CLIP_BYTES ||
    !Number.isFinite(input.durationSeconds) ||
    input.durationSeconds <= 0 ||
    input.durationSeconds > MAX_CLIP_DURATION_SECONDS ||
    !Number.isInteger(input.width) ||
    input.width <= 0 ||
    !Number.isInteger(input.height) ||
    input.height <= 0 ||
    input.width >= input.height ||
    input.hasAudio !== true
  ) {
    return 'The clip must be an MP4 portrait video with audio, within 15 seconds and 50 MB.';
  }
  return null;
}

export class ClipUploadSession {
  private progress: ClipUploadProgress = { status: 'idle', percent: 0 };
  private lastInput: ClipUploadInput | null = null;
  private generation = 0;
  private activeJobId: string | null = null;

  constructor(private readonly transport: ClipUploadTransport) {}

  getProgress(): ClipUploadProgress {
    return this.progress.status === 'complete'
      ? { ...this.progress, upload: { ...this.progress.upload } }
      : { ...this.progress };
  }

  async upload(input: ClipUploadInput, onProgress?: (progress: ClipUploadProgress) => void) {
    const validationError = validateClipUploadInput(input);
    if (validationError) {
      this.progress = { status: 'failed', percent: 0, message: validationError };
      onProgress?.(this.getProgress());
      throw new ClipUploadError(validationError);
    }
    this.lastInput = { ...input };
    const generation = ++this.generation;
    this.progress = { status: 'validating', percent: 0 };
    onProgress?.(this.getProgress());
    this.progress = { status: 'uploading', percent: 10 };
    onProgress?.(this.getProgress());
    try {
      const upload = await this.transport.uploadClip(input);
      if (generation !== this.generation) {
        await this.transport.cancelClipUpload(upload.job.id);
        throw new ClipUploadError('The upload was cancelled.');
      }
      this.activeJobId = upload.job.id;
      this.progress = { status: 'complete', percent: 100, upload };
      onProgress?.(this.getProgress());
      return upload;
    } catch (error) {
      if (generation !== this.generation) {
        this.progress = { status: 'cancelled', percent: 0 };
        onProgress?.(this.getProgress());
        throw error instanceof ClipUploadError
          ? error
          : new ClipUploadError('The upload was cancelled.');
      }
      const message = error instanceof Error ? error.message : 'The clip could not be uploaded.';
      this.progress = { status: 'failed', percent: 10, message };
      onProgress?.(this.getProgress());
      throw error instanceof ClipUploadError ? error : new ClipUploadError(message);
    }
  }

  async retry(onProgress?: (progress: ClipUploadProgress) => void): Promise<PendingClipUpload> {
    if (!this.lastInput) throw new ClipUploadError('Capture a clip before retrying its upload.');
    return this.upload(this.lastInput, onProgress);
  }

  async cancel(): Promise<void> {
    this.generation += 1;
    const jobId = this.activeJobId;
    this.activeJobId = null;
    // Invalidate the local state before waiting on the runtime. A network
    // cancellation can hang or fail, but the route must not remain stuck in
    // an uploading state while that request is unresolved.
    this.progress = { status: 'cancelled', percent: 0 };
    if (jobId) {
      await this.transport.cancelClipUpload(jobId);
    }
  }
}
