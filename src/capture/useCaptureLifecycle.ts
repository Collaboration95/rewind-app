import { useCallback, useEffect, useRef, useState } from 'react';

import type { RecordedClip } from '../domain/video';
import {
  decideInterruption,
  isLiveProcessingStatus,
  reconcileContributionStatus,
} from './capture-interruption';
import { runCaptureRestartRecovery } from './reset';
import { useOptionalContributionStatus, type ContributionStatus } from './contribution-status';
import type { BoundedVideoRecordingSession } from './video-recording';
import type { ClipUploadSession } from './clip-uploader';
import type { ClipReviewSession } from './video-review';
import { removeManagedRecordedClip } from './platform';

export interface CaptureLifecycleOptions {
  recorder: BoundedVideoRecordingSession | null;
  uploadSession: ClipUploadSession | null;
  clip: RecordedClip | null;
  review: ClipReviewSession | null;
}

/**
 * What outlives a single render of the video screen: the contribution status,
 * the generation counter that lets a leave or background event invalidate
 * in-flight work, ownership of the recorded clip's local file, the review
 * player mount handshake, and the unmount cleanup.
 */
export function useCaptureLifecycle({
  recorder,
  uploadSession,
  clip,
  review,
}: CaptureLifecycleOptions) {
  const [reviewPlayerVisible, setReviewPlayerVisible] = useState(true);
  // Web applies the retro look on this device before upload (see useClipUpload).
  const retroAbortRef = useRef<AbortController | null>(null);
  const processedUriRef = useRef<string | null>(null);
  const statusContext = useOptionalContributionStatus();
  const [localContributionStatus, setLocalContributionStatus] = useState<ContributionStatus | null>(
    null,
  );
  const contributionStatus = statusContext?.status ?? localContributionStatus;
  const setContributionStatus = useCallback(
    (next: ContributionStatus) => {
      setLocalContributionStatus(next);
      statusContext?.setStatus(next);
    },
    [statusContext],
  );
  const clearContributionStatus = useCallback(() => {
    setLocalContributionStatus(null);
    statusContext?.clearStatus();
  }, [statusContext]);

  // Keep the latest sessions available to the one lifecycle cleanup effect
  // below. The upload session can be created after the first render, so putting it directly in a mount-only
  // cleanup closure would miss an in-flight upload.
  const recorderRef = useRef(recorder);
  const uploadSessionRef = useRef(uploadSession);
  const clipRef = useRef<RecordedClip | null>(clip);
  const reviewRef = useRef<ClipReviewSession | null>(review);
  const reviewPlayerMountedRef = useRef(false);
  const reviewPlayerUnmountWaitersRef = useRef(new Set<() => void>());
  const activeUploadRef = useRef(false);
  // Contribution work owns its async operations until they finish or a
  // lifecycle event invalidates their generation. This includes staging.
  const contributionWorkRef = useRef(false);
  const contributionOperationRef = useRef(0);
  const mountedRef = useRef(true);
  const captureLeftRef = useRef(false);
  useEffect(() => {
    recorderRef.current = recorder;
  }, [recorder]);
  useEffect(() => {
    uploadSessionRef.current = uploadSession;
  }, [uploadSession]);
  useEffect(() => {
    clipRef.current = clip;
  }, [clip]);
  useEffect(() => {
    reviewRef.current = review;
  }, [review]);
  const statusContextRef = useRef(statusContext);
  useEffect(() => {
    statusContextRef.current = statusContext;
  }, [statusContext]);

  /**
   * Resolve a persisted contribution status against what this mount can
   * actually do. A reload or restart drops the in-memory upload session, so a
   * stored processing record would otherwise leave a panel claiming work that
   * no live owner is doing.
   */
  const reconcileStoredStatus = useCallback(
    (stored: ContributionStatus | null): ContributionStatus | null =>
      reconcileContributionStatus(stored, {
        attemptsRemaining: uploadSessionRef.current?.attemptsRemaining() ?? 0,
        resumable: Boolean(clipRef.current && uploadSessionRef.current?.canRetry()),
      }),
    [],
  );

  /**
   * Foreground and cold-start reconciliation. A stored queued or processing
   * record with no upload running in this mount has lost its owner, so it is
   * replaced with an honest bounded retry rather than a stuck processing panel.
   */
  const reconcileInterruptedUpload = useCallback(() => {
    const context = statusContextRef.current;
    const stored = context?.status ?? null;
    if (!context || activeUploadRef.current || contributionWorkRef.current) return;
    const resumable = Boolean(clipRef.current && uploadSessionRef.current?.canRetry());
    if (stored?.state === 'failed' && stored.retryable && !resumable) {
      context.clearStatus();
      return;
    }
    if (!isLiveProcessingStatus(stored)) return;
    context.setStatus(reconcileStoredStatus(stored)!);
  }, [reconcileStoredStatus]);

  const isCaptureActive = useCallback(() => mountedRef.current && !captureLeftRef.current, []);
  const beginContributionWork = useCallback((upload: boolean): number => {
    const operation = ++contributionOperationRef.current;
    contributionWorkRef.current = true;
    activeUploadRef.current = upload;
    return operation;
  }, []);
  const isContributionWorkActive = useCallback(
    (operation: number): boolean =>
      operation === contributionOperationRef.current && isCaptureActive(),
    [isCaptureActive],
  );
  const invalidateContributionWork = useCallback(() => {
    contributionOperationRef.current += 1;
    contributionWorkRef.current = false;
    activeUploadRef.current = false;
  }, []);
  const finishContributionWork = useCallback((operation: number) => {
    if (operation !== contributionOperationRef.current) return;
    contributionWorkRef.current = false;
    activeUploadRef.current = false;
  }, []);
  const releaseProcessedClip = useCallback(() => {
    retroAbortRef.current?.abort();
    const processedUri = processedUriRef.current;
    processedUriRef.current = null;
    if (processedUri) URL.revokeObjectURL(processedUri);
  }, []);
  const releaseOwnedClip = useCallback(
    async (ownedClip: RecordedClip | null): Promise<void> => {
      releaseProcessedClip();
      if (!ownedClip) return;
      if (clipRef.current?.sourceUri === ownedClip.sourceUri) clipRef.current = null;
      await removeManagedRecordedClip(ownedClip.sourceUri);
    },
    [releaseProcessedClip],
  );

  const onReviewPlayerMounted = useCallback(() => {
    reviewPlayerMountedRef.current = true;
  }, []);
  const onReviewPlayerUnmounted = useCallback(() => {
    reviewPlayerMountedRef.current = false;
    for (const resolve of reviewPlayerUnmountWaitersRef.current) resolve();
    reviewPlayerUnmountWaitersRef.current.clear();
  }, []);
  const waitForReviewPlayerUnmount = useCallback((): Promise<void> => {
    if (!reviewPlayerMountedRef.current) return Promise.resolve();
    return new Promise((resolve) => reviewPlayerUnmountWaitersRef.current.add(resolve));
  }, []);
  const unmountReviewPlayer = useCallback(async (): Promise<void> => {
    const unmounted = waitForReviewPlayerUnmount();
    setReviewPlayerVisible(false);
    await unmounted;
  }, [waitForReviewPlayerUnmount]);

  const cancelActiveWork = useCallback((): Promise<void> => {
    if (captureLeftRef.current) return Promise.resolve();
    captureLeftRef.current = true;
    const cancelUpload = activeUploadRef.current;
    invalidateContributionWork();
    const routeChange = decideInterruption('route-change');
    if (routeChange.cancelRecording) recorderRef.current?.cancel();
    if (routeChange.cancelUploadRequest && cancelUpload) {
      const cancellation = uploadSessionRef.current?.cancel();
      return cancellation?.catch(() => undefined) ?? Promise.resolve();
    }
    return Promise.resolve();
  }, [invalidateContributionWork]);

  useEffect(() => {
    if (!decideInterruption('restart').sweepOrphanedFiles) return;
    // On a cold start, reclaim app-owned media that no live session can reach.
    // The status reconcile below then reports the interruption honestly.
    void runCaptureRestartRecovery();
  }, []);

  // A restored contribution status can arrive after the first render, once the
  // status store has loaded. Reconcile it whenever a live-looking record
  // appears without an upload running in this mount.
  useEffect(() => {
    reconcileInterruptedUpload();
  }, [contributionStatus, reconcileInterruptedUpload]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      releaseProcessedClip();
      const currentClip = clipRef.current;
      clipRef.current = null;
      reviewRef.current = null;
      void cancelActiveWork().finally(async () => {
        await waitForReviewPlayerUnmount();
        if (currentClip)
          void removeManagedRecordedClip(currentClip.sourceUri).catch(() => undefined);
      });
    };
  }, [cancelActiveWork, releaseProcessedClip, waitForReviewPlayerUnmount]);

  const leaveCapture = useCallback(
    (exit: (() => void) | undefined) => {
      const currentClip = clipRef.current;
      clipRef.current = null;
      reviewRef.current = null;
      void cancelActiveWork().finally(async () => {
        await waitForReviewPlayerUnmount();
        if (currentClip)
          void removeManagedRecordedClip(currentClip.sourceUri).catch(() => undefined);
      });
      exit?.();
    },
    [cancelActiveWork, waitForReviewPlayerUnmount],
  );

  return {
    activeUploadRef,
    beginContributionWork,
    cancelActiveWork,
    clearContributionStatus,
    clipRef,
    contributionStatus,
    contributionWorkRef,
    finishContributionWork,
    invalidateContributionWork,
    isCaptureActive,
    isContributionWorkActive,
    leaveCapture,
    processedUriRef,
    reconcileInterruptedUpload,
    recorderRef,
    releaseOwnedClip,
    releaseProcessedClip,
    retroAbortRef,
    reviewPlayerVisible,
    reviewRef,
    setContributionStatus,
    setReviewPlayerVisible,
    statusContext,
    statusContextRef,
    unmountReviewPlayer,
    uploadSessionRef,
    onReviewPlayerMounted,
    onReviewPlayerUnmounted,
    waitForReviewPlayerUnmount,
  };
}
