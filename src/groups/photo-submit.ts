import type { CameraCaptureScreenProps, PhotoRetroLook } from '../capture/CameraCaptureScreen';
import type { ContributionStatus } from '../capture/contribution-status';
import type { createRealAccountVideoRuntimeClient } from '../capture/real-account-video-runtime';
import { DEFAULT_CAPTURE_MODE, type PendingClipUpload } from '../domain/video';

type PhotoJobStatus = PendingClipUpload['job']['status'];
type PhotoStatusDetails = Pick<
  ContributionStatus,
  'contributionId' | 'createdAt' | 'durationSeconds' | 'jobId'
>;

export function photoContributionStatusForJob(
  status: PhotoJobStatus,
  details: PhotoStatusDetails,
): ContributionStatus {
  if (status === 'ready') return { state: 'sealed', ...details, retryable: false };
  if (status === 'failed' || status === 'cancelled') {
    return {
      state: 'failed',
      ...details,
      message: 'The photo could not be processed. Retry this contribution.',
      retryable: true,
    };
  }
  return {
    state: status === 'pending' ? 'queued' : 'processing',
    ...details,
    retryable: false,
  };
}

/** Stage the photo, register the contribution, process it, and report progress as it goes. */
export async function submitPhotoContribution(
  mediaClient: ReturnType<typeof createRealAccountVideoRuntimeClient>,
  groupId: string,
  metadata: Parameters<CameraCaptureScreenProps['onSubmitPhoto']>[0],
  base64: string,
  onProgress: (status: ContributionStatus) => void,
  replacesContributionId?: string,
  look: PhotoRetroLook = { mode: DEFAULT_CAPTURE_MODE, clientProcessed: false },
): Promise<ContributionStatus> {
  if (!mediaClient.uploadClip || !mediaClient.processClipJob) {
    throw new Error('Photo contribution upload is unavailable. Retry shortly.');
  }
  const { mimeType } = metadata;
  // Client-graded bytes differ per look, so each look gets its own key.
  const idempotencyKey = look.clientProcessed ? `${metadata.id}-${look.mode}` : metadata.id;
  const staged = await mediaClient.stagePhotoSource(
    'real-account-session',
    groupId,
    idempotencyKey,
    base64,
    mimeType,
  );
  const upload = await mediaClient.uploadClip('real-account-session', groupId, {
    mediaType: 'photo',
    idempotencyKey,
    sourceUri: staged.uri,
    mimeType,
    byteLength: staged.byteLength,
    durationSeconds: 3,
    width: metadata.width,
    height: metadata.height,
    hasAudio: true,
    mode: look.mode,
    ...(look.clientProcessed ? { clientProcessed: true } : {}),
    trimStartSeconds: 0,
    trimEndSeconds: 3,
    ...(replacesContributionId ? { replacesContributionId } : {}),
  });
  const sharedStatus = {
    contributionId: upload.contribution.id,
    jobId: upload.job.id,
    durationSeconds: 3,
    createdAt: upload.contribution.createdAt,
    retryable: true,
  };
  onProgress({ state: 'queued', ...sharedStatus });
  onProgress({ state: 'processing', ...sharedStatus });
  const job = await mediaClient.processClipJob('real-account-session', groupId, upload.job.id);
  const finalStatus = photoContributionStatusForJob(job.status, sharedStatus);
  onProgress(finalStatus);
  if (finalStatus.state === 'failed') {
    throw new Error(finalStatus.message ?? 'The photo could not be processed. Retry this photo.');
  }
  return finalStatus;
}
