import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAllowLandscape } from '../runtime/PortraitGuard';
import { CameraView } from 'expo-camera';
import { AppState, Image, Platform, StyleSheet, Text, View } from 'react-native';

import type { ContributionLedgerAllowance } from '../domain/contributions';
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
import { DEFAULT_CAPTURE_MODE, type CaptureMode } from '../domain/video';
import { LookPreview } from './LookPreview';
import { applyRetroLookToPhoto, type RetroPhotoResult } from './retro-browser';
import { useOptionalContributionStatus } from './contribution-status';
import { decideInterruption } from './capture-interruption';
import { runCaptureRestartRecovery } from './reset';
import { FONT } from '../ui/tokens';
import {
  CamBottom,
  CamButton,
  CamCard,
  CamTop,
  CameraFrame,
  FailedPanel,
  FlashFx,
  LookPicker,
  ModeSwitch,
  MomentsButton,
  MomentsDialog,
  Notice,
  PHOTO_SECONDS,
  ReviewActions,
  SealedOverlay,
  Shutter,
  ShutterRow,
  Tag,
  UploadPanel,
  allowanceLeft,
} from './camera-ui';

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
  /** Close (×): back to the group. */
  onBack?: () => void;
  /** The Video tab of the mode switch. */
  onRecordClip?: () => void;
  revealState?: RevealEducationState;
  /** This week's allowance from the group ledger, for the pill before any moment exists. */
  allowance?: ContributionLedgerAllowance | null;
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
  allowance: allowanceProp = null,
  revealState = 'locked',
}: CameraCaptureScreenProps = {}) {
  useAllowLandscape();
  const cameraRef = useRef<CameraView>(null);
  const useSystemCamera = !onSubmitPhoto;
  const platform = useMemo(
    () =>
      platformProp ??
      new ExpoCameraPlatform({
        browserSystemCamera: useSystemCamera,
        getCameraRef: () => cameraRef.current,
      }),
    [platformProp, useSystemCamera],
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
  // V8 after a seal from this screen; a status restored from storage never shows it.
  const [sealed, setSealed] = useState(false);
  const [failureDismissed, setFailureDismissed] = useState(false);
  const [momentsOpen, setMomentsOpen] = useState(false);
  const [flash, setFlash] = useState(0);
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
    setFailureDismissed(false);
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
      setSealed(true);
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
      setMomentsOpen(false);
    } catch (error) {
      setPhotoSubmitError(
        error instanceof Error ? error.message : 'The contribution could not be deleted.',
      );
    }
  }, [contributionStatus, contributionStatusContext, onDeletePhotoContribution]);

  const preview = state.activePreview;
  const capturing = state.status === 'capturing';
  // Web opens the phone's own camera sheet, so the viewfinder has no live image.
  const systemCamera = platform.fileFallbackIsCamera === true && hasFileFallback;
  const viewfinder =
    !preview &&
    (state.status === 'ready' || capturing || (systemCamera && state.status === 'unsupported'));
  const liveCamera = viewfinder && platform.supportsLivePreview && state.status !== 'unsupported';
  const allowance = contributionStatus?.allowance ?? allowanceProp;
  const left = allowanceLeft(allowance);
  // P1: a photo takes 3 s, so the shutter is off with less than that left.
  const photoBlocked = left !== null && left.seconds < PHOTO_SECONDS;
  const shutterDisabled =
    photoBlocked || capturing || (!systemCamera && platform.supportsLivePreview && !cameraReady);
  const shoot = () => {
    if (systemCamera) {
      void pickStillFile();
      return;
    }
    setFlash((value) => value + 1);
    void capture();
  };
  const revealCopy =
    revealState !== 'locked' ? getRevealEducationCopy('capture', revealState) : null;

  return (
    <CameraFrame bokeh={!liveCamera && !preview} testID="camera-screen">
      {/* The viewfinder has no visible title; screen readers and route focus land here. */}
      <Text accessibilityRole="header" style={styles.srOnly} testID="route-heading-camera">
        Add a moment
      </Text>
      {liveCamera ? (
        <LookPreview mode={photoMode} testID="photo-live-look">
          <CameraView
            accessibilityLabel="Live camera viewfinder"
            facing="back"
            onCameraReady={() => setCameraReady(true)}
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            testID="camera-live-preview"
          />
        </LookPreview>
      ) : null}
      {viewfinder && platform.kind === 'demo' ? (
        <View accessibilityLabel="Simulator fixture viewfinder" style={styles.fixture}>
          <Text style={styles.fixtureText}>READY FOR A FIXTURE PREVIEW</Text>
        </View>
      ) : null}
      {preview ? (
        <View style={StyleSheet.absoluteFill} testID="camera-preview-panel">
          {platform.kind === 'demo' ? (
            <View
              accessibilityLabel="Simulator fixture still preview"
              style={styles.fixture}
              testID="camera-demo-preview"
            >
              <Text style={styles.fixtureText}>FIXTURE STILL</Text>
              <Text style={styles.fixtureSub}>No physical image was captured</Text>
            </View>
          ) : (
            <LookPreview mode={photoMode} testID="photo-review-look">
              <Image
                accessibilityLabel="Captured still preview"
                resizeMode="contain"
                source={{ uri: preview.uri }}
                style={StyleSheet.absoluteFill}
              />
            </LookPreview>
          )}
          <CamBottom>
            {preview.metadata.source === 'file' ? <Tag>Chosen from a file</Tag> : null}
            {photoSubmitPending ? (
              <UploadPanel label="Uploading…" testID="camera-uploading" />
            ) : photoSubmitError && !failureDismissed ? (
              <FailedPanel
                accessibilityLabel={`Couldn’t upload. ${photoSubmitError} It’s kept on this phone and doesn’t count until it’s sealed.`}
                detail={`${photoSubmitError} It’s kept on this phone and doesn’t count until it’s sealed.`}
                onBackToReview={() => setFailureDismissed(true)}
                onRetry={() => void submitPhoto()}
                retryLabel="Retry photo upload"
                testID="camera-upload-failed"
                title="Couldn’t upload"
              />
            ) : (
              <>
                {onSubmitPhoto && state.status !== 'saved' ? (
                  <LookPicker mode={photoMode} onChange={setPhotoMode} testID="camera-retro-look" />
                ) : null}
                {onSubmitPhoto ? (
                  <Text style={styles.caption}>
                    Counts as one moment · {PHOTO_SECONDS} s in the film
                  </Text>
                ) : null}
                {state.status === 'saved' ? (
                  <>
                    <Notice alert={false}>Saved locally. Metadata only is retained.</Notice>
                    <CamButton label="Take another still" onPress={() => void retake()} />
                  </>
                ) : (
                  <>
                    <ReviewActions>
                      <CamButton
                        label="Retake"
                        onPress={() => void retake()}
                        style={styles.retake}
                      />
                      <CamButton
                        busy={state.status === 'saving'}
                        icon={onSubmitPhoto ? 'lock' : undefined}
                        label={
                          onSubmitPhoto
                            ? 'Seal'
                            : state.status === 'saving'
                              ? 'Saving…'
                              : 'Use this still'
                        }
                        onPress={() => void (onSubmitPhoto ? submitPhoto() : accept())}
                        primary
                        style={styles.seal}
                        testID="camera-seal"
                      />
                    </ReviewActions>
                    {onSubmitPhoto ? null : (
                      <CamButton height={44} label="Discard" onPress={() => void discard()} />
                    )}
                  </>
                )}
              </>
            )}
          </CamBottom>
        </View>
      ) : null}
      <FlashFx fire={flash} />
      <CamTop
        allowance={allowance}
        closeTestID="capture-back-to-group"
        groupName={groupName}
        onClose={onBack}
      >
        {platform.kind === 'demo' ? (
          <View accessibilityLabel="Simulator demo capture, not a real camera" accessible>
            <Tag>Simulator demo · fixture, not a real camera</Tag>
          </View>
        ) : null}
        {revealCopy ? (
          <View style={styles.reveal} testID={`capture-reveal-${revealState}`}>
            <Notice alert={false}>{revealCopy.title}</Notice>
            {onOpenArchive ? (
              <CamButton height={44} label="Open Archive" onPress={onOpenArchive} />
            ) : null}
          </View>
        ) : null}
      </CamTop>

      {preview || viewfinder ? null : state.status === 'checking' ? (
        <CamCard
          body="We are checking camera capability and permission."
          testID="camera-checking"
          title="Checking camera access…"
        />
      ) : state.status === 'temporarily-unavailable' ? (
        <CamCard
          body={
            state.errorMessage ??
            'Camera availability needs to be checked before capture can begin.'
          }
          testID="camera-temporarily-unavailable"
          title="Camera is temporarily unavailable"
        >
          <CamButton height={48} label="Check again" onPress={() => void refreshAccess()} soft />
          {hasFallback ? (
            <CamButton height={48} label={fallbackLabel} onPress={() => void fallbackAction()} />
          ) : null}
        </CamCard>
      ) : state.status === 'unsupported' ? (
        <CamCard
          body={
            hasFallback
              ? platform.kind === 'demo'
                ? 'This simulator cannot provide a physical camera. The labelled synthetic fixture is available instead.'
                : 'Live camera capture is not supported here. Choose an image file instead; it remains labelled as a file contribution.'
              : 'This device cannot provide the camera needed for a still moment. Use a physical device with camera access.'
          }
          testID="camera-unsupported"
          title="Camera capture is not supported here"
        >
          {hasFallback ? (
            <CamButton
              height={48}
              label={fallbackLabel}
              onPress={() => void fallbackAction()}
              soft
            />
          ) : null}
        </CamCard>
      ) : state.status === 'permission-undecided' ? (
        // V1: asked only when the camera first opens; there is no skip.
        <CamCard
          body="Rewind needs the camera to take a photo."
          testID="camera-permission-undecided"
          title="Allow the camera"
        >
          <CamButton height={48} label="Continue" onPress={() => void requestAccess()} soft />
        </CamCard>
      ) : state.status === 'permission-denied' || state.status === 'permission-blocked' ? (
        // V2: the system prompt will not show again, so Settings is the way back.
        <CamCard
          body="Turn Camera on for Rewind in your phone’s Settings, then come back. Nothing was recorded."
          testID={
            state.status === 'permission-blocked'
              ? 'camera-permission-blocked'
              : 'camera-permission-denied'
          }
          title="The camera is off"
        >
          {settingsError ? <Notice>{settingsError}</Notice> : null}
          <CamButton height={48} label="Open Settings" onPress={() => void openSettings()} soft />
          <CamButton
            height={48}
            label="Check again"
            onPress={() =>
              void (state.status === 'permission-denied' ? requestAccess() : refreshAccess())
            }
          />
          {hasFileFallback ? (
            <CamButton height={48} label={fallbackLabel} onPress={() => void fallbackAction()} />
          ) : null}
        </CamCard>
      ) : state.status === 'capture-failed' || state.status === 'write-failed' ? (
        <CamCard
          body={
            state.errorMessage ??
            'The still image could not be completed. Your previous preview was discarded.'
          }
          testID={state.status === 'write-failed' ? 'camera-write-failed' : 'camera-capture-failed'}
          title={state.status === 'write-failed' ? 'Local save failed' : 'Capture failed'}
        >
          <CamButton
            height={48}
            label="Try again"
            onPress={() =>
              void (state.status === 'write-failed' ? refreshAccess() : retryCapture())
            }
            soft
          />
        </CamCard>
      ) : null}

      {preview ? null : (
        <CamBottom>
          {viewfinder && settingsError ? <Notice>{settingsError}</Notice> : null}
          <ModeSwitch mode="photo" onVideo={onRecordClip} videoTestID="camera-record-clip" />
          {viewfinder ? (
            <>
              {onSubmitPhoto ? (
                <LookPicker
                  mode={photoMode}
                  onChange={setPhotoMode}
                  testID="photo-live-look-picker"
                />
              ) : null}
              <ShutterRow
                center={
                  <Shutter
                    busy={capturing}
                    disabled={shutterDisabled}
                    hint={
                      systemCamera
                        ? 'Opens your phone camera; the photo comes back here for review'
                        : 'Takes one still image and opens a preview'
                    }
                    kind="photo"
                    label="Take photo"
                    onPress={shoot}
                    testID="camera-capture"
                  />
                }
                left={
                  contributionStatus ? (
                    <MomentsButton
                      count={allowance?.countUsed}
                      onPress={() => setMomentsOpen(true)}
                    />
                  ) : null
                }
              />
              <Text accessibilityLiveRegion="polite" style={styles.caption}>
                {photoBlocked
                  ? `A photo needs ${PHOTO_SECONDS} s; you have ${left.seconds} s left this week.`
                  : capturing
                    ? systemCamera
                      ? 'Preparing photo…'
                      : 'Capturing…'
                    : systemCamera
                      ? 'Opens your phone camera'
                      : ' '}
              </Text>
            </>
          ) : null}
        </CamBottom>
      )}

      {sealed ? (
        <SealedOverlay
          left={left?.moments ?? null}
          onDone={() => {
            setSealed(false);
            onBack?.();
          }}
          testID="camera-sealed"
        />
      ) : null}
      {momentsOpen ? (
        <MomentsDialog
          onClose={() => setMomentsOpen(false)}
          onDelete={onDeletePhotoContribution ? deletePhotoForReplacement : undefined}
          onRetry={contributionStatus?.state === 'failed' ? () => void submitPhoto() : undefined}
          retryLabel="Retry photo upload"
          status={contributionStatus}
        />
      ) : null}
    </CameraFrame>
  );
}

const styles = StyleSheet.create({
  srOnly: {
    height: 1,
    left: 0,
    opacity: 0,
    overflow: 'hidden',
    position: 'absolute',
    top: 0,
    width: 1,
  },
  fixture: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    gap: 8,
    justifyContent: 'center',
    padding: 24,
  },
  fixtureText: {
    color: 'rgba(255, 255, 255, 0.82)',
    fontFamily: FONT.body,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textAlign: 'center',
  },
  fixtureSub: { color: 'rgba(255, 255, 255, 0.82)', fontFamily: FONT.body, fontSize: 12 },
  caption: {
    color: 'rgba(255, 255, 255, 0.86)',
    fontFamily: FONT.body,
    fontSize: 13,
    minHeight: 18,
    textAlign: 'center',
    textShadowColor: 'rgba(0, 0, 0, 0.6)',
    textShadowRadius: 6,
  },
  reveal: { alignItems: 'center', gap: 8, marginTop: 4 },
  retake: { flex: 1 },
  seal: { flex: 1.6 },
});
