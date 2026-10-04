import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAllowLandscape } from '../runtime/PortraitGuard';
import { CameraView } from 'expo-camera';
import {
  AppState,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { COLORS } from '../theme';
import { RevealEducationPanel } from '../capsule/RevealEducationPanel';
import { getRevealEducationCopy, type RevealEducationState } from '../domain/reveal-education';
import {
  CaptureFileLifecycleError,
  type CameraPlatform,
  type CaptureFileStore,
  type ImageMetadataStore,
  type PlatformStillImage,
} from './contracts';
import {
  accessState,
  initialCaptureState,
  isCaptureReady,
  type CaptureState,
} from './capture-state';
import { ExpoCaptureFileStore, InMemoryCaptureFileStore, WebCaptureFileStore } from './file-store';
import { AsyncStorageImageMetadataStore, InMemoryImageMetadataStore } from './metadata-store';
import { ExpoCameraPlatform, isCaptureCancelled } from './platform';
import { StillImageCaptureSession } from './still-image-session';
import {
  CAPTURE_MODE_LABELS,
  CAPTURE_MODES,
  DEFAULT_CAPTURE_MODE,
  type CaptureMode,
} from '../domain/video';
import { applyRetroLookToPhoto, type RetroPhotoResult } from './retro-browser';
import { ContributionStatusPanel, useOptionalContributionStatus } from './contribution-status';
import { decideInterruption } from './capture-interruption';
import { runCaptureRestartRecovery } from './reset';

/** How the chosen retro look reaches the server for one photo. */
export interface PhotoRetroLook {
  mode: CaptureMode;
  /** True when this device already applied the look (web). */
  clientProcessed: boolean;
}

export interface CameraCaptureScreenProps {
  /** Display context only; group authorization belongs to the caller. */
  groupName?: string;
  platform?: CameraPlatform;
  fileStore?: CaptureFileStore;
  metadataStore?: ImageMetadataStore;
  now?: () => Date;
  createCaptureId?: () => string;
  onAccepted?: (
    metadata: Awaited<ReturnType<StillImageCaptureSession['accept']>>['metadata'],
  ) => void;
  onSubmitPhoto?: (
    metadata: Awaited<ReturnType<StillImageCaptureSession['accept']>>['metadata'],
    base64: string,
    onProgress: (status: import('./contribution-status').ContributionStatus) => void,
    replacesContributionId?: string,
    look?: PhotoRetroLook,
  ) => Promise<import('./contribution-status').ContributionStatus>;
  onDeletePhotoContribution?: (contributionId: string) => Promise<void>;
  onOpenArchive?: () => void;
  onBack?: () => void;
  onRecordClip?: () => void;
  revealState?: RevealEducationState;
}

/**
 * Camera route UI with honest capability/permission states and a local-only
 * still-image preview. Group names are presentation context, never authority.
 */
export function CameraCaptureScreen({
  createCaptureId,
  fileStore,
  groupName,
  metadataStore,
  now,
  onAccepted,
  onSubmitPhoto,
  onDeletePhotoContribution,
  onOpenArchive,
  onBack,
  onRecordClip,
  platform: platformProp,
  revealState = 'locked',
}: CameraCaptureScreenProps = {}) {
  useAllowLandscape();
  const cameraRef = useRef<CameraView>(null);
  const platform = useMemo(
    () =>
      platformProp ??
      new ExpoCameraPlatform({
        browserSystemCamera: true,
        getCameraRef: () => cameraRef.current,
      }),
    [platformProp],
  );
  const resolvedFileStore = useMemo(
    () =>
      fileStore ??
      (platform.kind === 'demo'
        ? new InMemoryCaptureFileStore()
        : Platform.OS === 'web'
          ? new WebCaptureFileStore()
          : new ExpoCaptureFileStore()),
    [fileStore, platform.kind],
  );
  const resolvedMetadataStore = useMemo(
    () =>
      metadataStore ??
      (platform.kind === 'demo'
        ? new InMemoryImageMetadataStore()
        : new AsyncStorageImageMetadataStore()),
    [metadataStore, platform.kind],
  );
  const session = useMemo(
    () =>
      new StillImageCaptureSession({
        createId: createCaptureId,
        fileStore: resolvedFileStore,
        metadataStore: resolvedMetadataStore,
        now,
        platform,
      }),
    [createCaptureId, now, platform, resolvedFileStore, resolvedMetadataStore],
  );
  const [state, setState] = useState<CaptureState>(initialCaptureState);
  const [cameraReady, setCameraReady] = useState(!platform.supportsLivePreview);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [photoSubmitPending, setPhotoSubmitPending] = useState(false);
  const [photoSubmitError, setPhotoSubmitError] = useState<string | null>(null);
  const [photoMode, setPhotoMode] = useState<CaptureMode>(DEFAULT_CAPTURE_MODE);
  // A retried submit reuses the same graded bytes under the same capture key.
  const retroPhotoRef = useRef<{ key: string; result: RetroPhotoResult } | null>(null);
  const contributionStatusContext = useOptionalContributionStatus();
  const contributionStatus = contributionStatusContext?.status ?? null;
  // Captures are asynchronous and the platform may resolve one after the route
  // was backgrounded. The sequence makes a stale completion a no-op so it
  // cannot publish a preview that nothing on this mount can act on.
  const captureSequence = useRef(0);
  const replacementTarget = useRef<string | undefined>(undefined);

  useEffect(() => {
    void session.restorePendingUpload().then((pending) => {
      if (!pending) return;
      setState((current) => ({
        ...current,
        status: 'preview',
        activePreview: { metadata: pending.metadata, uri: pending.previewUri },
        errorMessage: null,
      }));
    });
    if (!decideInterruption('restart').sweepOrphanedFiles) return;
    // Reclaim app-owned media left by a previous process on a cold start.
    void runCaptureRestartRecovery();
  }, [session]);

  const refreshAccess = useCallback(async () => {
    setSettingsError(null);
    // An established preview is a durable capture that this route still owns.
    // Re-checking access must not erase it; only an interruption that discards
    // the preview does that.
    setState((current) =>
      current.activePreview
        ? { ...current, errorMessage: null }
        : { ...current, status: 'checking', errorMessage: null },
    );
    try {
      const capabilities = await platform.getCapabilities();
      const permissions = await platform.getPermissions();
      setState((current) => {
        const next = accessState(capabilities, permissions);
        if (current.activePreview) {
          return { ...current, ...next, status: 'preview', errorMessage: null };
        }
        return { ...current, ...next, activePreview: null };
      });
      setCameraReady(!platform.supportsLivePreview);
    } catch {
      setState((current) => ({
        ...current,
        status: 'temporarily-unavailable',
        errorMessage: 'We could not check this device yet. Try again.',
      }));
    }
  }, [platform]);

  useEffect(() => {
    void refreshAccess();
    return () => {
      void session.dispose();
    };
  }, [refreshAccess, session]);

  // A still capture requires the native camera session, which the platform
  // suspends when the app is backgrounded. Any in-flight capture is abandoned
  // and its preview discarded; re-checking on foreground keeps the access
  // panel honest instead of showing a stale preview.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void refreshAccess();
        return;
      }
      if (nextState !== 'background' && nextState !== 'inactive') return;
      const decision = decideInterruption('background');
      captureSequence.current += 1;
      // A suspended camera cannot finish a capture, so abandon any in-flight
      // one. Without this the route would stay stuck on "Capturing…" with no
      // control able to leave it.
      setState((current) =>
        decision.discardPreview && (current.status === 'capturing' || current.activePreview)
          ? { ...current, status: 'ready', activePreview: null, errorMessage: null }
          : current,
      );
      // Release the managed copy only when this event discards the preview.
      // Deleting it while the panel stays visible would leave a preview that
      // points at a file which no longer exists.
      if (decision.discardPreview) void session.discard();
    });
    return () => subscription.remove();
  }, [refreshAccess, session]);

  const requestAccess = useCallback(async () => {
    setSettingsError(null);
    setState((current) => ({ ...current, status: 'checking', errorMessage: null }));
    try {
      const permissions = await platform.requestPermissions();
      const capabilities = await platform.getCapabilities();
      setState((current) => ({
        ...current,
        ...accessState(capabilities, permissions),
        activePreview: null,
      }));
      setCameraReady(!platform.supportsLivePreview);
    } catch {
      setState((current) => ({
        ...current,
        status: 'temporarily-unavailable',
        errorMessage: 'Camera access could not be checked right now. Try again or open Settings.',
      }));
    }
  }, [platform]);

  const openSettings = useCallback(async () => {
    setSettingsError(null);
    try {
      await platform.openSettings();
      await refreshAccess();
    } catch (error) {
      // Browser permission controls live in the address bar; keep guidance in
      // the route instead of failing silently or opening an arbitrary URL.
      setSettingsError(
        error instanceof Error ? error.message : 'Open this app settings to allow camera access.',
      );
    }
  }, [platform, refreshAccess]);

  const captureImage = useCallback(
    async (getImage: () => Promise<PlatformStillImage>, requireAccess: boolean) => {
      if (
        (requireAccess && !isCaptureReady(state)) ||
        (requireAccess && platform.supportsLivePreview && !cameraReady)
      )
        return;
      const sequence = ++captureSequence.current;
      setState((current) => ({ ...current, status: 'capturing', errorMessage: null }));
      try {
        const activePreview = await session.captureImage(
          await getImage(),
          () => sequence === captureSequence.current,
        );
        if (sequence !== captureSequence.current) {
          // The capture was abandoned while it was in flight. The session
          // already wrote a managed copy, so release only that operation's
          // file. A newer capture may now own the session preview.
          await session.discard(activePreview);
          return;
        }
        setState((current) => ({
          ...current,
          status: 'preview',
          activePreview: { metadata: activePreview.metadata, uri: activePreview.previewUri },
          errorMessage: null,
        }));
      } catch (error) {
        if (sequence !== captureSequence.current) return;
        setState((current) => ({
          ...current,
          status: error instanceof CaptureFileLifecycleError ? 'write-failed' : 'capture-failed',
          errorMessage:
            error instanceof Error
              ? error.message
              : 'The still image could not be captured. Try again.',
        }));
      }
    },
    [cameraReady, platform, session, state],
  );

  const capture = useCallback(async () => {
    await captureImage(() => platform.captureStill(), true);
  }, [captureImage, platform]);

  const retryCapture = useCallback(async () => {
    await captureImage(() => platform.captureStill(), true);
  }, [captureImage, platform]);

  const useSyntheticStill = useCallback(async () => {
    await captureImage(() => platform.captureStill(), false);
  }, [captureImage, platform]);

  const pickStillFile = useCallback(async () => {
    if (!platform.pickStillFile) return;
    // Wait for the chooser or camera sheet before entering the capturing
    // state; closing it without a photo leaves the screen unchanged.
    let picked: Awaited<ReturnType<NonNullable<typeof platform.pickStillFile>>>;
    try {
      picked = await platform.pickStillFile();
    } catch (error) {
      if (isCaptureCancelled(error)) return;
      await captureImage(() => Promise.reject(error), false);
      return;
    }
    await captureImage(() => Promise.resolve(picked), false);
  }, [captureImage, platform]);

  const fallbackAction = platform.kind === 'demo' ? useSyntheticStill : pickStillFile;
  const fallbackLabel =
    platform.kind === 'demo'
      ? 'Use synthetic still fixture'
      : platform.fileFallbackIsCamera
        ? 'Open camera'
        : 'Choose an image file';
  const hasFileFallback = platform.supportsFileFallback === true && Boolean(platform.pickStillFile);
  const hasFallback = platform.kind === 'demo' || hasFileFallback;

  const handleRevealAction = useCallback(() => {
    if (revealState === 'locked') {
      if (isCaptureReady(state) && (!platform.supportsLivePreview || cameraReady)) {
        void capture();
      } else if (state.status === 'permission-blocked') {
        void openSettings();
      } else if (state.status === 'unsupported' && hasFallback) {
        void fallbackAction();
      } else if (state.status === 'permission-undecided' || state.status === 'permission-denied') {
        void requestAccess();
      } else {
        void refreshAccess();
      }
      return;
    }
    onOpenArchive?.();
  }, [
    cameraReady,
    capture,
    fallbackAction,
    hasFallback,
    onOpenArchive,
    openSettings,
    platform.supportsLivePreview,
    refreshAccess,
    requestAccess,
    revealState,
    state,
  ]);
  const revealActionLabel =
    revealState === 'locked' && state.status === 'unsupported' && hasFallback
      ? fallbackLabel
      : revealState === 'locked' &&
          (!isCaptureReady(state) || (platform.supportsLivePreview && !cameraReady))
        ? 'Check capture access'
        : undefined;

  const retake = useCallback(async () => {
    await session.retake();
    setState((current) => ({
      ...current,
      status: 'ready',
      activePreview: null,
      errorMessage: null,
    }));
  }, [session]);

  const discard = useCallback(async () => {
    await session.discard();
    setState((current) => ({
      ...current,
      status: 'ready',
      activePreview: null,
      errorMessage: null,
    }));
  }, [session]);

  const accept = useCallback(async () => {
    setState((current) => ({ ...current, status: 'saving', errorMessage: null }));
    try {
      const result = await session.accept();
      setState((current) => ({ ...current, status: 'saved', errorMessage: null }));
      onAccepted?.(result.metadata);
    } catch (error) {
      setState((current) => ({
        ...current,
        status: 'write-failed',
        activePreview: null,
        errorMessage:
          error instanceof Error
            ? error.message
            : 'The image could not be saved locally. Try again.',
      }));
    }
  }, [onAccepted, session]);

  const submitPhoto = useCallback(async () => {
    const active = session.getActivePreview();
    if (!active || !onSubmitPhoto) return;
    if (
      active.metadata.byteLength > 10 * 1024 * 1024 ||
      active.metadata.width <= 0 ||
      active.metadata.height <= 0
    ) {
      setPhotoSubmitError('Choose a valid JPEG or PNG photo no larger than 10 MiB.');
      return;
    }
    setPhotoSubmitPending(true);
    setPhotoSubmitError(null);
    let latestStatus: import('./contribution-status').ContributionStatus = {
      state: 'queued',
      durationSeconds: 3,
      createdAt: active.metadata.capturedAt,
      retryable: true,
    };
    try {
      await session.retainForUpload();
      let base64 = await resolvedFileStore.readAsBase64(active.previewUri);
      let metadata = active.metadata;
      const mode = photoMode;
      // Web applies the retro look here, before upload; native uploads the
      // original and the server applies the same look.
      const clientProcessed = Platform.OS === 'web';
      if (clientProcessed) {
        const key = `${active.metadata.id}|${mode}`;
        let graded = retroPhotoRef.current?.key === key ? retroPhotoRef.current.result : null;
        if (!graded) {
          try {
            graded = await applyRetroLookToPhoto({
              base64,
              capturedAt: new Date(active.metadata.capturedAt),
              mimeType: active.metadata.mimeType,
              mode,
              seed: active.metadata.id,
            });
          } catch (error) {
            throw new Error(
              `${
                error instanceof Error ? error.message : 'The retro look could not be applied.'
              } Your original photo is kept; try again.`,
            );
          }
          retroPhotoRef.current = { key, result: graded };
        }
        base64 = graded.base64;
        metadata = {
          ...active.metadata,
          byteLength: graded.byteLength,
          format: 'jpg',
          height: graded.height,
          mimeType: graded.mimeType,
          width: graded.width,
        };
      }
      contributionStatusContext?.setStatus(latestStatus);
      const submittedStatus = await onSubmitPhoto(
        metadata,
        base64,
        (status) => {
          latestStatus = status;
          contributionStatusContext?.setStatus(status);
        },
        replacementTarget.current,
        { mode, clientProcessed },
      );
      retroPhotoRef.current = null;
      replacementTarget.current = undefined;
      contributionStatusContext?.setStatus(submittedStatus);
      await contributionStatusContext?.refreshStatus();
      await session.discard(active);
      setState((current) => ({
        ...current,
        status: 'ready',
        activePreview: null,
        errorMessage: null,
      }));
    } catch (error) {
      contributionStatusContext?.setStatus({
        ...latestStatus,
        state: 'failed',
        createdAt: latestStatus.createdAt || new Date().toISOString(),
        message:
          error instanceof Error ? error.message : 'The photo upload failed. Retry this photo.',
        retryable: true,
      });
      setPhotoSubmitError(
        error instanceof Error ? error.message : 'The photo upload failed. Retry this photo.',
      );
    } finally {
      setPhotoSubmitPending(false);
    }
  }, [contributionStatusContext, onSubmitPhoto, photoMode, resolvedFileStore, session]);

  const deletePhotoForReplacement = useCallback(async () => {
    if (
      !contributionStatus?.contributionId ||
      !onDeletePhotoContribution ||
      contributionStatus.state === 'processing' ||
      contributionStatus.deletionAvailability === 'used' ||
      contributionStatus.deletionAvailability === 'unavailable'
    )
      return;
    try {
      await onDeletePhotoContribution(contributionStatus.contributionId);
      replacementTarget.current = contributionStatus.contributionId;
      contributionStatusContext?.clearStatus();
      await contributionStatusContext?.refreshStatus();
      setPhotoSubmitError(null);
    } catch (error) {
      setPhotoSubmitError(
        error instanceof Error ? error.message : 'The contribution could not be deleted.',
      );
    }
  }, [contributionStatus, contributionStatusContext, onDeletePhotoContribution]);

  const showingViewfinder =
    !state.activePreview &&
    (state.status === 'ready' || state.status === 'capturing') &&
    (platform.supportsLivePreview || platform.kind === 'demo');

  return (
    <View
      style={[styles.screen, showingViewfinder && styles.viewfinderScreen]}
      testID="camera-screen"
    >
      {showingViewfinder ? (
        <>
          {platform.supportsLivePreview ? (
            <CameraView
              accessibilityLabel="Live camera viewfinder"
              facing="back"
              onCameraReady={() => setCameraReady(true)}
              ref={cameraRef}
              style={styles.fullScreenPreview}
              testID="camera-live-preview"
            />
          ) : (
            <View
              accessibilityLabel="Simulator fixture viewfinder"
              style={styles.fullScreenFixture}
            >
              <Text style={styles.fixturePreviewText}>READY FOR A FIXTURE PREVIEW</Text>
            </View>
          )}
          <View pointerEvents="box-none" style={styles.viewfinderChrome}>
            <View style={styles.viewfinderTop}>
              {onBack ? (
                <Pressable
                  accessibilityRole="button"
                  hitSlop={12}
                  onPress={onBack}
                  style={styles.viewfinderBack}
                  testID="capture-back-to-group"
                >
                  <Text style={styles.viewfinderBackText}>Back to group</Text>
                </Pressable>
              ) : null}
              {groupName ? (
                <Text
                  accessibilityLiveRegion="polite"
                  style={styles.viewfinderHint}
                  testID="camera-group-context"
                >
                  Group · {groupName}
                </Text>
              ) : null}
              <Text accessibilityRole="header" style={styles.viewfinderTitle}>
                Photo
              </Text>
              <Text accessibilityLiveRegion="polite" style={styles.viewfinderHint}>
                {state.status === 'capturing' ? 'Capturing…' : 'Frame your moment'}
              </Text>
              {revealState !== 'locked' ? (
                <View style={styles.viewfinderReveal} testID={`capture-reveal-${revealState}`}>
                  <Text style={styles.viewfinderHint}>
                    {getRevealEducationCopy('capture', revealState).title}
                  </Text>
                  <Pressable accessibilityRole="button" onPress={handleRevealAction}>
                    <Text style={styles.viewfinderBackText}>Open Archive</Text>
                  </Pressable>
                </View>
              ) : null}
              {onRecordClip ? (
                <Pressable accessibilityRole="button" onPress={onRecordClip}>
                  <Text style={styles.viewfinderBackText}>Video</Text>
                </Pressable>
              ) : null}
            </View>
            <View style={styles.viewfinderControls}>
              {settingsError ? <Text style={styles.errorText}>{settingsError}</Text> : null}
              <Pressable
                accessibilityHint="Takes one still image and opens a preview"
                accessibilityLabel="Take still image"
                accessibilityRole="button"
                accessibilityState={{
                  busy: state.status === 'capturing',
                  disabled: !cameraReady || state.status === 'capturing',
                }}
                disabled={!cameraReady || state.status === 'capturing'}
                onPress={capture}
                style={[
                  styles.shutter,
                  (!cameraReady || state.status === 'capturing') && styles.disabledControl,
                ]}
                testID="camera-capture"
              >
                <View style={styles.shutterInner} />
              </Pressable>
              <Text accessibilityLiveRegion="polite" style={styles.shutterCaption}>
                {state.status === 'capturing' ? 'Capturing…' : 'Tap to take photo'}
              </Text>
            </View>
          </View>
        </>
      ) : null}
      {!showingViewfinder ? (
        <ScrollView style={styles.panelScroll} contentContainerStyle={styles.panelContent}>
          {onBack ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={12}
              onPress={onBack}
              style={styles.back}
              testID="capture-panel-back-to-group"
            >
              <Text style={styles.backText}>Back to group</Text>
            </Pressable>
          ) : null}
          <View style={styles.heading}>
            <Text style={styles.eyebrow}>CAPTURE</Text>
            {groupName ? (
              <Text
                accessibilityLiveRegion="polite"
                style={styles.groupContext}
                testID="camera-group-context"
              >
                Group · {groupName}
              </Text>
            ) : null}
            <Text accessibilityRole="header" style={styles.title} testID="route-heading-camera">
              Add a still moment
            </Text>
            <Text style={styles.intro}>
              {onSubmitPhoto
                ? 'Review your photo, then submit it to this private group. The original stays on this device until upload is confirmed.'
                : 'Camera access stays on this device. Nothing is uploaded from this screen.'}
            </Text>
          </View>
          {state.status === 'ready' || state.status === 'preview' || state.status === 'saved' ? (
            <RevealEducationPanel
              actionLabel={revealActionLabel}
              onAction={handleRevealAction}
              state={revealState}
              surface="capture"
              testID={`capture-reveal-${revealState}`}
            />
          ) : null}
          {onRecordClip ? (
            <Pressable
              accessibilityRole="button"
              onPress={onRecordClip}
              style={styles.videoButton}
              testID="camera-record-clip"
            >
              <Text style={styles.videoButtonText}>
                {state.status === 'ready' && platform.supportsVideoRecording !== false
                  ? 'Record a 15-second clip'
                  : platform.kind === 'demo'
                    ? 'Open synthetic clip fallback'
                    : 'Open clip capture options'}
              </Text>
            </Pressable>
          ) : null}

          <ContributionStatusPanel
            deleteLabel="Delete and replace"
            onDelete={onDeletePhotoContribution ? deletePhotoForReplacement : undefined}
            onRetry={contributionStatus?.state === 'failed' ? () => void submitPhoto() : undefined}
            retryLabel="Retry photo upload"
            status={contributionStatus}
            testID="camera-contribution-status"
          />

          {platform.kind === 'demo' ? (
            <View
              accessibilityLabel="Simulator demo capture, not a real camera"
              style={styles.demoNotice}
            >
              <Text style={styles.demoNoticeTitle}>SIMULATOR DEMO</Text>
              <Text style={styles.demoNoticeText}>
                This uses a fixture preview because the simulator has no physical camera. It does
                not claim a real capture.
              </Text>
            </View>
          ) : null}

          {state.status === 'checking' ? (
            <StatusPanel
              testID="camera-checking"
              title="Checking camera access…"
              body="We are checking camera capability and permission."
            />
          ) : state.status === 'temporarily-unavailable' ? (
            <StatusPanel
              actionLabel="Check again"
              body={
                state.errorMessage ??
                'Camera availability needs to be checked before capture can begin.'
              }
              onAction={refreshAccess}
              onSecondaryAction={hasFallback ? fallbackAction : undefined}
              secondaryActionLabel={hasFallback ? fallbackLabel : undefined}
              testID="camera-temporarily-unavailable"
              title="Camera is temporarily unavailable"
            />
          ) : state.status === 'unsupported' ? (
            <StatusPanel
              actionLabel={hasFallback ? fallbackLabel : undefined}
              body={
                hasFallback
                  ? platform.kind === 'demo'
                    ? 'This simulator cannot provide a physical camera. The labelled synthetic fixture is available for the local Demo.'
                    : platform.fileFallbackIsCamera
                      ? 'Opens your phone camera. The photo comes back here so you can review it before you submit.'
                      : 'Live camera capture is not supported here. Choose an image file instead; it remains labelled as a file contribution.'
                  : 'This device cannot provide the camera needed for a still moment. Use a physical device with camera access.'
              }
              onAction={hasFallback ? fallbackAction : undefined}
              testID="camera-unsupported"
              title={
                platform.fileFallbackIsCamera
                  ? 'Take a photo'
                  : 'Camera capture is not supported here'
              }
            />
          ) : state.status === 'permission-undecided' ? (
            <StatusPanel
              actionLabel="Allow camera access"
              body="Rewind needs camera permission before the capture control becomes available."
              onAction={requestAccess}
              testID="camera-permission-undecided"
              title="Allow access to continue"
            />
          ) : state.status === 'permission-denied' ? (
            <StatusPanel
              actionLabel={hasFileFallback ? fallbackLabel : 'Try again'}
              secondaryActionLabel="Open Settings"
              body={
                state.errorMessage ??
                'Camera access is off. Try again, or allow camera access in Settings.'
              }
              onAction={hasFileFallback ? fallbackAction : requestAccess}
              onSecondaryAction={openSettings}
              testID="camera-permission-denied"
              title="Camera access is off"
            />
          ) : state.status === 'permission-blocked' ? (
            <StatusPanel
              actionLabel="Open Settings"
              body="Camera access is blocked. Open Settings, allow camera access, then return and check again."
              onAction={openSettings}
              testID="camera-permission-blocked"
              title="Permission is blocked"
            />
          ) : state.status === 'capture-failed' || state.status === 'write-failed' ? (
            <StatusPanel
              actionLabel="Try again"
              body={
                state.errorMessage ??
                'The still image could not be completed. Your previous preview was discarded.'
              }
              onAction={state.status === 'write-failed' ? refreshAccess : retryCapture}
              testID={
                state.status === 'write-failed' ? 'camera-write-failed' : 'camera-capture-failed'
              }
              title={state.status === 'write-failed' ? 'Local save failed' : 'Capture failed'}
            />
          ) : state.activePreview ? (
            <PreviewPanel
              demo={platform.kind === 'demo'}
              metadata={state.activePreview.metadata}
              onAccept={accept}
              onSubmit={onSubmitPhoto ? submitPhoto : undefined}
              mode={photoMode}
              onModeChange={setPhotoMode}
              submitError={photoSubmitError}
              submitting={photoSubmitPending}
              onDiscard={discard}
              onRetake={retake}
              previewUri={state.activePreview.uri}
              saving={state.status === 'saving'}
              saved={state.status === 'saved'}
            />
          ) : platform.fileFallbackIsCamera ? (
            // Web uses the phone's own camera sheet, so there is no in-page
            // viewfinder or access step; one button opens the camera.
            <View style={styles.captureArea}>
              <Pressable
                accessibilityHint="Opens your phone camera; the photo comes back here for review"
                accessibilityLabel="Open camera"
                accessibilityRole="button"
                accessibilityState={{ busy: state.status === 'capturing' }}
                disabled={state.status === 'capturing'}
                onPress={pickStillFile}
                style={[styles.shutter, state.status === 'capturing' && styles.disabledControl]}
                testID="camera-capture"
              >
                <Text style={styles.shutterText}>
                  {state.status === 'capturing' ? 'Preparing photo…' : 'Open camera'}
                </Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.captureArea}>
              <View accessibilityLabel="Camera access granted" style={styles.accessGranted}>
                <Text style={styles.accessGrantedTitle}>ACCESS GRANTED</Text>
                <Text style={styles.accessGrantedText}>Camera is ready for a still moment.</Text>
              </View>
              {platform.supportsLivePreview ? null : (
                <View
                  accessibilityLabel="Simulator fixture preview area"
                  style={styles.fixturePreview}
                >
                  <Text style={styles.fixturePreviewText}>READY FOR A FIXTURE PREVIEW</Text>
                </View>
              )}
              {!platform.supportsLivePreview ? (
                <Pressable
                  accessibilityHint="Takes one still image and opens a preview"
                  accessibilityLabel="Take still image"
                  accessibilityRole="button"
                  accessibilityState={{
                    busy: state.status === 'capturing',
                    disabled: !cameraReady,
                  }}
                  disabled={!cameraReady || state.status === 'capturing'}
                  onPress={capture}
                  style={[
                    styles.shutter,
                    (!cameraReady || state.status === 'capturing') && styles.disabledControl,
                  ]}
                  testID="camera-capture"
                >
                  <Text style={styles.shutterText}>
                    {state.status === 'capturing' ? 'Capturing…' : 'Take still image'}
                  </Text>
                </Pressable>
              ) : null}
              {settingsError ? <Text style={styles.errorText}>{settingsError}</Text> : null}
            </View>
          )}
        </ScrollView>
      ) : null}
    </View>
  );
}

