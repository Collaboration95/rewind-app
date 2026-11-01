import { useCallback } from 'react';

import { LocalRuntimeError } from '../runtime/local-runtime-client';
import { userMessage } from '../domain/user-message';
import type { useCaptureLifecycle } from './useCaptureLifecycle';
import type { useClipReviewState } from './useClipReviewState';
import type { useClipUpload } from './useClipUpload';
import type { useVideoCaptureRuntime } from './useVideoCaptureRuntime';

export interface ClipReplacementOptions {
  runtime: ReturnType<typeof useVideoCaptureRuntime>;
  reviewState: ReturnType<typeof useClipReviewState>;
  lifecycle: ReturnType<typeof useCaptureLifecycle>;
  upload: ReturnType<typeof useClipUpload>;
  setError: (message: string | null) => void;
  setMomentsOpen: (open: boolean) => void;
  onContributionDeleted?: () => void;
}

/**
 * Discarding the current clip to start over: Retake, and deleting a sealed
 * contribution so its allowance can be used for a replacement.
 */
export function useClipReplacement({
  runtime,
  reviewState,
  lifecycle,
  upload,
  setError,
  setMomentsOpen,
  onContributionDeleted,
}: ClipReplacementOptions) {
  const { activeRuntimeClient, recorder, uploadGroupId, uploadSession, uploadSessionId } = runtime;
  const { clip, review, setClip, setReview } = reviewState;
  const {
    clearContributionStatus,
    clipRef,
    contributionStatus,
    contributionWorkRef,
    invalidateContributionWork,
    isCaptureActive,
    releaseOwnedClip,
    retroAbortRef,
    setContributionStatus,
    setReviewPlayerVisible,
    statusContext,
    unmountReviewPlayer,
  } = lifecycle;
  const {
    latestUploadRef,
    pendingUploadInputRef,
    replacementTargetRef,
    setUploadProgress,
    uploadProgress,
  } = upload;

  const retake = async () => {
    retroAbortRef.current?.abort();
    const currentClip = clip;
    if (contributionWorkRef.current) invalidateContributionWork();
    if (
      uploadSession &&
      uploadProgress.status !== 'idle' &&
      uploadProgress.status !== 'cancelled'
    ) {
      try {
        await uploadSession.cancel();
      } catch (cancelError) {
        setError(
          `The queued clip could not be cancelled. ${userMessage(cancelError, 'Try again.')}`,
        );
        return;
      }
    }
    if (!isCaptureActive()) return;
    await unmountReviewPlayer();
    try {
      if (currentClip) await releaseOwnedClip(currentClip);
    } catch {
      if (currentClip) clipRef.current = currentClip;
      setReviewPlayerVisible(true);
      setError('The clip could not be removed from local storage. Try again.');
      return;
    }
    await review?.retake();
    recorder?.reset();
    uploadSession?.forget();
    pendingUploadInputRef.current = null;
    setClip(null);
    setReview(null);
    setReviewPlayerVisible(true);
    setUploadProgress({ status: 'idle', percent: 0 });
    latestUploadRef.current = null;
    clearContributionStatus();
    setError(null);
  };

  const canDeleteContribution = Boolean(
    contributionStatus?.contributionId &&
    activeRuntimeClient?.deleteContribution &&
    uploadSessionId &&
    uploadGroupId &&
    contributionStatus.state !== 'processing' &&
    contributionStatus.deletionAvailability !== 'used' &&
    contributionStatus.deletionAvailability !== 'unavailable',
  );

  const deleteContributionForReplacement = useCallback(async () => {
    if (
      !isCaptureActive() ||
      !canDeleteContribution ||
      !contributionStatus?.contributionId ||
      !activeRuntimeClient?.deleteContribution ||
      !uploadSessionId ||
      !uploadGroupId
    )
      return;
    try {
      await activeRuntimeClient.deleteContribution(
        uploadSessionId,
        uploadGroupId,
        contributionStatus.contributionId,
      );
      replacementTargetRef.current = contributionStatus.contributionId;
      const currentClip = clipRef.current;
      if (currentClip) {
        await unmountReviewPlayer();
        await releaseOwnedClip(currentClip);
      }
      recorder?.reset();
      setClip(null);
      setReview(null);
      setReviewPlayerVisible(true);
      setUploadProgress({ status: 'idle', percent: 0 });
      latestUploadRef.current = null;
      clearContributionStatus();
      await statusContext?.refreshStatus();
      onContributionDeleted?.();
      setMomentsOpen(false);
      setError('Contribution deleted. Your weekly allowance is restored for a replacement.');
    } catch (deleteError) {
      if (!isCaptureActive()) return;
      if (contributionStatus) {
        const deletionAvailability =
          deleteError instanceof LocalRuntimeError &&
          deleteError.code === 'contribution_deletion_used'
            ? 'used'
            : deleteError instanceof LocalRuntimeError &&
                (deleteError.status === 404 || deleteError.status === 409)
              ? 'unavailable'
              : contributionStatus.deletionAvailability;
        if (deletionAvailability !== contributionStatus.deletionAvailability) {
          setContributionStatus({ ...contributionStatus, deletionAvailability });
        }
      }
      setError(`The contribution could not be deleted. ${userMessage(deleteError, 'Try again.')}`);
    }
  }, [
    canDeleteContribution,
    activeRuntimeClient,
    clearContributionStatus,
    clipRef,
    contributionStatus,
    isCaptureActive,
    latestUploadRef,
    onContributionDeleted,
    recorder,
    releaseOwnedClip,
    replacementTargetRef,
    setClip,
    setContributionStatus,
    setError,
    setMomentsOpen,
    setReview,
    setReviewPlayerVisible,
    setUploadProgress,
    statusContext,
    uploadGroupId,
    uploadSessionId,
    unmountReviewPlayer,
  ]);

  return { canDeleteContribution, deleteContributionForReplacement, retake };
}
