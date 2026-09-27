import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CameraView } from 'expo-camera';
import { AppState, Image, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { ScreenDebug } from '../debug/DebugProvider';
import { useI18n } from '../i18n/LanguageProvider';
import { COLORS } from '../theme';
import {
  ActionButton,
  ButtonRow,
  MockMedia,
  ScreenIntro,
  Separator,
  StepLine,
  kitStyles,
} from '../ui/kit';
import { RevealEducationPanel } from '../capsule/RevealEducationPanel';
import type { RevealEducationState } from '../domain/reveal-education';
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
import { ExpoCameraPlatform } from './platform';
import { StillImageCaptureSession } from './still-image-session';
import { ContributionStatusPanel, useOptionalContributionStatus } from './contribution-status';
import { decideInterruption } from './capture-interruption';
import { runCaptureRestartRecovery } from './reset';

export interface CameraCaptureScreenProps {
  platform?: CameraPlatform;
  fileStore?: CaptureFileStore;
  metadataStore?: ImageMetadataStore;
  now?: () => Date;
  createCaptureId?: () => string;
  onAccepted?: (
    metadata: Awaited<ReturnType<StillImageCaptureSession['accept']>>['metadata'],
  ) => void;
  onOpenArchive?: () => void;
  onRecordClip?: () => void;
  revealState?: RevealEducationState;
  /** Settings debug mode: forces a study state without touching capture data. */
  debug?: ScreenDebug<CameraDebugScenario>;
  /**
   * Ask for camera and microphone access as soon as the screen finds them
   * undecided, so the first visit shows the system prompt directly. The
   * in-app "Allow" panel remains the retry path after a dismissal.
   */
  autoRequestPermission?: boolean;
}

/**
 * Camera route UI with honest capability/permission states and a local-only
 * still-image preview. It does not know about identity, groups, or reveal.
 */
export function CameraCaptureScreen({
  autoRequestPermission = false,
  createCaptureId,
  debug,
  fileStore,
  metadataStore,
  now,
  onAccepted,
  onOpenArchive,
  onRecordClip,
  platform: platformProp,
  revealState = 'locked',
}: CameraCaptureScreenProps = {}) {
  const { t } = useI18n();
  const cameraRef = useRef<CameraView>(null);
  const platform = useMemo(
    () =>
      platformProp ??
      new ExpoCameraPlatform({
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
  const contributionStatus = useOptionalContributionStatus()?.status ?? null;
  // Captures are asynchronous and the platform may resolve one after the route
  // was backgrounded. The sequence makes a stale completion a no-op so it
  // cannot publish a preview that nothing on this mount can act on.
  const captureSequence = useRef(0);

  useEffect(() => {
    if (!decideInterruption('restart').sweepOrphanedFiles) return;
    // Reclaim app-owned media left by a previous process on a cold start.
    void runCaptureRestartRecovery();
  }, []);

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

  const autoRequested = useRef(false);
  useEffect(() => {
    if (!autoRequestPermission || debug?.scenario || autoRequested.current) return;
    if (state.status !== 'permission-undecided') return;
    autoRequested.current = true;
    // Defer so the system prompt is requested after this render commits.
    void Promise.resolve().then(requestAccess);
  }, [autoRequestPermission, debug?.scenario, requestAccess, state.status]);

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
    await captureImage(() => platform.pickStillFile!(), false);
  }, [captureImage, platform]);

  const fallbackAction = platform.kind === 'demo' ? useSyntheticStill : pickStillFile;
  const fallbackLabel =
    platform.kind === 'demo' ? 'Use synthetic still fixture' : 'Choose an image file';
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

  // Debug mode forces one of the study states. Actions then move between the
  // study states instead of touching the camera, file store, or metadata.
  const forced = debug?.scenario ? forcedCaptureState(debug.scenario) : null;
  const view = forced ?? state;
  const whenForced =
    (real: () => void | Promise<void>, next: CameraDebugScenario | 'live') =>
    (): void | Promise<void> => (debug?.scenario ? debug.set(next) : real());
  const demoPreview = platform.kind === 'demo' || Boolean(forced);
  const stepIndex = view.status === 'saved' ? 2 : view.activePreview ? 1 : 0;

  return (
    <ScrollView
      contentContainerStyle={kitStyles.content}
      style={kitStyles.scroll}
      testID="camera-screen"
    >
      <ScreenIntro
        body={t('Stills stay on this device; they are not group-film submissions.')}
        eyebrow={t('CAMERA / STILL')}
        headingTestID="route-heading-camera"
        title={t('Keep a still.')}
      />

      {platform.kind === 'demo' ? (
        <View
          accessibilityLabel={t('Simulator demo capture, not a real camera')}
          style={styles.demoNotice}
        >
          <Text style={styles.demoNoticeTitle}>{t('SIMULATOR DEMO')}</Text>
          <Text style={styles.demoNoticeText}>
            {t(
              'This uses a fixture preview because the simulator has no physical camera. It does not claim a real capture.',
            )}
          </Text>
        </View>
      ) : null}

      {view.status === 'checking' ? (
        <StatusPanel
          testID="camera-checking"
          title={t('Checking access…')}
          body={t('Checking camera and microphone.')}
        />
      ) : view.status === 'temporarily-unavailable' ? (
        <StatusPanel
          actionLabel={t('Check again')}
          body={t(
            view.errorMessage ??
              'Camera availability needs to be checked before capture can begin.',
          )}
          onAction={refreshAccess}
          onSecondaryAction={hasFallback ? fallbackAction : undefined}
          secondaryActionLabel={hasFallback ? t(fallbackLabel) : undefined}
          testID="camera-temporarily-unavailable"
          title={t('Camera is temporarily unavailable')}
        />
      ) : view.status === 'unsupported' ? (
        <StatusPanel
          actionLabel={hasFallback ? t(fallbackLabel) : undefined}
          body={t(
            hasFallback
              ? platform.kind === 'demo'
                ? 'This simulator cannot provide a physical camera. The labelled synthetic fixture is available for the local Demo.'
                : 'Live camera capture is not supported here. Choose an image file instead; it remains labelled as a file contribution.'
              : 'This device cannot provide the camera needed for a still moment. Use a physical device with camera access.',
          )}
          onAction={hasFallback ? fallbackAction : undefined}
          testID="camera-unsupported"
          title={t('Camera capture is not supported here')}
        />
      ) : view.status === 'permission-undecided' ? (
        <StatusPanel
          actionLabel={t('Allow camera and microphone')}
          body={t('Permissions are checked before capture.')}
          onAction={whenForced(requestAccess, 'live')}
          testID="camera-permission-undecided"
          title={t('Allow camera access')}
        />
      ) : view.status === 'permission-denied' ? (
        <StatusPanel
          actionLabel={t(hasFileFallback && !forced ? fallbackLabel : 'Try again')}
          secondaryActionLabel={t('Open Settings')}
          body={t(view.errorMessage ?? 'Check camera access in device Settings.')}
          onAction={whenForced(hasFileFallback ? fallbackAction : requestAccess, 'live')}
          onSecondaryAction={whenForced(openSettings, 'live')}
          testID="camera-permission-denied"
          title={t('Camera access denied')}
        />
      ) : view.status === 'permission-blocked' ? (
        <StatusPanel
          actionLabel={t('Open Settings')}
          body={t(
            'Camera or microphone access is blocked. Open Settings, allow both permissions, then return and check again.',
          )}
          onAction={openSettings}
          testID="camera-permission-blocked"
          title={t('Permission is blocked')}
        />
      ) : view.status === 'capture-failed' || view.status === 'write-failed' ? (
        <StatusPanel
          actionLabel={t('Try again')}
          alert
          body={t(view.errorMessage ?? 'Still not saved. No contribution was submitted.')}
          onAction={whenForced(
            view.status === 'write-failed' ? refreshAccess : retryCapture,
            'live',
          )}
          testID={view.status === 'write-failed' ? 'camera-write-failed' : 'camera-capture-failed'}
          title={view.status === 'write-failed' ? t('Local save failed') : t('Capture failed')}
        />
      ) : view.activePreview ? (
        <>
          <StepLine
            accessibilityLabel={t('Step {step} of 3', { step: stepIndex + 1 })}
            active={stepIndex}
            steps={[t('Capture'), t('Review'), t('Accept locally')]}
          />
          <PreviewPanel
            demo={demoPreview}
            metadata={view.activePreview.metadata}
            onAccept={whenForced(accept, 'saved')}
            onDiscard={whenForced(discard, 'live')}
            onRetake={whenForced(retake, 'live')}
            previewUri={view.activePreview.uri}
            saving={view.status === 'saving'}
            saved={view.status === 'saved'}
          />
        </>
      ) : (
        <View style={styles.captureArea}>
          <StepLine
            accessibilityLabel={t('Step {step} of 3', { step: 1 })}
            active={0}
            steps={[t('Capture'), t('Review'), t('Accept locally')]}
          />
          <View
            accessibilityLabel={t('Camera and microphone access granted')}
            style={styles.accessGranted}
          >
            <Text style={styles.accessGrantedTitle}>{t('ACCESS GRANTED')}</Text>
            <Text style={styles.accessGrantedText}>
              {t('Camera and microphone are ready for a still moment.')}
            </Text>
          </View>
          {platform.supportsLivePreview ? (
            <CameraView
              accessibilityLabel={t('Live camera preview')}
              facing="back"
              onCameraReady={() => setCameraReady(true)}
              ref={cameraRef}
              style={styles.livePreview}
              testID="camera-live-preview"
            />
          ) : (
            <MockMedia
              caption={t('No physical image was captured.')}
              kind="still"
              title={t('Synthetic still fixture')}
            />
          )}
          <ActionButton
            accessibilityHint={t('Takes one still image and opens a preview')}
            accessibilityLabel={t('Take still image')}
            busy={view.status === 'capturing'}
            disabled={!cameraReady}
            full
            label={view.status === 'capturing' ? t('Capturing…') : t('Take still image')}
            onPress={capture}
            testID="camera-capture"
            variant="primary"
          />
          {settingsError ? <Text style={styles.errorText}>{t(settingsError)}</Text> : null}
        </View>
      )}

      {revealState !== 'locked' &&
      (view.status === 'ready' || view.status === 'preview' || view.status === 'saved') ? (
        <RevealEducationPanel
          onAction={onOpenArchive}
          state={revealState}
          surface="capture"
          testID={`capture-reveal-${revealState}`}
        />
      ) : null}

      <Separator />
      <ContributionStatusPanel status={contributionStatus} testID="camera-contribution-status" />
      {onRecordClip ? (
        <ActionButton
          full
          label={
            view.status === 'ready' && platform.supportsVideoRecording !== false
              ? t('Record a 15-second clip')
              : platform.kind === 'demo'
                ? t('Open sample clip path')
                : t('Open clip capture options')
          }
          onPress={onRecordClip}
          testID="camera-record-clip"
        />
      ) : null}
    </ScrollView>
  );
}

export type CameraDebugScenario =
  'permission' | 'denied' | 'loading' | 'preview' | 'saved' | 'error';

function forcedCaptureState(scenario: CameraDebugScenario): CaptureState {
  const fixturePreview = {
    uri: '',
    metadata: {
      byteLength: 0,
      capturedAt: '2026-09-27T10:24:00.000Z',
      format: 'jpg' as const,
      height: 900,
      id: 'debug-still-fixture',
      mimeType: 'image/jpeg' as const,
      source: 'demo-fixture' as const,
      width: 1200,
    },
  };
  const base: CaptureState = { ...initialCaptureState };
  switch (scenario) {
    case 'permission':
      return { ...base, status: 'permission-undecided' };
    case 'denied':
      return { ...base, status: 'permission-denied' };
    case 'loading':
      return { ...base, status: 'checking' };
    case 'preview':
      return { ...base, status: 'preview', activePreview: fixturePreview };
    case 'saved':
      return { ...base, status: 'saved', activePreview: fixturePreview };
    case 'error':
      return {
        ...base,
        status: 'write-failed',
        errorMessage: 'Still not saved. No contribution was submitted.',
      };
  }
}

function StatusPanel({
  actionLabel,
  alert = false,
  body,
  onAction,
  onSecondaryAction,
  secondaryActionLabel,
  testID,
  title,
}: {
  actionLabel?: string;
  alert?: boolean;
  body: string;
  onAction?: () => void | Promise<void>;
  onSecondaryAction?: () => void | Promise<void>;
  secondaryActionLabel?: string;
  testID: string;
  title: string;
}) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.statusPanel, alert && styles.alertPanel]}
      testID={testID}
    >
      <Text style={styles.statusTitle}>{title}</Text>
      <Text style={styles.statusBody}>{body}</Text>
      {actionLabel && onAction ? (
        <ActionButton label={actionLabel} onPress={onAction} variant="primary" />
      ) : null}
      {secondaryActionLabel && onSecondaryAction ? (
        <ActionButton label={secondaryActionLabel} onPress={onSecondaryAction} />
      ) : null}
    </View>
  );
}

