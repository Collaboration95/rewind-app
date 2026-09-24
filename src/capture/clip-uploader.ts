import {
  MAX_CLIP_DURATION_SECONDS,
  type ClipUploadInput,
  type PendingClipUpload,
} from '../domain/video';

export const MAX_CLIP_BYTES = 50 * 1024 * 1024;

/**
 * How many times one clip may be submitted before the route stops offering a
 * retry. The budget is per captured clip, bounded so a dropped connection
 * cannot produce an endless retry loop, and observable so the UI can tell the
 * truth once it is spent.
 */
export const MAX_CLIP_UPLOAD_ATTEMPTS = 3;

export interface ClipUploadTransport {
  uploadClip(input: ClipUploadInput): Promise<PendingClipUpload>;
  cancelClipUpload(jobId: string): Promise<void>;
}

export type PrepareClipUploadInput = (input: ClipUploadInput) => Promise<ClipUploadInput>;

export type ClipUploadProgress =
  | { status: 'idle'; percent: 0 }
  | { status: 'validating'; percent: 0 }
  | { status: 'uploading'; percent: number }
  | { status: 'complete'; percent: 100; upload: PendingClipUpload }
  | { status: 'cancelled'; percent: 0 }
  | { status: 'failed'; percent: number; message: string };

export interface ClipUploadErrorOptions {
  /** Whether the same input can be submitted again safely. */
  retryable?: boolean;
  /** Stable transport/validation code, when one is available. */
  code?: string;
  /** HTTP status from a typed runtime error, when one is available. */
  status?: number;
}

export class ClipUploadError extends Error {
  readonly retryable: boolean;
  readonly code?: string;
  readonly status?: number;

  constructor(message: string, options: ClipUploadErrorOptions = {}) {
    super(message);
    this.name = 'ClipUploadError';
    this.retryable = options.retryable ?? true;
    this.code = options.code;
    this.status = options.status;
  }
}

const terminalTransportCodes = new Set([
  'authorization',
  'forbidden',
  'invalid_duration',
  'invalid_metadata',
  'missing_source',
  'not_found',
  'quota_exceeded',
  'source_unavailable',
  'validation',
]);

function wrapTransportError(error: unknown, message: string): ClipUploadError {
  if (error instanceof ClipUploadError) return error;
  const candidate = error as { code?: unknown; status?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : undefined;
  const status = typeof candidate.status === 'number' ? candidate.status : undefined;
  const retryable = !(
    (status !== undefined && status >= 400 && status < 500) ||
    (code !== undefined && terminalTransportCodes.has(code))
  );
  return new ClipUploadError(message, { code, retryable, status });
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
  private attempts = 0;

  constructor(private readonly transport: ClipUploadTransport) {}

  getProgress(): ClipUploadProgress {
    return this.progress.status === 'complete'
      ? { ...this.progress, upload: { ...this.progress.upload } }
      : { ...this.progress };
  }

  /** Upload attempts already spent on the current input. */
  getAttempts(): number {
    return this.attempts;
  }

  /** Whether the bounded retry budget still allows another submission. */
  canRetry(): boolean {
    return this.lastInput !== null && this.attempts < MAX_CLIP_UPLOAD_ATTEMPTS;
  }

  attemptsRemaining(): number {
    return Math.max(0, MAX_CLIP_UPLOAD_ATTEMPTS - this.attempts);
  }

  async upload(
    input: ClipUploadInput,
    onProgress?: (progress: ClipUploadProgress) => void,
    prepareInput?: PrepareClipUploadInput,
  ) {
    const validationError = validateClipUploadInput(input);
    if (validationError) {
      this.progress = { status: 'failed', percent: 0, message: validationError };
      onProgress?.(this.getProgress());
      throw new ClipUploadError(validationError, { code: 'validation', retryable: false });
    }
    this.lastInput = { ...input };
    this.attempts = 1;
    return this.runUpload(this.lastInput, onProgress, prepareInput);
  }

  private async runUpload(
    input: ClipUploadInput,
    onProgress?: (progress: ClipUploadProgress) => void,
    prepareInput?: PrepareClipUploadInput,
  ) {
    const generation = ++this.generation;
    this.progress = { status: 'validating', percent: 0 };
    onProgress?.(this.getProgress());
    this.progress = { status: 'uploading', percent: 10 };
    onProgress?.(this.getProgress());
    try {
      const preparedInput = prepareInput ? await prepareInput({ ...input }) : input;
      if (generation !== this.generation) {
        throw new ClipUploadError('The upload was cancelled.', {
          code: 'cancelled',
          retryable: false,
        });
      }
      const upload = await this.transport.uploadClip(preparedInput);
      if (generation !== this.generation) {
        await this.transport.cancelClipUpload(upload.job.id);
        throw new ClipUploadError('The upload was cancelled.', {
          code: 'cancelled',
          retryable: false,
        });
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
          : new ClipUploadError('The upload was cancelled.', {
              code: 'cancelled',
              retryable: false,
            });
      }
      const message = error instanceof Error ? error.message : 'The clip could not be uploaded.';
      this.progress = { status: 'failed', percent: 10, message };
      onProgress?.(this.getProgress());
      // Preserve typed runtime failure metadata (HTTP status/code) on the
      // upload error so the screen can distinguish a safe retry from a
      // terminal rejection. The cancellation race above already creates a
      // ClipUploadError.
      throw wrapTransportError(error, message);
    }
  }

  async retry(
    onProgress?: (progress: ClipUploadProgress) => void,
    prepareInput?: PrepareClipUploadInput,
  ): Promise<PendingClipUpload> {
    if (!this.lastInput)
      throw new ClipUploadError('Capture a clip before retrying its upload.', {
        code: 'missing_input',
        retryable: false,
      });
    // Refuse a retry once the bounded budget is spent. The caller renders the
    // terminal state instead of a button that can never succeed.
    if (!this.canRetry()) {
      throw new ClipUploadError(
        `The upload could not be completed after ${MAX_CLIP_UPLOAD_ATTEMPTS} attempts. Retake the clip.`,
        { code: 'attempts_exhausted', retryable: false },
      );
    }
    this.attempts += 1;
    return this.runUpload({ ...this.lastInput }, onProgress, prepareInput);
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

  /**
   * Drop the local input after the clip itself has been released, so a later
   * retry cannot resend a file that no longer exists.
   */
  forget(): void {
    this.lastInput = null;
    this.activeJobId = null;
    this.attempts = 0;
    this.progress = { status: 'idle', percent: 0 };
  }
}
