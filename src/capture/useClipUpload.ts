import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';

import type { ClipUploadInput, PendingClipUpload, RecordedClip } from '../domain/video';
import { userMessage } from '../domain/user-message';
import { ClipUploadError, type ClipUploadProgress } from './clip-uploader';
import {
  EXHAUSTED_UPLOAD_MESSAGE,
  INTERRUPTED_UPLOAD_MESSAGE,
  reconcileContributionStatus,
} from './capture-interruption';
import type { ContributionStatus } from './contribution-status';
import { readManagedRecordedClipBase64 } from './platform';
import { applyRetroLookToVideo, canProcessRetroVideo, RetroProcessingError } from './retro-browser';
import type { ClipReviewSession } from './video-review';
import { validateRecordedClip } from './video-recording';
import {
  MAX_PROCESSED_CLIP_SECONDS,
  classifyContributionFailure,
  isUploadCancellation,
} from './video-capture-helpers';
import type { useCaptureLifecycle } from './useCaptureLifecycle';
import type { useClipReviewState } from './useClipReviewState';
import type { useVideoCaptureRuntime } from './useVideoCaptureRuntime';

export interface ClipUploadOptions {
  runtime: ReturnType<typeof useVideoCaptureRuntime>;
  reviewState: ReturnType<typeof useClipReviewState>;
  lifecycle: ReturnType<typeof useCaptureLifecycle>;
  setError: (message: string | null) => void;
  toast: (message: string) => void;
}

/**
 * Sealing a reviewed clip: the optional on-device retro look, upload, server
 * processing, retry and cancel, and the contribution status each step reports.
 */
