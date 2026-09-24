import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CameraView } from 'expo-camera';
import { AppState, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { LocalRuntimeError, type RuntimeClient } from '../runtime/local-runtime-client';
import { useOptionalDemoSession } from '../session/DemoSessionProvider';
import { COLORS } from '../theme';
import type {
  CaptureMode,
  ClipUploadInput,
  PendingClipUpload,
  RecordedClip,
} from '../domain/video';
import { ClipUploadError, ClipUploadSession, type ClipUploadProgress } from './clip-uploader';
import {
  EXHAUSTED_UPLOAD_MESSAGE,
  INTERRUPTED_UPLOAD_MESSAGE,
  decideInterruption,
  isLiveProcessingStatus,
  reconcileContributionStatus,
} from './capture-interruption';
import { runCaptureRestartRecovery } from './reset';
import {
  ContributionStatusPanel,
  useOptionalContributionStatus,
  type ContributionStatus,
} from './contribution-status';
import {
  BoundedVideoRecordingSession,
  validateRecordedClip,
  type VideoRecordingPlatform,
} from './video-recording';
import { ClipReviewSession, InMemoryPendingClipMetadataStore } from './video-review';
import {
  ExpoCameraPlatform,
  readManagedRecordedClipBase64,
  removeManagedRecordedClip,
} from './platform';
import type { CameraPlatform } from './contracts';

type AccessStatus =
  | 'checking'
  | 'ready'
  | 'unsupported'
  | 'temporarily-unavailable'
  | 'permission-undecided'
  | 'permission-denied'
  | 'permission-blocked'
  | 'error';

export interface VideoCaptureScreenProps {
  platform?: CameraPlatform;
  runtimeClient?: RuntimeClient | null;
  onBack?: () => void;
  onContributionDeleted?: () => void;
}

function isVideoPlatform(
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
}

/**
 * A retry is only safe when the same contribution may be submitted again.
 * Runtime errors carry status/code metadata; do not infer retryability from
 * the upload progress because processing can fail after upload is complete.
 */
function classifyContributionFailure(error: unknown): ContributionFailure {
  const message = error instanceof Error ? error.message : 'The clip could not be uploaded.';
  if (error instanceof ClipUploadError) {
    return { message, retryable: error.retryable };
  }
  if (error instanceof LocalRuntimeError) {
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

function isUploadCancellation(error: unknown): boolean {
  return (
    (error instanceof ClipUploadError && error.code === 'cancelled') ||
    (error instanceof Error && error.message === 'The upload was cancelled.')
  );
}

export function VideoCaptureScreen({
  onBack,
  onContributionDeleted,
  platform: platformProp,
  runtimeClient = null,
}: VideoCaptureScreenProps = {}) {
  const cameraRef = useRef<CameraView>(null);
  const getCameraRef = useCallback(() => cameraRef.current, []);
  const platform = useMemo(
    () =>
      platformProp ??
      // eslint-disable-next-line react-hooks/refs
      new ExpoCameraPlatform({
        getCameraRef,
      }),
    [getCameraRef, platformProp],
  );
  const recorder = useMemo(
    () => (isVideoPlatform(platform) ? new BoundedVideoRecordingSession(platform) : null),
    [platform],
  );
  const demoSession = useOptionalDemoSession();
  const reviewStore = useMemo(() => new InMemoryPendingClipMetadataStore(), []);
  const [access, setAccess] = useState<AccessStatus>('checking');
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [clip, setClip] = useState<RecordedClip | null>(null);
  const [review, setReview] = useState<ClipReviewSession | null>(null);
  const [startText, setStartText] = useState('0');
  const [endText, setEndText] = useState('0');
  const [mode, setMode] = useState<CaptureMode>('soft-focus');
  const [uploadProgress, setUploadProgress] = useState<ClipUploadProgress>({
    status: 'idle',
    percent: 0,
  });
  const [creatingSyntheticClip, setCreatingSyntheticClip] = useState(false);
  const statusContext = useOptionalContributionStatus();
  const [localContributionStatus, setLocalContributionStatus] = useState<ContributionStatus | null>(
    null,
  );
  const latestUploadRef = useRef<PendingClipUpload | null>(null);
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
  const uploadSession = useMemo(() => {
    if (!runtimeClient?.uploadClip || !runtimeClient.cancelClipUpload || !demoSession?.session) {
      return null;
    }
    const { groupId, id: sessionId } = demoSession.session;
    return new ClipUploadSession({
      cancelClipUpload: (jobId) => runtimeClient.cancelClipUpload!(sessionId, groupId, jobId),
      uploadClip: (input) => runtimeClient.uploadClip!(sessionId, groupId, input),
    });
  }, [demoSession, runtimeClient]);

  // Keep the latest sessions available to the one lifecycle cleanup effect
  // below. The upload session can be created after the first render while the
  // Demo session is being restored, so putting it directly in a mount-only
  // cleanup closure would miss an in-flight upload.
  const recorderRef = useRef(recorder);
  const uploadSessionRef = useRef(uploadSession);
  const clipRef = useRef<RecordedClip | null>(clip);
  const reviewRef = useRef<ClipReviewSession | null>(review);
  const activeUploadRef = useRef(false);
  // True while this mount is driving a contribution (upload, retry, or a
  // synthetic Demo clip). A status restored from durable storage after a
  // reload has no such owner, which is what makes it reconcilable.
  const contributionWorkRef = useRef(false);
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
        resumable: Boolean(clipRef.current && uploadSessionRef.current),
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
    if (!isLiveProcessingStatus(stored)) return;
    context.setStatus(reconcileStoredStatus(stored)!);
  }, [reconcileStoredStatus]);

  const isCaptureActive = useCallback(() => mountedRef.current && !captureLeftRef.current, []);
  const releaseOwnedClip = useCallback(async (ownedClip: RecordedClip | null): Promise<void> => {
    if (!ownedClip) return;
    if (clipRef.current?.sourceUri === ownedClip.sourceUri) clipRef.current = null;
    await removeManagedRecordedClip(ownedClip.sourceUri);
  }, []);

  const replaceClip = useCallback(
    async (selected: RecordedClip): Promise<boolean> => {
      try {
        validateRecordedClip(selected);
      } catch (validationError) {
        await removeManagedRecordedClip(selected.sourceUri).catch(() => undefined);
        throw validationError;
      }
      if (!isCaptureActive()) {
        await removeManagedRecordedClip(selected.sourceUri);
        return false;
      }

      const previousClip = clipRef.current;
      try {
        await reviewRef.current?.retake();
        if (previousClip && previousClip.sourceUri !== selected.sourceUri) {
          await releaseOwnedClip(previousClip);
        }
      } catch (cleanupError) {
        await removeManagedRecordedClip(selected.sourceUri).catch(() => undefined);
        throw cleanupError;
      }
      if (!isCaptureActive()) {
        await removeManagedRecordedClip(selected.sourceUri);
        return false;
      }

      const nextReview = new ClipReviewSession(selected, reviewStore);
      clipRef.current = selected;
      reviewRef.current = nextReview;
      setClip(selected);
      setReview(nextReview);
      setStartText('0');
      setEndText(String(selected.durationSeconds));
      setMode('soft-focus');
      return true;
    },
    [isCaptureActive, releaseOwnedClip, reviewStore],
  );
  const cancelActiveWork = useCallback((): Promise<void> => {
    if (captureLeftRef.current) return Promise.resolve();
    captureLeftRef.current = true;
    const routeChange = decideInterruption('route-change');
    if (routeChange.cancelRecording) recorderRef.current?.cancel();
    if (routeChange.cancelUploadRequest && activeUploadRef.current) {
      const cancellation = uploadSessionRef.current?.cancel();
      return cancellation?.catch(() => undefined) ?? Promise.resolve();
    }
    return Promise.resolve();
  }, []);

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
      const currentClip = clipRef.current;
      clipRef.current = null;
      reviewRef.current = null;
      void cancelActiveWork().finally(() => {
        if (currentClip)
          void removeManagedRecordedClip(currentClip.sourceUri).catch(() => undefined);
      });
    };
  }, [cancelActiveWork]);

  const refresh = useCallback(async () => {
    if (!isCaptureActive()) return;
    setAccess('checking');
    setError(null);
    if (platform.kind === 'demo' || platform.supportsVideoRecording === false || !recorder) {
      setAccess('unsupported');
      return;
    }
    try {
      const [capabilities, permissions] = await Promise.all([
        platform.getCapabilities(),
        platform.getPermissions(),
      ]);
      if (!isCaptureActive()) return;
      if (capabilities.camera === 'undecided' || capabilities.microphone === 'undecided') {
        setAccess('temporarily-unavailable');
      } else if (capabilities.camera !== 'supported' || capabilities.microphone !== 'supported') {
        setAccess('unsupported');
      } else if (permissions.camera === 'blocked' || permissions.microphone === 'blocked') {
        setAccess('permission-blocked');
      } else if (
        permissions.camera === 'undetermined' ||
        permissions.microphone === 'undetermined'
      ) {
        setAccess('permission-undecided');
      } else if (permissions.camera === 'denied' || permissions.microphone === 'denied') {
        setAccess('permission-denied');
      } else {
        setAccess('ready');
      }
    } catch {
      if (!isCaptureActive()) return;
      setAccess('temporarily-unavailable');
      setError('We could not check recording access yet. Try again.');
    }
  }, [isCaptureActive, platform, recorder]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);

  // Native Settings does not tell the route when the user changes a
  // permission, so re-check on foreground. Backgrounding is an interruption:
  // a recording cannot continue while suspended, and an in-flight upload has
  // lost its transport. Both are resolved explicitly instead of being left to
  // resolve themselves, and the local clip is kept for a bounded retry.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void refresh();
        reconcileInterruptedUpload();
        return;
      }
      if (nextState === 'background' || nextState === 'inactive') {
        const decision = decideInterruption('background');
        if (decision.cancelRecording && recorderRef.current?.getState().status === 'recording') {
          recorderRef.current.cancel();
          setRecording(false);
          setRecordingStartedAt(null);
          setElapsedSeconds(0);
        }
        if (decision.cancelUploadRequest && activeUploadRef.current) {
          activeUploadRef.current = false;
          void uploadSessionRef.current?.cancel().catch(() => undefined);
          setUploadProgress({ status: 'cancelled', percent: 0 });
          if (decision.retainLocalCaptureForRetry) {
            setContributionStatus({
              createdAt: new Date().toISOString(),
              message: INTERRUPTED_UPLOAD_MESSAGE,
              retryable: uploadSessionRef.current?.canRetry() ?? false,
              state: 'failed',
            });
          }
        }
      }
    });
    return () => subscription.remove();
  }, [reconcileInterruptedUpload, refresh, setContributionStatus]);

  const requestAccess = useCallback(async () => {
    if (!isCaptureActive()) return;
    setError(null);
    try {
      await platform.requestPermissions();
      if (isCaptureActive()) await refresh();
    } catch {
      if (!isCaptureActive()) return;
      setAccess('temporarily-unavailable');
      setError('Camera access could not be checked right now. Try again or open Settings.');
    }
  }, [isCaptureActive, platform, refresh]);

  const openSettings = useCallback(async () => {
    if (!isCaptureActive()) return;
    setError(null);
    try {
      await platform.openSettings();
      if (isCaptureActive()) await refresh();
    } catch (settingsError) {
      if (!isCaptureActive()) return;
      setError(
        settingsError instanceof Error
          ? settingsError.message
          : 'Open this app settings to allow camera and microphone access.',
      );
    }
  }, [isCaptureActive, platform, refresh]);

  useEffect(() => {
    if (!recording || recordingStartedAt === null || !recorder) return undefined;
    const interval = setInterval(() => {
      const elapsed = Math.min(15, (Date.now() - recordingStartedAt) / 1000);
      recorder.setElapsed(elapsed);
      setElapsedSeconds(elapsed);
    }, 250);
    return () => clearInterval(interval);
  }, [recording, recordingStartedAt, recorder]);

  const startRecording = async () => {
    if (!isCaptureActive() || !recorder || access !== 'ready') return;
    setError(null);
    setRecording(true);
    setRecordingStartedAt(Date.now());
    setElapsedSeconds(0);
    try {
      const recorded = await recorder.start();
      if (!(await replaceClip(recorded))) return;
      setRecording(false);
      setRecordingStartedAt(null);
    } catch (recordingError) {
      if (!isCaptureActive() || recorder.getState().status === 'cancelled') return;
      setRecording(false);
      setRecordingStartedAt(null);
      setError(
        recordingError instanceof Error
          ? recordingError.message
          : 'The clip could not be recorded.',
      );
    }
  };

  const chooseVideoFile = async () => {
    if (!isCaptureActive() || !platform.pickVideoFile) return;
    setError(null);
    try {
      const selected = await platform.pickVideoFile();
      await replaceClip(selected);
    } catch (fileError) {
      if (!isCaptureActive()) return;
      setError(
        fileError instanceof Error ? fileError.message : 'The video file could not be used.',
      );
    }
  };

  const cancelRecording = () => {
    recorder?.cancel();
    setRecording(false);
    setRecordingStartedAt(null);
    setElapsedSeconds(0);
    setError(null);
  };

  const retake = async () => {
    const currentClip = clip;
    if (
      uploadSession &&
      uploadProgress.status !== 'idle' &&
      uploadProgress.status !== 'cancelled'
    ) {
      activeUploadRef.current = false;
      try {
        await uploadSession.cancel();
      } catch (cancelError) {
        setError(
          cancelError instanceof Error
            ? `The queued clip could not be cancelled. ${cancelError.message}`
            : 'The queued clip could not be cancelled. Try again.',
        );
        return;
      }
    }
    await review?.retake();
    if (!isCaptureActive()) return;
    try {
      if (currentClip) await releaseOwnedClip(currentClip);
    } catch {
      setError('The clip could not be removed from local storage. Try again.');
      return;
    }
    recorder?.reset();
    uploadSession?.forget();
    contributionWorkRef.current = false;
    setClip(null);
    setReview(null);
    setUploadProgress({ status: 'idle', percent: 0 });
    latestUploadRef.current = null;
    clearContributionStatus();
    setError(null);
  };

  const saveReview = () => {
    if (!review || !clip) return;
    const trim = review.setTrim(Number(startText), Number(endText));
    if (!trim.ok) {
      setError(
        trim.reason === 'too_short'
          ? 'Keep at least half a second in the clip.'
          : 'Choose trim bounds inside the recorded clip.',
      );
      return;
    }
    review.setMode(mode);
    setError(null);
  };

  const describeUpload = useCallback(
    (
      uploaded: PendingClipUpload,
      state: ContributionStatus['state'],
      options: Pick<ContributionStatus, 'message' | 'retryable'> = {
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
    async (uploaded: PendingClipUpload): Promise<PendingClipUpload['job']> => {
      latestUploadRef.current = uploaded;
      setContributionStatus(describeUpload(uploaded, 'queued'));
      if (!runtimeClient?.processClipJob || !demoSession?.session) return uploaded.job;

      setContributionStatus(describeUpload(uploaded, 'processing'));
      const session = demoSession.session;
      const processed = await runtimeClient.processClipJob(
        session.id,
        session.groupId,
        uploaded.job.id,
      );
      if (processed.status === 'ready') {
        setContributionStatus(describeUpload(uploaded, 'sealed'));
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
      return processed;
    },
    [demoSession, describeUpload, runtimeClient, setContributionStatus],
  );

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
      setError(
        validationError instanceof Error
          ? validationError.message
          : 'The selected clip metadata could not be verified.',
      );
      return;
    }
    if (!clip.hasAudio || clip.mimeType !== 'video/mp4') {
      setError(
        'The selected clip must be an MP4 with an audio track; the server verifies it before accepting the upload.',
      );
      return;
    }
    const reviewMetadata = review.getReview();
    const input: ClipUploadInput = {
      byteLength: clip.byteLength ?? 0,
      durationSeconds: reviewMetadata.endSeconds - reviewMetadata.startSeconds,
      hasAudio: clip.hasAudio,
      height: clip.height,
      idempotencyKey: `clip-${Date.now()}`,
      mimeType: clip.mimeType,
      mode: reviewMetadata.mode,
      sourceUri: clip.sourceUri,
      sourceDurationSeconds: reviewMetadata.durationSeconds,
      trimEndSeconds: reviewMetadata.endSeconds,
      trimStartSeconds: reviewMetadata.startSeconds,
      width: clip.width,
    };
    try {
      contributionWorkRef.current = true;
      activeUploadRef.current = true;
      if (runtimeClient?.stageClipSource && demoSession?.session) {
        const sourceData = await readManagedRecordedClipBase64(clip.sourceUri);
        const staged = await runtimeClient.stageClipSource(
          demoSession.session.id,
          demoSession.session.groupId,
          input.idempotencyKey,
          sourceData,
        );
        input.sourceUri = staged.uri;
        input.byteLength = staged.byteLength;
      }
      await review.savePending(input.idempotencyKey);
      if (!isCaptureActive()) return;
      const uploaded = await uploadSession.upload(input, (progress) => {
        if (isCaptureActive() && activeUploadRef.current) setUploadProgress(progress);
      });
      const processed = await processUploaded(uploaded);
      if (processed.status === 'ready') {
        try {
          await releaseOwnedClip(clip);
        } catch {
          setError('The clip is processed, but its local cache file could not be removed.');
        }
      }
    } catch (uploadError) {
      if (!isCaptureActive()) return;
      const failure = classifyContributionFailure(uploadError);
      if (isUploadCancellation(uploadError)) {
        clearContributionStatus();
        setError(failure.message);
        return;
      }
      const uploaded = latestUploadRef.current;
      setContributionStatus(
        uploaded
          ? describeUpload(uploaded, 'failed', failure)
          : {
              createdAt: new Date().toISOString(),
              durationSeconds: review.getReview().endSeconds - review.getReview().startSeconds,
              ...failure,
              state: 'failed',
            },
      );
      setError(failure.message);
    } finally {
      activeUploadRef.current = false;
    }
  };

  const retryUpload = async () => {
    if (!isCaptureActive()) return;
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
    try {
      contributionWorkRef.current = true;
      activeUploadRef.current = true;
      const retried = await uploadSession?.retry((progress) => {
        if (isCaptureActive() && activeUploadRef.current) setUploadProgress(progress);
      });
      if (retried) {
        const processed = await processUploaded(retried);
        if (processed.status === 'ready') {
          if (clip) {
            try {
              await releaseOwnedClip(clip);
            } catch {
              setError('The clip is sealed, but its local cache file could not be removed.');
            }
          }
        }
      }
    } catch (uploadError) {
      if (!isCaptureActive()) return;
      const failure = classifyContributionFailure(uploadError);
      if (isUploadCancellation(uploadError)) {
        clearContributionStatus();
        setError(failure.message);
        return;
      }
      const uploaded = latestUploadRef.current;
      // Once the bounded budget is spent the failure is terminal. Reporting it
      // as retryable would offer an action that can never succeed.
      const exhausted = Boolean(uploadSession && !uploadSession.canRetry());
      const reported = exhausted
        ? { message: EXHAUSTED_UPLOAD_MESSAGE, retryable: false }
        : failure;
      if (uploaded) setContributionStatus(describeUpload(uploaded, 'failed', reported));
      else
        setContributionStatus({
          createdAt: new Date().toISOString(),
          ...reported,
          state: 'failed',
        });
      setError(reported.message);
    } finally {
      activeUploadRef.current = false;
    }
  };

  const createSyntheticDemoClip = async () => {
    if (
      !isCaptureActive() ||
      platform.kind !== 'demo' ||
      !runtimeClient?.createSyntheticDemoClip ||
      !demoSession?.session ||
      creatingSyntheticClip
    )
      return;
    setCreatingSyntheticClip(true);
    setError(null);
    try {
      contributionWorkRef.current = true;
      const uploaded = await runtimeClient.createSyntheticDemoClip(
        demoSession.session.id,
        demoSession.session.groupId,
      );
      if (!isCaptureActive()) return;
      await processUploaded(uploaded);
    } catch (syntheticError) {
      if (!isCaptureActive()) return;
      const failure = classifyContributionFailure(syntheticError);
      setContributionStatus({
        createdAt: new Date().toISOString(),
        ...failure,
        retryable: false,
        state: 'failed',
      });
      setError(failure.message);
    } finally {
      contributionWorkRef.current = false;
      if (isCaptureActive()) setCreatingSyntheticClip(false);
    }
  };

  const cancelUpload = useCallback(async () => {
    if (!isCaptureActive() || !uploadSession || uploadProgress.status !== 'uploading') {
      return;
    }
    // Update the route synchronously. The transport may never settle (for
    // example, after a dropped runtime connection), but the user must still
    // leave the uploading state and be able to retry.
    setUploadProgress({ status: 'cancelled', percent: 0 });
    activeUploadRef.current = false;
    try {
      await uploadSession.cancel();
    } catch (cancelError) {
      if (!isCaptureActive()) return;
      const failure = classifyContributionFailure(cancelError);
      setUploadProgress({ status: 'failed', percent: 10, message: failure.message });
      setContributionStatus({
        createdAt: new Date().toISOString(),
        durationSeconds: review?.getReview().endSeconds,
        ...failure,
        state: 'failed',
      });
      setError(`The upload could not be cancelled. ${failure.message}`);
    }
  }, [isCaptureActive, review, setContributionStatus, uploadProgress.status, uploadSession]);

  const leaveCapture = useCallback(() => {
    const currentClip = clipRef.current;
    clipRef.current = null;
    reviewRef.current = null;
    void cancelActiveWork().finally(() => {
      if (currentClip) void removeManagedRecordedClip(currentClip.sourceUri).catch(() => undefined);
    });
    onBack?.();
  }, [cancelActiveWork, onBack]);

  const contributionFailed = contributionStatus?.state === 'failed';
  const canRetryContribution = contributionFailed && contributionStatus.retryable;

  const canDeleteContribution = Boolean(
    contributionStatus?.contributionId &&
    runtimeClient?.deleteContribution &&
    contributionStatus.state !== 'processing' &&
    contributionStatus.deletionAvailability !== 'used' &&
    contributionStatus.deletionAvailability !== 'unavailable',
  );

  const deleteContributionForReplacement = useCallback(async () => {
    if (
      !isCaptureActive() ||
      !canDeleteContribution ||
      !contributionStatus?.contributionId ||
      !runtimeClient?.deleteContribution ||
      !demoSession?.session
    )
      return;
    try {
      await runtimeClient.deleteContribution(
        demoSession.session.id,
        demoSession.session.groupId,
        contributionStatus.contributionId,
      );
      const currentClip = clipRef.current;
      if (currentClip) await releaseOwnedClip(currentClip);
      recorder?.reset();
      setClip(null);
      setReview(null);
      setUploadProgress({ status: 'idle', percent: 0 });
      latestUploadRef.current = null;
      clearContributionStatus();
      onContributionDeleted?.();
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
      setError(
        deleteError instanceof Error
          ? `The contribution could not be deleted. ${deleteError.message}`
          : 'The contribution could not be deleted. Try again.',
      );
    }
  }, [
    canDeleteContribution,
    clearContributionStatus,
    contributionStatus,
    demoSession,
    isCaptureActive,
    onContributionDeleted,
    recorder,
    releaseOwnedClip,
    runtimeClient,
    setContributionStatus,
  ]);
  return (
    <View style={styles.screen} testID="video-capture-screen">
      <View style={styles.header}>
        {onBack ? (
          <Pressable accessibilityRole="button" onPress={leaveCapture} style={styles.backButton}>
            <Text style={styles.backText}>Back to stills</Text>
          </Pressable>
        ) : null}
        <Text style={styles.eyebrow}>CLIP CAPTURE</Text>
        <Text accessibilityRole="header" style={styles.title}>
          Record a contribution
        </Text>
        <Text style={styles.body}>
          Portrait video with microphone audio. Maximum duration: 15 seconds.
        </Text>
      </View>
      {access === 'checking' ? (
        <Panel title="Checking recording access…" body="Camera and microphone are being checked." />
      ) : null}
      {access === 'unsupported' ? (
        <Panel
          actionLabel={
            platform.kind === 'demo' &&
            runtimeClient?.createSyntheticDemoClip &&
            demoSession?.session
              ? creatingSyntheticClip
                ? 'Preparing synthetic Demo clip…'
                : 'Create synthetic Demo clip'
              : platform.supportsFileFallback && platform.pickVideoFile
                ? 'Choose a video file'
                : undefined
          }
          disabled={creatingSyntheticClip}
          onAction={
            platform.kind === 'demo' &&
            runtimeClient?.createSyntheticDemoClip &&
            demoSession?.session
              ? createSyntheticDemoClip
              : platform.supportsFileFallback && platform.pickVideoFile
                ? chooseVideoFile
                : undefined
          }
          testID="video-unsupported"
          title="Recording is not supported here"
          body={
            platform.kind === 'demo' &&
            runtimeClient?.createSyntheticDemoClip &&
            demoSession?.session
              ? 'Use a fresh, non-sensitive synthetic clip to exercise the local Demo. Use a physical device to record a real contribution.'
              : platform.supportsFileFallback && platform.pickVideoFile
                ? 'Live recording is not supported here. Choose a portrait MP4 no longer than 15 seconds with an audio track; the server verifies it before upload. It remains labelled as a file contribution.'
                : 'Use a physical device with camera and microphone access. Unsupported recording cannot be started here.'
          }
        />
      ) : null}
      {access === 'temporarily-unavailable' ? (
        <Panel
          actionLabel={
            platform.supportsFileFallback && platform.pickVideoFile
              ? 'Choose a video file'
              : 'Check again'
          }
          onAction={
            platform.supportsFileFallback && platform.pickVideoFile ? chooseVideoFile : refresh
          }
          testID="video-temporarily-unavailable"
          title="Recording is temporarily unavailable"
          body={error ?? 'The device capability check is not ready yet. Try again shortly.'}
        />
      ) : null}
      {access === 'permission-undecided' ? (
        <Panel
          actionLabel="Allow camera and microphone"
          onAction={requestAccess}
          testID="video-permission"
          title="Allow access to record"
          body="Both camera and microphone permissions are required before recording."
        />
      ) : null}
      {access === 'permission-denied' ? (
        <Panel
          actionLabel={
            platform.supportsFileFallback && platform.pickVideoFile
              ? 'Choose a video file'
              : 'Try again'
          }
          onAction={
            platform.supportsFileFallback && platform.pickVideoFile
              ? chooseVideoFile
              : requestAccess
          }
          testID="video-permission-denied"
          title="Camera or microphone access is denied"
          body="Recording needs both permissions. Try again or choose a labelled video file fallback when it is available."
        />
      ) : null}
      {access === 'permission-blocked' ? (
        <Panel
          actionLabel="Open Settings"
          onAction={openSettings}
          testID="video-permission-blocked"
          title="Permission is blocked"
          body="Camera or microphone access is blocked. Open Settings, allow both permissions, then return to Rewind and try again."
        />
      ) : null}
      {access === 'error' ? (
        <Panel
          actionLabel="Check again"
          onAction={refresh}
          title="Recording access needs checking"
          body={error ?? 'Try again.'}
        />
      ) : null}
      {access === 'ready' && !clip && !recording ? (
        <View style={styles.captureArea}>
          <CameraView
            facing="back"
            mode="video"
            ref={cameraRef}
            style={styles.preview}
            testID="video-live-preview"
          />
          <Pressable
            accessibilityRole="button"
            onPress={() => void startRecording()}
            style={styles.recordButton}
            testID="video-record"
          >
            <Text style={styles.recordButtonText}>Start recording</Text>
          </Pressable>
        </View>
      ) : null}
      {recording ? (
        <View style={styles.recordingPanel} testID="video-recording">
          <Text style={styles.recordingTitle}>Recording…</Text>
          <Text style={styles.timer}>{Math.floor(elapsedSeconds)} / 15 seconds</Text>
          <Pressable
            accessibilityRole="button"
            onPress={cancelRecording}
            style={styles.outlineButton}
          >
            <Text style={styles.outlineText}>Cancel recording</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => recorder?.stop()}
            style={styles.recordButton}
          >
            <Text style={styles.recordButtonText}>Stop and review</Text>
          </Pressable>
        </View>
      ) : null}
      {review && clip && !recording ? (
        <View style={styles.reviewPanel} testID="video-review">
          <Text style={styles.panelTitle}>Review your clip</Text>
          <Text style={styles.body}>
            {clip.source === 'file'
              ? `Selected MP4 ${clip.durationSeconds.toFixed(1)} seconds · ${clip.width} × ${clip.height} portrait · audio track detected; server verifies`
              : `Recorded ${clip.durationSeconds.toFixed(1)} seconds · ${clip.width} × ${clip.height} portrait · audio included`}
          </Text>
          {clip.source === 'file' ? (
            <Text style={styles.body}>
              FILE FALLBACK · selected locally, not recorded in Rewind
            </Text>
          ) : null}
          <Text style={styles.fieldLabel}>Start seconds</Text>
          <TextInput
            keyboardType="decimal-pad"
            onChangeText={setStartText}
            style={styles.input}
            value={startText}
          />
          <Text style={styles.fieldLabel}>End seconds</Text>
          <TextInput
            keyboardType="decimal-pad"
            onChangeText={setEndText}
            style={styles.input}
            value={endText}
          />
          <Text style={styles.fieldLabel}>Original capture mode</Text>
          <View style={styles.modeRow}>
            {(['soft-focus', 'high-contrast'] as const).map((option) => (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: mode === option }}
                key={option}
                onPress={() => setMode(option)}
                style={[styles.modeButton, mode === option && styles.modeSelected]}
              >
                <Text style={styles.outlineText}>
                  {option === 'soft-focus' ? 'Soft Focus' : 'High Contrast'}
                </Text>
              </Pressable>
            ))}
          </View>
          <Pressable accessibilityRole="button" onPress={saveReview} style={styles.outlineButton}>
            <Text style={styles.outlineText}>Save trim and mode</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => void retake()}
            style={styles.outlineButton}
          >
            <Text style={styles.outlineText}>Retake</Text>
          </Pressable>
          {uploadProgress.status === 'complete' && !contributionFailed ? (
            <Text style={styles.success}>Upload queued as one pending contribution.</Text>
          ) : uploadProgress.status === 'failed' || contributionFailed ? null : (
            <Pressable
              accessibilityRole="button"
              onPress={() => void upload()}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryText}>
                {uploadProgress.status === 'uploading'
                  ? `Uploading ${uploadProgress.percent}%`
                  : 'Upload clip'}
              </Text>
            </Pressable>
          )}
          {uploadProgress.status === 'uploading' ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void cancelUpload()}
              style={styles.outlineButton}
            >
              <Text style={styles.outlineText}>Cancel upload</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <ContributionStatusPanel
        deleteLabel="Delete and replace"
        onDelete={canDeleteContribution ? deleteContributionForReplacement : undefined}
        onRetry={canRetryContribution ? () => void retryUpload() : undefined}
        retryLabel="Retry upload"
        status={contributionStatus}
        testID="camera-contribution-status"
      />
      {error && access !== 'error' ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function Panel({
  actionLabel,
  body,
  disabled = false,
  onAction,
  testID,
  title,
}: {
  actionLabel?: string;
  body: string;
  disabled?: boolean;
  onAction?: () => void | Promise<void>;
  testID?: string;
  title: string;
}) {
  return (
    <View style={styles.panel} testID={testID}>
      <Text style={styles.panelTitle}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
      {actionLabel && onAction ? (
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          onPress={onAction}
          style={styles.outlineButton}
        >
          <Text style={styles.outlineText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, gap: 16, padding: 24 },
  header: { gap: 7 },
  backButton: { alignSelf: 'flex-start', paddingVertical: 4 },
  backText: { color: COLORS.accent, fontSize: 14, fontWeight: '700' },
  eyebrow: { color: COLORS.edge, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  title: { color: COLORS.ink, fontSize: 28, fontWeight: '700' },
  body: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  panel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 10,
    borderWidth: 1,
    gap: 10,
    padding: 18,
  },
  panelTitle: { color: COLORS.ink, fontSize: 20, fontWeight: '700' },
  captureArea: { flex: 1, gap: 14, minHeight: 440 },
  preview: { backgroundColor: COLORS.deep, borderRadius: 12, flex: 1, minHeight: 320 },
  recordButton: {
    alignItems: 'center',
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    justifyContent: 'center',
    minHeight: 50,
    padding: 12,
  },
  recordButtonText: { color: COLORS.deep, fontSize: 15, fontWeight: '800' },
  recordingPanel: {
    backgroundColor: COLORS.deep,
    borderColor: COLORS.accent,
    borderRadius: 10,
    borderWidth: 1,
    gap: 14,
    padding: 20,
  },
  recordingTitle: { color: COLORS.accent, fontSize: 24, fontWeight: '800' },
  timer: { color: COLORS.ink, fontSize: 20, fontVariant: ['tabular-nums'] },
  reviewPanel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 10,
    borderWidth: 1,
    gap: 10,
    padding: 18,
  },
  fieldLabel: { color: COLORS.ink, fontSize: 14, fontWeight: '700' },
  input: {
    backgroundColor: COLORS.background,
    borderColor: COLORS.edge,
    borderRadius: 8,
    borderWidth: 1,
    color: COLORS.ink,
    minHeight: 46,
    paddingHorizontal: 12,
  },
  modeRow: { flexDirection: 'row', gap: 8 },
  modeButton: {
    borderColor: COLORS.edge,
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    minHeight: 46,
    justifyContent: 'center',
    padding: 8,
  },
  modeSelected: { backgroundColor: COLORS.accent },
  outlineButton: {
    alignItems: 'center',
    borderColor: COLORS.edge,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 46,
    padding: 10,
  },
  outlineText: { color: COLORS.ink, fontSize: 14, fontWeight: '700' },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    justifyContent: 'center',
    minHeight: 46,
    padding: 10,
  },
  primaryText: { color: COLORS.deep, fontSize: 14, fontWeight: '800' },
  success: { color: COLORS.edge, fontSize: 14, fontWeight: '700' },
  error: { color: COLORS.accent, fontSize: 14, lineHeight: 20 },
});