function StatusPanel({
  actionLabel,
  body,
  onAction,
  onSecondaryAction,
  secondaryActionLabel,
  testID,
  title,
}: {
  actionLabel?: string;
  body: string;
  onAction?: () => void | Promise<void>;
  onSecondaryAction?: () => void | Promise<void>;
  secondaryActionLabel?: string;
  testID: string;
  title: string;
}) {
  return (
    <View accessibilityLiveRegion="polite" style={styles.statusPanel} testID={testID}>
      <Text style={styles.statusTitle}>{title}</Text>
      <Text style={styles.statusBody}>{body}</Text>
      {actionLabel && onAction ? (
        <Pressable accessibilityRole="button" onPress={onAction} style={styles.actionButton}>
          <Text style={styles.actionButtonText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
      {secondaryActionLabel && onSecondaryAction ? (
        <Pressable
          accessibilityRole="button"
          onPress={onSecondaryAction}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryButtonText}>{secondaryActionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function PreviewPanel({
  demo,
  metadata,
  mode,
  onModeChange,
  onAccept,
  onSubmit,
  submitError,
  submitting,
  onDiscard,
  onRetake,
  previewUri,
  saved,
  saving,
}: {
  demo: boolean;
  metadata: NonNullable<CaptureState['activePreview']>['metadata'];
  mode: CaptureMode;
  onModeChange: (mode: CaptureMode) => void;
  onAccept: () => void | Promise<void>;
  onSubmit?: () => void | Promise<void>;
  submitError?: string | null;
  submitting?: boolean;
  onDiscard: () => void | Promise<void>;
  onRetake: () => void | Promise<void>;
  previewUri: string;
  saved: boolean;
  saving: boolean;
}) {
  return (
    <View style={styles.previewArea} testID="camera-preview-panel">
      {demo ? (
        <View
          accessibilityLabel="Simulator fixture still preview"
          style={[styles.fixturePreview, styles.previewFixture]}
          testID="camera-demo-preview"
        >
          <Text style={styles.fixturePreviewText}>FIXTURE STILL</Text>
          <Text style={styles.fixturePreviewSubtext}>No physical image was captured</Text>
        </View>
      ) : (
        <Image
          accessibilityLabel="Captured still preview"
          source={{ uri: previewUri }}
          style={[styles.stillPreview, styles.previewImage]}
        />
      )}
      {metadata.source === 'file' ? (
        <Text style={styles.previewMeta}>
          FILE FALLBACK · selected locally, not camera-captured
        </Text>
      ) : null}
      <Text style={styles.previewMeta}>
        {metadata.width} × {metadata.height} · {metadata.format.toUpperCase()}
      </Text>
      {onSubmit && !saved ? (
        <View style={styles.previewActions} testID="camera-retro-look">
          {CAPTURE_MODES.map((option) => (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: mode === option, disabled: Boolean(submitting) }}
              disabled={Boolean(submitting)}
              key={option}
              onPress={() => onModeChange(option)}
              style={[styles.secondaryButton, mode === option && styles.selectedLook]}
            >
              <Text style={styles.secondaryButtonText}>{CAPTURE_MODE_LABELS[option]}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {submitError ? (
        <Text accessibilityLiveRegion="assertive" style={styles.errorText}>
          {submitError}
        </Text>
      ) : null}
      {saved ? (
        <Text style={styles.savedText}>Saved locally. Metadata only is retained.</Text>
      ) : null}
      {saved ? (
        <Pressable accessibilityRole="button" onPress={onRetake} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Take another still</Text>
        </Pressable>
      ) : (
        <View style={styles.previewActions}>
          <Pressable accessibilityRole="button" onPress={onRetake} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Retake</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{
              busy: saving || Boolean(submitting),
              disabled: saving || Boolean(submitting),
            }}
            disabled={saving || Boolean(submitting)}
            onPress={onSubmit ?? onAccept}
            style={[styles.actionButton, saving && styles.disabledControl]}
          >
            <Text style={styles.actionButtonText}>
              {submitting
                ? 'Uploading…'
                : onSubmit
                  ? 'Submit photo'
                  : saving
                    ? 'Saving…'
                    : 'Use this still'}
            </Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onDiscard} style={styles.discardButton}>
            <Text style={styles.discardButtonText}>Discard</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, minHeight: 0 },
  panelScroll: { flex: 1, minHeight: 0 },
  panelContent: { flexGrow: 1, gap: 18, padding: 24 },
  viewfinderScreen: { backgroundColor: '#080808', gap: 0, padding: 0, position: 'relative' },
  fullScreenPreview: { ...StyleSheet.absoluteFill, backgroundColor: '#080808' },
  fullScreenFixture: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    backgroundColor: '#181818',
    justifyContent: 'center',
  },
  viewfinderChrome: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'space-between',
    paddingBottom: 28,
    paddingHorizontal: 24,
    paddingTop: 28,
  },
  viewfinderTop: { alignItems: 'center', gap: 8 },
  // Back controls keep a 44pt tap target; on an installed iPhone web app they
  // sit near the status bar, where a text-height target is easy to miss.
  viewfinderBack: { alignSelf: 'flex-start', justifyContent: 'center', minHeight: 44 },
  back: { alignSelf: 'flex-start', justifyContent: 'center', minHeight: 44 },
  viewfinderBackText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  backText: { color: COLORS.accent, fontSize: 16, fontWeight: '700' },
  viewfinderTitle: { color: '#fff', fontSize: 20, fontWeight: '700' },
  viewfinderHint: { color: '#fff', fontSize: 14, textShadowColor: '#000', textShadowRadius: 5 },
  viewfinderReveal: {
    alignItems: 'center',
    backgroundColor: '#0009',
    borderRadius: 8,
    gap: 4,
    padding: 8,
  },
  viewfinderControls: { alignItems: 'center', gap: 12 },
  shutterCaption: { color: '#fff', fontSize: 13, textShadowColor: '#000', textShadowRadius: 5 },
  heading: { gap: 7 },
  groupContext: { color: COLORS.ink, fontSize: 16, fontWeight: '700' },
  eyebrow: { color: COLORS.edge, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  title: { color: COLORS.ink, fontSize: 30, fontWeight: '700' },
  intro: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  demoNotice: {
    backgroundColor: COLORS.deep,
    borderColor: COLORS.edge,
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
    padding: 12,
  },
  videoButton: {
    alignItems: 'center',
    borderColor: COLORS.edge,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  videoButtonText: { color: COLORS.ink, fontSize: 14, fontWeight: '700' },
  demoNoticeTitle: { color: COLORS.edge, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  demoNoticeText: { color: COLORS.muted, fontSize: 12, lineHeight: 18 },
  statusPanel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 10,
    borderWidth: 1,
    gap: 12,
    padding: 18,
  },
  statusTitle: { color: COLORS.ink, fontSize: 20, fontWeight: '700' },
  statusBody: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  actionButton: {
    alignItems: 'center',
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  actionButtonText: { color: COLORS.deep, fontSize: 14, fontWeight: '800' },
  selectedLook: { backgroundColor: COLORS.accent },
  secondaryButton: {
    alignItems: 'center',
    borderColor: COLORS.edge,
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  secondaryButtonText: { color: COLORS.ink, fontSize: 14, fontWeight: '700' },
  captureArea: { flex: 1, gap: 14, minHeight: 420 },
  accessGranted: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
    padding: 12,
  },
  accessGrantedTitle: { color: COLORS.accent, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  accessGrantedText: { color: COLORS.muted, fontSize: 12, lineHeight: 18 },
  livePreview: {
    backgroundColor: COLORS.deep,
    borderRadius: 10,
    flex: 1,
    minHeight: 300,
    overflow: 'hidden',
  },
  fixturePreview: {
    alignItems: 'center',
    backgroundColor: COLORS.deep,
    borderColor: COLORS.edge,
    borderRadius: 10,
    borderStyle: 'dashed',
    borderWidth: 1,
    flex: 1,
    gap: 8,
    justifyContent: 'center',
    minHeight: 300,
    padding: 24,
  },
  fixturePreviewText: {
    color: COLORS.edge,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    textAlign: 'center',
  },
  fixturePreviewSubtext: { color: COLORS.muted, fontSize: 12, textAlign: 'center' },
  shutter: {
    alignItems: 'center',
    backgroundColor: '#fff',
    borderColor: 'rgba(255,255,255,0.8)',
    borderRadius: 40,
    borderWidth: 5,
    justifyContent: 'center',
    height: 76,
    width: 76,
  },
  shutterInner: {
    backgroundColor: '#fff',
    borderColor: '#444',
    borderRadius: 32,
    borderWidth: 1,
    height: 62,
    width: 62,
  },
  shutterText: { color: COLORS.deep, fontSize: 15, fontWeight: '800' },
  disabledControl: { opacity: 0.48 },
  errorText: { color: COLORS.edge, fontSize: 13, textAlign: 'center' },
  previewArea: { flex: 1, flexShrink: 1, gap: 12, minHeight: 0 },
  previewFixture: {
    flex: 0,
    flexGrow: 0,
    flexShrink: 1,
    height: 360,
    maxHeight: 360,
    minHeight: 0,
  },
  stillPreview: {
    backgroundColor: COLORS.deep,
    borderRadius: 10,
    flex: 1,
    minHeight: 300,
    width: '100%',
  },
  previewImage: { flex: 0, flexGrow: 0, flexShrink: 1, height: 360, maxHeight: 360, minHeight: 0 },
  previewMeta: { color: COLORS.muted, fontSize: 12, textAlign: 'center' },
  previewActions: { gap: 10 },
  savedText: { color: COLORS.accent, fontSize: 13, textAlign: 'center' },
  discardButton: { alignItems: 'center', minHeight: 44, justifyContent: 'center', padding: 8 },
  discardButtonText: { color: COLORS.edge, fontSize: 13, fontWeight: '700' },
});
