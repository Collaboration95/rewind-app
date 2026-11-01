import { LocalRuntimeError } from '../runtime/local-runtime-client';
import type { CameraPlatform } from './contracts';
import { userMessage } from '../domain/user-message';
import { ClipUploadError } from './clip-uploader';
import type { VideoRecordingPlatform } from './video-recording';

export type AccessStatus =
  | 'checking'
  | 'ready'
  | 'unsupported'
  | 'temporarily-unavailable'
  | 'permission-undecided'
  | 'permission-denied'
  | 'permission-blocked'
  | 'error';

/** The server rejects clips over 15 seconds; keep a processed clip below it. */
export const MAX_PROCESSED_CLIP_SECONDS = 14.9;

export function isVideoPlatform(
  platform: CameraPlatform,
): platform is CameraPlatform & VideoRecordingPlatform {
  return (
    typeof (platform as Partial<VideoRecordingPlatform>).recordClip === 'function' &&
    typeof (platform as Partial<VideoRecordingPlatform>).stopRecording === 'function' &&
    typeof (platform as Partial<VideoRecordingPlatform>).cancelRecording === 'function'
  );
}

interface ContributionFailure {
  message: string;
  retryable: boolean;
  reason?: 'quota_exceeded';
}

function quotaFailure(code: string | undefined): boolean {
  return (
    code === 'quota_exceeded' ||
    code === 'upload_quota_exceeded' ||
    code === 'contribution_quota_exceeded'
  );
}

/**
 * A retry is only safe when the same contribution may be submitted again.
 * Runtime errors carry status/code metadata; do not infer retryability from
 * the upload progress because processing can fail after upload is complete.
 */
export function classifyContributionFailure(error: unknown): ContributionFailure {
  const message = userMessage(error, 'The clip could not be uploaded.');
  if (error instanceof ClipUploadError) {
    return {
      message,
      retryable: error.retryable && !quotaFailure(error.code),
      ...(quotaFailure(error.code) ? { reason: 'quota_exceeded' as const } : {}),
    };
  }
  if (error instanceof LocalRuntimeError) {
    if (quotaFailure(error.code)) return { message, retryable: false, reason: 'quota_exceeded' };
    if (error.status !== undefined && error.status >= 400 && error.status < 500) {
      return { message, retryable: false };
    }
    if (
      [
        'authorization',
        'forbidden',
        'invalid_duration',
        'invalid_metadata',
        'missing_source',
        'not_found',
        'quota_exceeded',
        'source_unavailable',
        'validation',
      ].includes(error.code ?? '')
    ) {
      return { message, retryable: false };
    }
    return { message, retryable: true };
  }
  return { message, retryable: true };
}

export function isUploadCancellation(error: unknown): boolean {
  return (
    (error instanceof ClipUploadError && error.code === 'cancelled') ||
    (error instanceof Error && error.message === 'The upload was cancelled.')
  );
}
