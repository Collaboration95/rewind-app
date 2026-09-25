import { MAX_CLIP_UPLOAD_ATTEMPTS } from './clip-uploader';
import type { ContributionStatus } from './contribution-status';

/**
 * Capture interruption policy.
 *
 * Recording and upload can be interrupted by the platform at any point.
 * Instead of letting every screen invent its own cleanup, every lifecycle
 * event resolves to one explicit, testable decision: what to cancel, what to
 * keep, and whether anything durable has to be reconciled. A disposition is
 * never implicit, and no path silently keeps an orphaned local capture.
 */
export type CaptureInterruptionEvent =
  | 'background'
  | 'foreground'
  | 'route-change'
  | 'reload'
  | 'restart'
  | 'sign-out'
  | 'reset'
  | 'interrupted-upload';

export const CAPTURE_INTERRUPTION_EVENTS: readonly CaptureInterruptionEvent[] = [
  'background',
  'foreground',
  'route-change',
  'reload',
  'restart',
  'sign-out',
  'reset',
  'interrupted-upload',
];

export interface CaptureInterruptionDecision {
  /** Cancel an in-progress recording and discard its partial file. */
  cancelRecording: boolean;
  /** Cancel the in-flight upload request on the transport. */
  cancelUploadRequest: boolean;
  /** Release the managed local capture file immediately. */
  releaseLocalCapture: boolean;
  /** Keep the managed local capture so a bounded retry can reuse it. */
  retainLocalCaptureForRetry: boolean;
  /** Discard an unaccepted still/clip preview. */
  discardPreview: boolean;
  /** Remove accepted still metadata. */
  clearAcceptedMetadata: boolean;
  /** Remove the persisted contribution status record. */
  clearContributionStatus: boolean;
  /** Convert a persisted queued/processing status into an honest bounded state. */
  reconcileContributionStatus: boolean;
  /** Re-run capability and permission checks. */
  recheckAccess: boolean;
  /** Remove local capture blobs that no live session owns. */
  sweepOrphanedFiles: boolean;
}

const DECISIONS: Record<CaptureInterruptionEvent, CaptureInterruptionDecision> = {
  // The route stays mounted, so the review state survives. A recording cannot
  // continue while suspended, and the upload request is dropped, but the local
  // clip is kept so the user can retry the same contribution afterwards.
  background: {
    cancelRecording: true,
    cancelUploadRequest: true,
    releaseLocalCapture: false,
    retainLocalCaptureForRetry: true,
    discardPreview: false,
    clearAcceptedMetadata: false,
    clearContributionStatus: false,
    reconcileContributionStatus: false,
    recheckAccess: false,
    sweepOrphanedFiles: false,
  },
  // Access may have changed while suspended, and a dropped upload is no
  // longer progress. Reconcile it instead of rendering a live processing panel.
  foreground: {
    cancelRecording: false,
    cancelUploadRequest: false,
    releaseLocalCapture: false,
    retainLocalCaptureForRetry: true,
    discardPreview: false,
    clearAcceptedMetadata: false,
    clearContributionStatus: false,
    reconcileContributionStatus: true,
    recheckAccess: true,
    sweepOrphanedFiles: false,
  },
  // Leaving the route destroys the review state, so the transient files go with
  // it. Accepted metadata is durable and stays.
  'route-change': {
    cancelRecording: true,
    cancelUploadRequest: true,
    releaseLocalCapture: true,
    retainLocalCaptureForRetry: false,
    discardPreview: true,
    clearAcceptedMetadata: false,
    clearContributionStatus: false,
    reconcileContributionStatus: false,
    recheckAccess: false,
    sweepOrphanedFiles: false,
  },
  // A reload or restart drops the in-memory route. Durable metadata is the only
  // resume surface, so an interrupted contribution is reconciled rather than
  // resumed, and its unreachable local blob is swept.
  reload: {
    cancelRecording: true,
    cancelUploadRequest: true,
    releaseLocalCapture: true,
    retainLocalCaptureForRetry: false,
    discardPreview: true,
    clearAcceptedMetadata: false,
    clearContributionStatus: false,
    reconcileContributionStatus: true,
    recheckAccess: true,
    sweepOrphanedFiles: true,
  },
  restart: {
    cancelRecording: true,
    cancelUploadRequest: true,
    releaseLocalCapture: true,
    retainLocalCaptureForRetry: false,
    discardPreview: true,
    clearAcceptedMetadata: false,
    clearContributionStatus: false,
    reconcileContributionStatus: true,
    recheckAccess: true,
    sweepOrphanedFiles: true,
  },
  // Ending access discards capture session state and app-owned blobs. Accepted
  // still metadata follows the existing sign-out behaviour and is untouched;
  // reset is the explicit local-data erase.
  'sign-out': {
    cancelRecording: true,
    cancelUploadRequest: true,
    releaseLocalCapture: true,
    retainLocalCaptureForRetry: false,
    discardPreview: true,
    clearAcceptedMetadata: false,
    clearContributionStatus: true,
    reconcileContributionStatus: false,
    recheckAccess: false,
    sweepOrphanedFiles: true,
  },
  reset: {
    cancelRecording: true,
    cancelUploadRequest: true,
    releaseLocalCapture: true,
    retainLocalCaptureForRetry: false,
    discardPreview: true,
    clearAcceptedMetadata: true,
    clearContributionStatus: true,
    reconcileContributionStatus: false,
    recheckAccess: false,
    sweepOrphanedFiles: true,
  },
  // A transport request that stopped without a verdict. Keep the local clip for
  // a bounded retry that reuses the same idempotency key.
  'interrupted-upload': {
    cancelRecording: false,
    cancelUploadRequest: true,
    releaseLocalCapture: false,
    retainLocalCaptureForRetry: true,
    discardPreview: false,
    clearAcceptedMetadata: false,
    clearContributionStatus: false,
    reconcileContributionStatus: true,
    recheckAccess: false,
    sweepOrphanedFiles: false,
  },
};