function PreviewPanel({
  demo,
  metadata,
  onAccept,
  onDiscard,
  onRetake,
  previewUri,
  saved,
  saving,
}: {
  demo: boolean;
  metadata: NonNullable<CaptureState['activePreview']>['metadata'];
  onAccept: () => void | Promise<void>;
  onDiscard: () => void | Promise<void>;
  onRetake: () => void | Promise<void>;
  previewUri: string;
  saved: boolean;
  saving: boolean;
}) {
  const { t } = useI18n();
  if (saved) {
    return (
      <View style={styles.previewArea} testID="camera-preview-panel">
        <View accessibilityLiveRegion="polite" style={styles.statusPanel} testID="camera-saved">
          <Text style={styles.statusTitle}>{t('Saved locally')}</Text>
          <Text style={styles.statusBody}>
            {t('Saved locally. No clip uploaded; allowance unchanged.')}
          </Text>
          <Text style={styles.previewMeta}>
            {metadata.width} × {metadata.height} · {metadata.format.toUpperCase()} ·{' '}
            {t('metadata only')}
          </Text>
          <ActionButton label={t('Take another still')} onPress={onRetake} variant="primary" />
        </View>
      </View>
    );
  }
  return (
    <View style={styles.previewArea} testID="camera-preview-panel">
      {demo ? (
        <View testID="camera-demo-preview">
          <MockMedia
            caption={t('No physical image was captured.')}
            kind="still"
            title={t('Synthetic still fixture')}
          />
        </View>
      ) : (
        <Image
          accessibilityLabel={t('Captured still preview')}
          source={{ uri: previewUri }}
          style={styles.stillPreview}
        />
      )}
      {metadata.source === 'file' ? (
        <Text style={styles.previewMeta}>
          {t('FILE FALLBACK · selected locally, not camera-captured')}
        </Text>
      ) : null}
      <Text style={styles.previewMeta}>
        {metadata.width} × {metadata.height} · {metadata.format.toUpperCase()}
        {demo ? ` · ${t('synthetic')}` : ''}
      </Text>
      <ButtonRow>
        <ActionButton label={t('Retake')} onPress={onRetake} />
        <ActionButton
          busy={saving}
          label={saving ? t('Saving…') : t('Use this still')}
          onPress={onAccept}
          variant="primary"
        />
        <ActionButton label={t('Discard')} onPress={onDiscard} variant="quiet" />
      </ButtonRow>
    </View>
  );
}

const styles = StyleSheet.create({
  demoNotice: {
    backgroundColor: COLORS.deep,
    borderColor: COLORS.edge,
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
    padding: 12,
  },
  demoNoticeTitle: { color: COLORS.edge, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  demoNoticeText: { color: COLORS.muted, fontSize: 12, lineHeight: 18 },
  statusPanel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 9,
    borderWidth: 1,
    gap: 12,
    padding: 17,
  },
  alertPanel: { borderColor: COLORS.accent, borderLeftWidth: 3 },
  statusTitle: { color: COLORS.ink, fontSize: 19, fontWeight: '700' },
  statusBody: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  captureArea: { gap: 14 },
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
    aspectRatio: 3 / 4,
    backgroundColor: COLORS.deep,
    borderRadius: 10,
    maxHeight: 420,
    overflow: 'hidden',
    width: '100%',
  },
  errorText: { color: COLORS.edge, fontSize: 13, textAlign: 'center' },
  previewArea: { gap: 12 },
  stillPreview: {
    aspectRatio: 3 / 4,
    backgroundColor: COLORS.deep,
    borderRadius: 10,
    maxHeight: 420,
    width: '100%',
  },
  previewMeta: { color: COLORS.muted, fontSize: 12, textAlign: 'center' },
});
