import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { CameraView } from 'expo-camera';
import { VideoView, useVideoPlayer } from 'expo-video';
import { AppState, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { LocalRuntimeError, type RuntimeClient } from '../runtime/local-runtime-client';
import { useOptionalDemoSession } from '../session/DemoSessionProvider';
import type { ScreenDebug } from '../debug/DebugProvider';
import { useI18n } from '../i18n/LanguageProvider';
import { COLORS } from '../theme';
import {
  ActionButton,
  ButtonRow,
  InlineError,
  Micro,
  MockMedia,
  Notice,
  ScreenIntro,
  StepLine,
  kitStyles,
} from '../ui/kit';
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
  /** Settings debug mode: forces a study state without touching upload data. */
  debug?: ScreenDebug<VideoDebugScenario>;
  /** Metadata-only fixture shown instead of the persisted status in debug mode. */
  contributionStatusOverride?: ContributionStatus;
  /** Show the system camera + microphone prompt on the first undecided visit. */
  autoRequestPermission?: boolean;
}

export type VideoDebugScenario =
  | 'permission'
  | 'denied'
  | 'preview'
  | 'uploading'
  | 'queued'
  | 'processing'
  | 'sealed'
  | 'error'
  | 'quota';

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
  reason?: 'quota_exceeded';
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
    if (error.code === 'quota_exceeded') {
      return { message, retryable: false, reason: 'quota_exceeded' };
    }
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
  autoRequestPermission = false,
  contributionStatusOverride,
  debug,
  onBack,
  onContributionDeleted,
  platform: platformProp,
  runtimeClient = null,
}: VideoCaptureScreenProps = {}) {
  const { t } = useI18n();
  const [debugNotice, setDebugNotice] = useState<string | null>(null);
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
  const [previewLocked, setPreviewLocked] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [review, setReview] = useState<ClipReviewSession | null>(null);
  const [startText, setStartText] = useState('0');
  const [endText, setEndText] = useState('0');
  const [mode, setMode] = useState<CaptureMode>('soft-focus');
  const [uploadProgress, setUploadProgress] = useState<ClipUploadProgress>({
    status: 'idle',
    percent: 0,
  });
  const [creatingSyntheticClip, setCreatingSyntheticClip] = useState(false);
  const [retryInFlight, setRetryInFlight] = useState(false);
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
  const retryInFlightRef = useRef(false);
  // Contribution work owns its async operations until they finish or a
  // lifecycle event invalidates their generation. This includes staging.
  const contributionWorkRef = useRef(false);
  const contributionOperationRef = useRef(0);
  const pendingUploadInputRef = useRef<{ signature: string; input: ClipUploadInput } | null>(null);
  const replacementTargetRef = useRef<string | null>(null);
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
    if (upload) setPreviewLocked(true);
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
      setPreviewLocked(false);
      setPreviewOpen(false);
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
        const interruptedUpload = activeUploadRef.current;
        if (contributionWorkRef.current) invalidateContributionWork();
        if (decision.cancelUploadRequest && interruptedUpload) {
          void uploadSessionRef.current?.cancel().catch(() => undefined);
          setUploadProgress({ status: 'cancelled', percent: 0 });
          if (decision.retainLocalCaptureForRetry) {
            const retryable = uploadSessionRef.current?.canRetry() ?? false;
            setContributionStatus({
              createdAt: new Date().toISOString(),
              durationSeconds: reviewRef.current?.getReview().endSeconds,
              message: retryable ? INTERRUPTED_UPLOAD_MESSAGE : EXHAUSTED_UPLOAD_MESSAGE,
              retryable,
              state: 'failed',
            });
          }
        }
      }
    });
    return () => subscription.remove();
  }, [invalidateContributionWork, reconcileInterruptedUpload, refresh, setContributionStatus]);

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

  const autoRequested = useRef(false);
  useEffect(() => {
    if (!autoRequestPermission || debug?.scenario || autoRequested.current) return;
    if (access !== 'permission-undecided') return;
    autoRequested.current = true;
    // Defer so the system prompt is requested after this render commits.
    void Promise.resolve().then(requestAccess);
  }, [access, autoRequestPermission, debug?.scenario, requestAccess]);

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

  const chooseLibraryVideo = async () => {
    if (!isCaptureActive() || !platform.pickLibraryVideo) return;
    setError(null);
    try {
      const selected = await platform.pickLibraryVideo();
      if (selected) await replaceClip(selected);
    } catch (libraryError) {
      if (!isCaptureActive()) return;
      setError(
        libraryError instanceof Error ? libraryError.message : 'The video file could not be used.',
      );
    }
  };
  const canChooseLibraryVideo = Boolean(platform.supportsLibraryVideo && platform.pickLibraryVideo);

  const cancelRecording = () => {
    recorder?.cancel();
    setRecording(false);
    setRecordingStartedAt(null);
    setElapsedSeconds(0);
    setError(null);
  };

  const retake = async () => {
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
    pendingUploadInputRef.current = null;
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
    async (
      uploaded: PendingClipUpload,
      operation: number,
    ): Promise<PendingClipUpload['job'] | null> => {
      if (!isContributionWorkActive(operation)) return null;
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
      if (!isContributionWorkActive(operation)) return null;
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
    [demoSession, describeUpload, isContributionWorkActive, runtimeClient, setContributionStatus],
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
      pendingInput = {
        signature,
        input: {
          byteLength: clip.byteLength ?? 0,
          durationSeconds: reviewMetadata.endSeconds - reviewMetadata.startSeconds,
          hasAudio: clip.hasAudio,
          height: clip.height,
          idempotencyKey: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          mimeType: clip.mimeType,
          mode: reviewMetadata.mode,
          sourceUri: clip.sourceUri,
          sourceDurationSeconds: reviewMetadata.durationSeconds,
          trimEndSeconds: reviewMetadata.endSeconds,
          trimStartSeconds: reviewMetadata.startSeconds,
          width: clip.width,
          ...(replacementTargetRef.current
            ? { replacesContributionId: replacementTargetRef.current }
            : {}),
        },
      };
      pendingUploadInputRef.current = pendingInput;
    }
    const operation = beginContributionWork(true);
    const prepareInput = async (input: ClipUploadInput): Promise<ClipUploadInput> => {
      await review.savePending(input.idempotencyKey);
      if (!isContributionWorkActive(operation)) {
        throw new ClipUploadError('The upload was cancelled.', { code: 'cancelled' });
      }
      if (runtimeClient?.stageClipSource && demoSession?.session) {
        const sourceData = await readManagedRecordedClipBase64(clip.sourceUri);
        if (!isContributionWorkActive(operation)) {
          throw new ClipUploadError('The upload was cancelled.', { code: 'cancelled' });
        }
        const staged = await runtimeClient.stageClipSource(
          demoSession.session.id,
          demoSession.session.groupId,
          input.idempotencyKey,
          sourceData,
        );
        if (!isContributionWorkActive(operation)) {
          throw new ClipUploadError('The upload was cancelled.', { code: 'cancelled' });
        }
        return { ...input, sourceUri: staged.uri, byteLength: staged.byteLength };
      }
      return input;
    };
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
        try {
          await releaseOwnedClip(clip);
        } catch {
          if (isContributionWorkActive(operation))
            setError('The clip is processed, but its local cache file could not be removed.');
        }
        if (isContributionWorkActive(operation)) {
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
        : { message: failure.message, retryable };
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
    const operation = beginContributionWork(true);
    const prepareInput = async (input: ClipUploadInput): Promise<ClipUploadInput> => {
      await review.savePending(input.idempotencyKey);
      if (!isContributionWorkActive(operation)) {
        throw new ClipUploadError('The upload was cancelled.', { code: 'cancelled' });
      }
      if (runtimeClient?.stageClipSource && demoSession?.session) {
        const sourceData = await readManagedRecordedClipBase64(clip.sourceUri);
        if (!isContributionWorkActive(operation)) {
          throw new ClipUploadError('The upload was cancelled.', { code: 'cancelled' });
        }
        const staged = await runtimeClient.stageClipSource(
          demoSession.session.id,
          demoSession.session.groupId,
          input.idempotencyKey,
          sourceData,
        );
        if (!isContributionWorkActive(operation)) {
          throw new ClipUploadError('The upload was cancelled.', { code: 'cancelled' });
        }
        return { ...input, sourceUri: staged.uri, byteLength: staged.byteLength };
      }
      return input;
    };
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
          if (clip) {
            try {
              await releaseOwnedClip(clip);
            } catch {
              if (isContributionWorkActive(operation))
                setError('The clip is sealed, but its local cache file could not be removed.');
            }
          }
          if (isContributionWorkActive(operation)) {
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
          : { message: failure.message, retryable: failure.retryable };
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
    const operation = beginContributionWork(false);
    try {
      const uploaded = await runtimeClient.createSyntheticDemoClip(
        demoSession.session.id,
        demoSession.session.groupId,
      );
      if (!isContributionWorkActive(operation)) return;
      await processUploaded(uploaded, operation);
    } catch (syntheticError) {
      if (!isContributionWorkActive(operation)) return;
      const failure = classifyContributionFailure(syntheticError);
      setContributionStatus({
        createdAt: new Date().toISOString(),
        ...failure,
        retryable: false,
        state: 'failed',
      });
      setError(failure.message);
    } finally {
      finishContributionWork(operation);
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
    setError('The upload was cancelled.');
    try {
      await uploadSession.cancel();
    } catch (cancelError) {
      if (!isCaptureActive()) return;
      const failure = classifyContributionFailure(cancelError);
      setUploadProgress({ status: 'failed', percent: 10, message: failure.message });
      setError(`The upload could not be cancelled. ${failure.message}`);
    }
  }, [
    describeUpload,
    invalidateContributionWork,
    isCaptureActive,
    review,
    setContributionStatus,
    uploadProgress.status,
    uploadSession,
  ]);

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
  const canRetryContribution = contributionFailed && contributionStatus.retryable && !retryInFlight;

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
      replacementTargetRef.current = contributionStatus.contributionId;
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
  const header = (
    <View style={styles.header}>
      {onBack ? (
        <ActionButton
          accessibilityLabel={t('Back to stills')}
          label={`← ${t('Back to stills')}`}
          onPress={debug?.scenario ? onBack : leaveCapture}
          variant="quiet"
        />
      ) : null}
      <ScreenIntro
        body={t('Portrait video with audio · up to 15 seconds.')}
        eyebrow={t('CAMERA / CLIP')}
        headingTestID="route-heading-video"
        title={t('Contribute a clip.')}
      />
    </View>
  );

  if (debug?.scenario) {
    const scenario = debug.scenario;
    const submitFlow = (): void => {
      setDebugNotice(null);
      debug.play(['uploading', 'queued', 'processing', 'sealed']);
    };
    return (
      <ScrollView
        contentContainerStyle={kitStyles.content}
        style={kitStyles.scroll}
        testID="video-capture-screen"
      >
        {header}
        {scenario === 'permission' || scenario === 'denied' ? (
          <Panel
            actionLabel="Check again"
            body="Physical capture needs both permissions. This is a simulation."
            onAction={() => debug.set('live')}
            testID={scenario === 'denied' ? 'video-permission-denied' : 'video-permission'}
            title={
              scenario === 'denied' ? 'Recording access denied' : 'Allow camera and microphone'
            }
          />
        ) : null}
        {scenario === 'preview' ? (
          <View style={styles.reviewStack} testID="video-review">
            <StepLine
              accessibilityLabel={t('Step {step} of 4', { step: 2 })}
              active={1}
              steps={[t('Capture'), t('Review'), t('Submit'), t('Sealed')]}
            />
            <MockMedia
              caption={t('No physical video was captured.')}
              kind="clip"
              title={t('Clip preview fixture')}
            />
            <Micro>{t('2.0 seconds · simulated physical-capture review')}</Micro>
            <ButtonRow>
              <ActionButton label={t('Retake')} onPress={() => debug.set('live')} />
              <ActionButton label={t('Submit clip')} onPress={submitFlow} variant="primary" />
              <ActionButton
                label={t('Discard')}
                onPress={() => debug.set('live')}
                variant="quiet"
              />
            </ButtonRow>
          </View>
        ) : null}
        {scenario === 'uploading' ? (
          <Panel
            actionLabel="Cancel upload"
            body="Uploading sample; film not yet released."
            onAction={() => {
              setDebugNotice(t('Upload cancelled. Review the clip before retrying.'));
              debug.set('preview');
            }}
            testID="video-uploading"
            title="Uploading clip…"
          />
        ) : null}
        {contributionStatusOverride ? (
          <ContributionStatusPanel
            onDelete={
              scenario === 'sealed'
                ? () => {
                    setDebugNotice(t('Sample deleted; allowance restored.'));
                    debug.set('live');
                  }
                : undefined
            }
            onRetry={
              scenario === 'error'
                ? () => debug.play(['queued', 'processing', 'sealed'])
                : undefined
            }
            status={contributionStatusOverride}
            testID="camera-contribution-status"
          />
        ) : null}
        {debugNotice ? <Notice>{debugNotice}</Notice> : null}
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={kitStyles.content}
      keyboardShouldPersistTaps="handled"
      style={kitStyles.scroll}
      testID="video-capture-screen"
    >
      {header}
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
                : 'Create sample clip'
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
          title={
            platform.kind === 'demo' &&
            runtimeClient?.createSyntheticDemoClip &&
            demoSession?.session
              ? 'Synthetic clip path'
              : 'Recording is not supported here'
          }
          body={
            platform.kind === 'demo' &&
            runtimeClient?.createSyntheticDemoClip &&
            demoSession?.session
              ? 'Create a fresh, non-sensitive synthetic clip to see queue, processing and sealing. Use a physical device to record a real contribution.'
              : platform.supportsFileFallback && platform.pickVideoFile
                ? 'Live recording is not supported here. Choose a portrait MP4 no longer than 15 seconds with an audio track; the server verifies it before upload. It remains labelled as a file contribution.'
                : !runtimeClient
                  ? 'Offline sample cannot record or upload. Connect the local runtime.'
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
          title="Recording access denied"
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
      {access === 'ready' && !clip ? (
        // The camera must stay mounted for the whole recording: unmounting a
        // CameraView while recordAsync is running tears down the native
        // capture session and crashes iOS (Expo Go) instead of saving a clip.
        <LiveVideoCapture
          cameraRef={cameraRef}
          elapsedSeconds={elapsedSeconds}
          needsCameraReady={platform.supportsLivePreview}
          onCancel={cancelRecording}
          onStart={() => void startRecording()}
          onStop={() => recorder?.stop()}
          recording={recording}
        />
      ) : null}
      {canChooseLibraryVideo && !clip && !recording && access !== 'checking' ? (
        <ActionButton
          accessibilityHint={t('Opens your photo library to choose a portrait video')}
          full
          label={t('Choose a phone video (15 s max)')}
          onPress={chooseLibraryVideo}
          testID="video-choose-library"
        />
      ) : null}
      {review && clip && !recording ? (
        <View style={styles.reviewPanel} testID="video-review">
          <StepLine
            accessibilityLabel={t('Step {step} of 4', { step: 2 })}
            active={1}
            steps={[t('Capture'), t('Review'), t('Submit'), t('Sealed')]}
          />
          <Text style={styles.panelTitle}>{t('Review your clip')}</Text>
          <Text style={styles.body}>
            {clip.source === 'file'
              ? t(
                  'Selected MP4 {seconds} seconds · {width} × {height} portrait · audio track detected; server verifies',
                  {
                    height: clip.height,
                    seconds: clip.durationSeconds.toFixed(1),
                    width: clip.width,
                  },
                )
              : t('Recorded {seconds} seconds · {width} × {height} portrait · audio included', {
                  height: clip.height,
                  seconds: clip.durationSeconds.toFixed(1),
                  width: clip.width,
                })}
          </Text>
          {clip.source === 'file' ? (
            <Text style={styles.body}>
              {t('FILE FALLBACK · selected locally, not recorded in Rewind')}
            </Text>
          ) : null}
          <Text style={styles.fieldLabel}>{t('Start seconds')}</Text>
          <TextInput
            accessibilityLabel={t('Start seconds')}
            keyboardType="decimal-pad"
            onChangeText={setStartText}
            style={styles.input}
            value={startText}
          />
          <Text style={styles.fieldLabel}>{t('End seconds')}</Text>
          <TextInput
            accessibilityLabel={t('End seconds')}
            keyboardType="decimal-pad"
            onChangeText={setEndText}
            style={styles.input}
            value={endText}
          />
          <Text style={styles.fieldLabel}>{t('Original capture mode')}</Text>
          <View style={styles.modeRow}>
            {(['soft-focus', 'high-contrast'] as const).map((option) => (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: mode === option, selected: mode === option }}
                aria-checked={mode === option}
                key={option}
                onPress={() => setMode(option)}
                style={[styles.modeButton, mode === option && styles.modeSelected]}
              >
                <Text style={[styles.outlineText, mode === option && styles.modeSelectedText]}>
                  {option === 'soft-focus' ? t('Soft Focus') : t('High Contrast')}
                </Text>
              </Pressable>
            ))}
          </View>
          {!previewLocked ? (
            <ActionButton
              label={previewOpen ? t('Hide preview') : t('Preview clip')}
              onPress={() => setPreviewOpen((open) => !open)}
              testID="video-preview-toggle"
            />
          ) : null}
          {!previewLocked && previewOpen ? <ClipPreview clip={clip} /> : null}
          <ActionButton label={t('Save trim and mode')} onPress={saveReview} />
          <ActionButton label={t('Retake')} onPress={() => void retake()} />
          {!runtimeClient ? (
            <Notice testID="video-upload-needs-runtime">
              {t(
                'Upload needs the local runtime. Start it on your computer and set EXPO_PUBLIC_LOCAL_BASE_URL before starting Expo.',
              )}
            </Notice>
          ) : null}
          {uploadProgress.status === 'complete' && !contributionFailed ? (
            <Text style={styles.success}>{t('Upload queued as one pending contribution.')}</Text>
          ) : uploadProgress.status === 'failed' || contributionFailed ? null : (
            <ActionButton
              busy={uploadProgress.status === 'uploading'}
              label={
                uploadProgress.status === 'uploading'
                  ? t('Uploading {percent}%', { percent: uploadProgress.percent })
                  : t('Upload clip')
              }
              onPress={() => void upload()}
              variant="primary"
            />
          )}
          {uploadProgress.status === 'uploading' ? (
            <ActionButton label={t('Cancel upload')} onPress={() => void cancelUpload()} />
          ) : null}
        </View>
      ) : null}
      <ContributionStatusPanel
        deleteLabel="Delete and replace"
        onDelete={canDeleteContribution ? deleteContributionForReplacement : undefined}
        onRetry={canRetryContribution ? () => void retryUpload() : undefined}
        retryLabel="Retry upload"
        status={contributionStatusOverride ?? contributionStatus}
        testID="camera-contribution-status"
      />
      {error && access !== 'error' ? <InlineError>{t(error)}</InlineError> : null}
    </ScrollView>
  );
}

/**
 * Local, pre-upload playback of the member's own clip for checking what will
 * be submitted. It is never shown after submission, when media is sealed.
 */
function ClipPreview({ clip }: { clip: RecordedClip }) {
  const { t } = useI18n();
  const player = useVideoPlayer(clip.sourceUri, (instance) => {
    instance.loop = true;
  });
  const size = clip.byteLength ? `${(clip.byteLength / 1024 / 1024).toFixed(2)} MB` : '—';
  return (
    <View style={styles.clipPreview} testID="video-clip-preview">
      <VideoView
        accessibilityLabel={t('Preview of your unsent clip')}
        contentFit="contain"
        nativeControls
        player={player}
        style={styles.clipPreviewPlayer}
        testID="video-clip-preview-player"
      />
      <Micro testID="video-clip-preview-meta">
        {t('{source} · {seconds} s · {width} × {height} · {size} · audio checked by server', {
          height: clip.height,
          seconds: clip.durationSeconds.toFixed(1),
          size,
          source: clip.source === 'file' ? t('Phone video') : t('Recorded here'),
          width: clip.width,
        })}
      </Micro>
    </View>
  );
}

function LiveVideoCapture({
  cameraRef,
  elapsedSeconds,
  needsCameraReady,
  onCancel,
  onStart,
  onStop,
  recording,
}: {
  cameraRef: RefObject<CameraView | null>;
  elapsedSeconds: number;
  needsCameraReady: boolean;
  onCancel: () => void;
  onStart: () => void;
  onStop: () => void;
  recording: boolean;
}) {
  const { t } = useI18n();
  // Owned here so every remount of the camera waits for its own ready event;
  // recording before the native session is ready can also crash iOS.
  const [cameraReady, setCameraReady] = useState(!needsCameraReady);
  return (
    <View style={styles.captureArea}>
      <StepLine
        accessibilityLabel={t('Step {step} of 4', { step: 1 })}
        active={0}
        steps={[t('Capture'), t('Review'), t('Submit'), t('Sealed')]}
      />
      <CameraView
        facing="back"
        mode="video"
        onCameraReady={() => setCameraReady(true)}
        ref={cameraRef}
        style={styles.preview}
        testID="video-live-preview"
      />
      {recording ? (
        <View style={styles.recordingPanel} testID="video-recording">
          <Text accessibilityLiveRegion="polite" style={styles.recordingTitle}>
            {t('Recording…')}
          </Text>
          <Text style={styles.timer}>
            {t('{elapsed} / 15 seconds', { elapsed: Math.floor(elapsedSeconds) })}
          </Text>
          <ActionButton label={t('Cancel recording')} onPress={onCancel} />
          <ActionButton label={t('Stop and review')} onPress={onStop} variant="primary" />
        </View>
      ) : (
        <ActionButton
          busy={!cameraReady}
          full
          label={cameraReady ? t('Start recording') : t('Preparing camera…')}
          onPress={onStart}
          testID="video-record"
          variant="primary"
        />
      )}
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
  const { t } = useI18n();
  return (
    <View style={styles.panel} testID={testID}>
      <Text style={styles.panelTitle}>{t(title)}</Text>
      <Text style={styles.body}>{t(body)}</Text>
      {actionLabel && onAction ? (
        <ActionButton
          disabled={disabled}
          label={t(actionLabel)}
          onPress={onAction}
          variant="primary"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'flex-start', gap: 6 },
  reviewStack: { gap: 12 },
  clipPreview: { gap: 8 },
  clipPreviewPlayer: {
    aspectRatio: 9 / 16,
    backgroundColor: COLORS.deep,
    borderRadius: 10,
    maxHeight: 420,
    width: '100%',
  },
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
  captureArea: { gap: 14 },
  preview: {
    aspectRatio: 9 / 16,
    backgroundColor: COLORS.deep,
    borderRadius: 12,
    maxHeight: 460,
    width: '100%',
  },
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
  modeSelectedText: { color: COLORS.accentInk },
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