export function useClipUpload({
  runtime,
  reviewState,
  lifecycle,
  setError,
  toast,
}: ClipUploadOptions) {
  const {
    activeRuntimeClient,
    ownsRealRuntime,
    transferMode,
    uploadGroupId,
    uploadSession,
    uploadSessionId,
  } = runtime;
  const { clip, review, setClip, setReview } = reviewState;
  const {
    beginContributionWork,
    clipRef,
    contributionStatus,
    finishContributionWork,
    invalidateContributionWork,
    isCaptureActive,
    isContributionWorkActive,
    processedUriRef,
    releaseOwnedClip,
    retroAbortRef,
    reviewRef,
    setContributionStatus,
    statusContext,
    statusContextRef,
    unmountReviewPlayer,
  } = lifecycle;
  // Web applies the retro look on this device before upload (null when idle).
  const [retroPercent, setRetroPercent] = useState<number | null>(null);
  const [uploadProgress, setUploadProgress] = useState<ClipUploadProgress>({
    status: 'idle',
    percent: 0,
  });
  const [retryInFlight, setRetryInFlight] = useState(false);
  // V8 shows only for a seal made on this screen, never for a restored status.
  const [sealedHere, setSealedHere] = useState(false);
  // Cancel and "Back to review" return to the review instead of V7.
  const [failureDismissed, setFailureDismissed] = useState(false);
  const latestUploadRef = useRef<PendingClipUpload | null>(null);
  const retryInFlightRef = useRef(false);
  const pendingUploadInputRef = useRef<{ signature: string; input: ClipUploadInput } | null>(null);
  const replacementTargetRef = useRef<string | null>(null);

  const describeUpload = useCallback(
    (
      uploaded: PendingClipUpload,
      state: ContributionStatus['state'],
      options: Pick<ContributionStatus, 'message' | 'retryable' | 'reason'> = {
        retryable: state === 'failed',
      },
    ): ContributionStatus => ({
      contributionId: uploaded.contribution.id,
      createdAt: uploaded.contribution.createdAt,
      durationSeconds: uploaded.contribution.durationSeconds,
      jobId: uploaded.job.id,
      deletionAvailability: 'available',
      ...options,
      state,
    }),
    [],
  );

  const processUploaded = useCallback(
    async (
      uploaded: PendingClipUpload,
      operation: number,
    ): Promise<PendingClipUpload['job'] | null> => {
      if (!isContributionWorkActive(operation)) return null;
      latestUploadRef.current = uploaded;
      setContributionStatus(describeUpload(uploaded, 'queued'));
      if (!activeRuntimeClient?.processClipJob || !uploadSessionId || !uploadGroupId)
        return uploaded.job;

      setContributionStatus(describeUpload(uploaded, 'processing'));
      const processed = await activeRuntimeClient.processClipJob(
        uploadSessionId,
        uploadGroupId,
        uploaded.job.id,
      );
      if (!isContributionWorkActive(operation)) return null;
      if (processed.status === 'ready') {
        setContributionStatus(describeUpload(uploaded, 'sealed'));
        setSealedHere(true);
      } else if (processed.status === 'processing') {
        setContributionStatus(describeUpload(uploaded, 'processing'));
      } else if (processed.status === 'failed') {
        setContributionStatus(
          describeUpload(uploaded, 'failed', {
            message: 'The clip could not be processed. Retry the job.',
            retryable: true,
          }),
        );
      } else if (processed.status === 'cancelled') {
        setContributionStatus(
          describeUpload(uploaded, 'failed', {
            message: 'The contribution was cancelled. Retake it to submit a new contribution.',
            retryable: false,
          }),
        );
      } else {
        setContributionStatus(describeUpload(uploaded, 'queued'));
      }
      await statusContext?.refreshStatus();
      return processed;
    },
    [
      activeRuntimeClient,
      describeUpload,
      isContributionWorkActive,
      setContributionStatus,
      statusContext,
      uploadGroupId,
      uploadSessionId,
    ],
  );

  const completeSubmittedReview = useCallback(
    async (
      ownedClip: RecordedClip,
      ownedReview: ClipReviewSession,
      operation: number,
      cleanupMessage: string,
    ): Promise<boolean> => {
      await unmountReviewPlayer();
      if (!isContributionWorkActive(operation)) return false;
      await ownedReview.retake().catch(() => undefined);
      if (!isContributionWorkActive(operation)) return false;

      clipRef.current = null;
      reviewRef.current = null;
      setClip(null);
      setReview(null);
      try {
        await releaseOwnedClip(ownedClip);
      } catch {
        if (isContributionWorkActive(operation)) setError(cleanupMessage);
      }
      return isContributionWorkActive(operation);
    },
    [
      clipRef,
      isContributionWorkActive,
      releaseOwnedClip,
      reviewRef,
      setClip,
      setError,
      setReview,
      unmountReviewPlayer,
    ],
  );

  /** Saves the pending record and stages the source before the upload session sends it. */
  const createPrepareInput =
    (ownedReview: ClipReviewSession, operation: number) =>
    async (input: ClipUploadInput, signal?: AbortSignal): Promise<ClipUploadInput> => {
      await ownedReview.savePending(input.idempotencyKey);
      if (!isContributionWorkActive(operation)) {
        throw new ClipUploadError('The upload was cancelled.', { code: 'cancelled' });
      }
      if (
        activeRuntimeClient?.stageClipSource &&
        uploadSessionId &&
        uploadGroupId &&
        !(ownsRealRuntime && (transferMode === 'direct' || input.sourceUri.startsWith('blob:')))
      ) {
        const sourceData = await readManagedRecordedClipBase64(input.sourceUri, signal);
        if (!isContributionWorkActive(operation)) {
          throw new ClipUploadError('The upload was cancelled.', { code: 'cancelled' });
        }
        const staged = await activeRuntimeClient.stageClipSource(
          uploadSessionId,
          uploadGroupId,
          input.idempotencyKey,
          sourceData,
          signal,
        );
        if (!isContributionWorkActive(operation)) {
          throw new ClipUploadError('The upload was cancelled.', { code: 'cancelled' });
        }
        return { ...input, sourceUri: staged.uri, byteLength: staged.byteLength };
      }
      return input;
    };

  const upload = async () => {
    if (!isCaptureActive()) return;
    if (!review || !clip || !uploadSession) {
      setError(
        'Server-backed clip upload is unavailable without the local runtime. Captured media is not synchronized offline.',
      );
      return;
    }
    try {
      validateRecordedClip(clip);
    } catch (validationError) {
      setError(userMessage(validationError, 'The selected clip metadata could not be verified.'));
      return;
    }
    if (!clip.hasAudio || clip.mimeType !== 'video/mp4') {
      setError(
        'The selected clip must be an MP4 with an audio track; the server verifies it before accepting the upload.',
      );
      return;
    }
    setFailureDismissed(false);
    const reviewMetadata = review.getReview();
    const signature = JSON.stringify([
      clip.sourceUri,
      reviewMetadata.mode,
      reviewMetadata.startSeconds,
      reviewMetadata.endSeconds,
      reviewMetadata.durationSeconds,
      replacementTargetRef.current,
    ]);
    let pendingInput = pendingUploadInputRef.current;
    if (!pendingInput || pendingInput.signature !== signature) {
      if (retroAbortRef.current) return;
      let media = {
        byteLength: clip.byteLength ?? 0,
        clientProcessed: false,
        height: clip.height,
        sourceDurationSeconds: reviewMetadata.durationSeconds,
        sourceUri: clip.sourceUri,
        trimEndSeconds: reviewMetadata.endSeconds,
        trimStartSeconds: reviewMetadata.startSeconds,
        width: clip.width,
      };
      // Web applies the look here, before upload, and sends the already
      // trimmed result. Native apps (and browsers that cannot re-encode)
      // upload the original and the server applies the same look.
      if (Platform.OS === 'web' && canProcessRetroVideo()) {
        const controller = new AbortController();
        retroAbortRef.current = controller;
        setRetroPercent(0);
        setError(null);
        try {
          const processed = await applyRetroLookToVideo(
            {
              capturedAt: new Date(),
              endSeconds: reviewMetadata.endSeconds,
              mode: reviewMetadata.mode,
              sourceUri: clip.sourceUri,
              startSeconds: reviewMetadata.startSeconds,
            },
            {
              signal: controller.signal,
              onProgress: (percent) => {
                if (!controller.signal.aborted) setRetroPercent(percent);
              },
            },
          );
          if (controller.signal.aborted || !isCaptureActive() || clipRef.current !== clip) {
            URL.revokeObjectURL(processed.sourceUri);
            return;
          }
          if (processedUriRef.current) URL.revokeObjectURL(processedUriRef.current);
          processedUriRef.current = processed.sourceUri;
          const durationSeconds = Math.min(
            Math.floor(processed.durationSeconds * 100) / 100,
            MAX_PROCESSED_CLIP_SECONDS,
          );
          media = {
            byteLength: processed.byteLength,
            clientProcessed: true,
            height: processed.height,
            sourceDurationSeconds: processed.durationSeconds,
            sourceUri: processed.sourceUri,
            trimEndSeconds: durationSeconds,
            trimStartSeconds: 0,
            width: processed.width,
          };
        } catch (processingError) {
          if (!isCaptureActive()) return;
          const cancelled =
            processingError instanceof RetroProcessingError && processingError.cancelled;
          const detail = userMessage(processingError, 'The retro look could not be applied.');
          setError(
            cancelled
              ? 'The retro look was cancelled. Your original clip is kept; upload again to retry.'
              : `${detail} Your original clip is kept; try uploading again.`,
          );
          return;
        } finally {
          if (retroAbortRef.current === controller) retroAbortRef.current = null;
          if (isCaptureActive()) setRetroPercent(null);
        }
      }
      pendingInput = {
        signature,
        input: {
          byteLength: media.byteLength,
          durationSeconds: media.trimEndSeconds - media.trimStartSeconds,
          hasAudio: clip.hasAudio,
          height: media.height,
          idempotencyKey: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          mimeType: clip.mimeType,
          mode: reviewMetadata.mode,
          ...(media.clientProcessed ? { clientProcessed: true } : {}),
          sourceUri: media.sourceUri,
          sourceDurationSeconds: media.sourceDurationSeconds,
          trimEndSeconds: media.trimEndSeconds,
          trimStartSeconds: media.trimStartSeconds,
          width: media.width,
          ...(replacementTargetRef.current
            ? { replacesContributionId: replacementTargetRef.current }
            : {}),
        },
      };
      pendingUploadInputRef.current = pendingInput;
    }
    const operation = beginContributionWork(true);
    const prepareInput = createPrepareInput(review, operation);
    try {
      const uploaded = await uploadSession.upload(
        pendingInput.input,
        (progress) => {
          if (isContributionWorkActive(operation)) setUploadProgress(progress);
        },
        prepareInput,
      );
      if (!isContributionWorkActive(operation)) return;
      const processed = await processUploaded(uploaded, operation);
      if (!processed || !isContributionWorkActive(operation)) return;
      if (processed.status === 'ready') {
        if (pendingInput.input.replacesContributionId === replacementTargetRef.current) {
          replacementTargetRef.current = null;
        }
        if (
          await completeSubmittedReview(
            clip,
            review,
            operation,
            'The clip is processed, but its local cache file could not be removed.',
          )
        ) {
          pendingUploadInputRef.current = null;
          uploadSession.forget();
        }
      }
    } catch (uploadError) {
      if (!isContributionWorkActive(operation)) return;
      const failure = classifyContributionFailure(uploadError);
      const cancelled = isUploadCancellation(uploadError);
      const retryable = uploadSession.canRetry() && (failure.retryable || cancelled);
      const reported = cancelled
        ? { message: INTERRUPTED_UPLOAD_MESSAGE, retryable }
        : {
            message: failure.message,
            retryable,
            ...(failure.reason ? { reason: failure.reason } : {}),
          };
      if (cancelled) setUploadProgress({ status: 'cancelled', percent: 0 });
      const uploaded = latestUploadRef.current;
      setContributionStatus(
        uploaded
          ? describeUpload(uploaded, 'failed', reported)
          : {
              createdAt: new Date().toISOString(),
              durationSeconds: review.getReview().endSeconds - review.getReview().startSeconds,
              ...reported,
              state: 'failed',
            },
      );
      setError(reported.message);
    } finally {
      finishContributionWork(operation);
    }
  };

  const retryUpload = async () => {
    // Guard synchronously as two presses can arrive before React commits the
    // busy state. A second retry would supersede the first upload generation;
    // because both use the same idempotency key, its late response could then
    // cancel the job owned by the winning retry.
    if (!isCaptureActive() || retryInFlightRef.current) return;
    // A retry needs an input this mount captured or restored. Once the attempt
    // budget is spent the action is terminal, so report it instead of silently
    // looping on a transport that keeps failing.
    if (uploadSession && !uploadSession.canRetry()) {
      const stored = statusContextRef.current?.status ?? contributionStatus;
      if (stored) {
        setContributionStatus(
          reconcileContributionStatus(stored, { attemptsRemaining: 0, resumable: true })!,
        );
      }
      setError(EXHAUSTED_UPLOAD_MESSAGE);
      return;
    }
    if (!review || !clip || !uploadSession) return;
    retryInFlightRef.current = true;
    setRetryInFlight(true);
    setFailureDismissed(false);
    toast('Uploading again. It finishes in the background.');
    const operation = beginContributionWork(true);
    const prepareInput = createPrepareInput(review, operation);
    try {
      const retried = await uploadSession.retry((progress) => {
        if (isContributionWorkActive(operation)) setUploadProgress(progress);
      }, prepareInput);
      if (retried && isContributionWorkActive(operation)) {
        const processed = await processUploaded(retried, operation);
        if (processed?.status === 'ready' && isContributionWorkActive(operation)) {
          const replacedContributionId =
            pendingUploadInputRef.current?.input.replacesContributionId;
          if (replacedContributionId === replacementTargetRef.current) {
            replacementTargetRef.current = null;
          }
          if (
            clip &&
            review &&
            (await completeSubmittedReview(
              clip,
              review,
              operation,
              'The clip is sealed, but its local cache file could not be removed.',
            ))
          ) {
            pendingUploadInputRef.current = null;
            uploadSession.forget();
          }
        }
      }
    } catch (uploadError) {
      if (!isContributionWorkActive(operation)) return;
      const failure = classifyContributionFailure(uploadError);
      const cancelled = isUploadCancellation(uploadError);
      const uploaded = latestUploadRef.current;
      // Once the bounded budget is spent the failure is terminal. Reporting it
      // as retryable would offer an action that can never succeed.
      const exhausted = !uploadSession.canRetry();
      const reported = exhausted
        ? { message: EXHAUSTED_UPLOAD_MESSAGE, retryable: false }
        : cancelled
          ? { message: INTERRUPTED_UPLOAD_MESSAGE, retryable: true }
          : {
              message: failure.message,
              retryable: failure.retryable,
              ...(failure.reason ? { reason: failure.reason } : {}),
            };
      if (cancelled) setUploadProgress({ status: 'cancelled', percent: 0 });
      if (uploaded) setContributionStatus(describeUpload(uploaded, 'failed', reported));
      else
        setContributionStatus({
          createdAt: new Date().toISOString(),
          durationSeconds: review.getReview().endSeconds - review.getReview().startSeconds,
          ...reported,
          state: 'failed',
        });
      setError(reported.message);
    } finally {
      retryInFlightRef.current = false;
      if (isCaptureActive()) setRetryInFlight(false);
      finishContributionWork(operation);
    }
  };

  const cancelUpload = useCallback(async () => {
    if (!isCaptureActive() || !uploadSession || uploadProgress.status !== 'uploading') {
      return;
    }
    // Update the route synchronously. The transport may never settle (for
    // example, after a dropped runtime connection), but the user must still
    // leave the uploading state and be able to retry.
    invalidateContributionWork();
    setUploadProgress({ status: 'cancelled', percent: 0 });
    const retryable = uploadSession.canRetry();
    const message = retryable ? INTERRUPTED_UPLOAD_MESSAGE : EXHAUSTED_UPLOAD_MESSAGE;
    const uploaded = latestUploadRef.current;
    setContributionStatus(
      uploaded
        ? describeUpload(uploaded, 'failed', { message, retryable })
        : {
            createdAt: new Date().toISOString(),
            durationSeconds: review?.getReview().endSeconds,
            message,
            retryable,
            state: 'failed',
          },
    );
    // Cancel keeps the moment in review; it isn't counted until sealed.
    setFailureDismissed(true);
    setError(null);
    toast('Upload cancelled. Your moment is still here to seal.');
    try {
      await uploadSession.cancel();
    } catch (cancelError) {
      if (!isCaptureActive()) return;
      setFailureDismissed(false);
      const failure = classifyContributionFailure(cancelError);
      setUploadProgress({ status: 'failed', percent: 10, message: failure.message });
      setError(`The upload could not be cancelled. ${failure.message}`);
    }
  }, [
    describeUpload,
    invalidateContributionWork,
    isCaptureActive,
    review,
    setError,
    setContributionStatus,
    uploadProgress.status,
    uploadSession,
    toast,
  ]);

  return {
    cancelUpload,
    describeUpload,
    failureDismissed,
    latestUploadRef,
    pendingUploadInputRef,
    replacementTargetRef,
    retroPercent,
    retryInFlight,
    retryUpload,
    sealedHere,
    setFailureDismissed,
    setSealedHere,
    setUploadProgress,
    upload,
    uploadProgress,
  };
}