export function decideInterruption(event: CaptureInterruptionEvent): CaptureInterruptionDecision {
  return { ...DECISIONS[event] };
}

export const INTERRUPTED_UPLOAD_MESSAGE =
  'The upload was interrupted before it finished. Retry to send the same clip again.';
export const EXHAUSTED_UPLOAD_MESSAGE = `The upload could not be completed after ${MAX_CLIP_UPLOAD_ATTEMPTS} attempts. Retake the clip to submit a new contribution.`;
export const UNRECOVERABLE_UPLOAD_MESSAGE =
  'The interrupted upload cannot be resumed on this device. Retake the clip to submit a new contribution.';

export interface ReconcileContributionOptions {
  /**
   * Whether this route still owns the local clip, so a retry can resend it.
   * False after a reload or restart, where only durable metadata survives.
   */
  resumable: boolean;
  /** Upload attempts left in the bounded budget. */
  attemptsRemaining: number;
}

/**
 * Resolve a persisted contribution status against what this mount can actually
 * do. Only a status with no live owner is touched, and the result always offers
 * something honest: a bounded retry, or a terminal retake.
 */
export function reconcileContributionStatus(
  status: ContributionStatus | null,
  { attemptsRemaining, resumable }: ReconcileContributionOptions,
): ContributionStatus | null {
  if (!status) return null;

  if (status.state === 'sealed') return { ...status };

  if (status.state === 'processing' || status.state === 'queued') {
    return {
      ...status,
      message: resumable ? INTERRUPTED_UPLOAD_MESSAGE : UNRECOVERABLE_UPLOAD_MESSAGE,
      retryable: resumable && attemptsRemaining > 0,
      state: 'failed',
    };
  }

  // A retryable failure with an exhausted budget is terminal. Say so instead of
  // offering a button that cannot work.
  if (status.retryable && attemptsRemaining <= 0) {
    return { ...status, message: EXHAUSTED_UPLOAD_MESSAGE, retryable: false };
  }

  return { ...status };
}

/** Whether a status still claims work that no live owner is doing. */
export function isLiveProcessingStatus(status: ContributionStatus | null): boolean {
  return status?.state === 'processing' || status?.state === 'queued';
}
