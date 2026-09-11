import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CameraView } from 'expo-camera';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { COLORS } from '../theme';
import {
  CaptureFileLifecycleError,
  type CameraPlatform,
  type CaptureFileStore,
  type ImageMetadataStore,
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

export interface CameraCaptureScreenProps {
  platform?: CameraPlatform;
  fileStore?: CaptureFileStore;
  metadataStore?: ImageMetadataStore;
  now?: () => Date;
  createCaptureId?: () => string;
  onAccepted?: (
    metadata: Awaited<ReturnType<StillImageCaptureSession['accept']>>['metadata'],
  ) => void;
}

/**
 * Camera route UI with honest capability/permission states and a local-only
 * still-image preview. It does not know about identity, groups, or reveal.
 */
export function CameraCaptureScreen({
  createCaptureId,
  fileStore,
  metadataStore,
  now,
  onAccepted,
  platform: platformProp,
}: CameraCaptureScreenProps = {}) {
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

  const refreshAccess = useCallback(async () => {
    setSettingsError(null);
    setState((current) => ({ ...current, status: 'checking', errorMessage: null }));
    try {
      const capabilities = await platform.getCapabilities();
      const permissions = await platform.getPermissions();
      setState((current) => ({
        ...current,
        ...accessState(capabilities, permissions),
        activePreview: null,
      }));
      setCameraReady(!platform.supportsLivePreview);
    } catch {
      setState((current) => ({
        ...current,
        status: 'capability-undecided',
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
        status: 'permission-denied',
        errorMessage: 'Camera access could not be requested. Try again or open Settings.',
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

  const capture = useCallback(async () => {
    if (!isCaptureReady(state) || (platform.supportsLivePreview && !cameraReady)) return;
    setState((current) => ({ ...current, status: 'capturing', errorMessage: null }));
    try {
      const activePreview = await session.capture();
      setState((current) => ({
        ...current,
        status: 'preview',
        activePreview: { metadata: activePreview.metadata, uri: activePreview.previewUri },
        errorMessage: null,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        status: error instanceof CaptureFileLifecycleError ? 'write-failed' : 'capture-failed',
        errorMessage:
          error instanceof Error
            ? error.message
            : 'The still image could not be captured. Try again.',
      }));
    }
  }, [cameraReady, platform.supportsLivePreview, session, state]);

  const retryCapture = useCallback(async () => {
    setState((current) => ({ ...current, status: 'ready', errorMessage: null }));
    if (platform.supportsLivePreview && !cameraReady) return;
    setState((current) => ({ ...current, status: 'capturing', errorMessage: null }));
    try {
      const activePreview = await session.capture();
      setState((current) => ({
        ...current,
        status: 'preview',
        activePreview: { metadata: activePreview.metadata, uri: activePreview.previewUri },
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        status: error instanceof CaptureFileLifecycleError ? 'write-failed' : 'capture-failed',
        errorMessage:
          error instanceof Error
            ? error.message
            : 'The still image could not be captured. Try again.',
      }));
    }
  }, [cameraReady, platform.supportsLivePreview, session]);

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

  return (
    <View style={styles.screen} testID="camera-screen">
      <View style={styles.heading}>
        <Text style={styles.eyebrow}>CAPTURE</Text>
        <Text accessibilityRole="header" style={styles.title}>
          Add a still moment
        </Text>
        <Text style={styles.intro}>
          Camera and microphone access stay on this device. Nothing is uploaded from this screen.
        </Text>
      </View>

      {platform.kind === 'demo' ? (
        <View
          accessibilityLabel="Simulator demo capture, not a real camera"
          style={styles.demoNotice}
        >
          <Text style={styles.demoNoticeTitle}>SIMULATOR DEMO</Text>
          <Text style={styles.demoNoticeText}>
            This uses a fixture preview because the simulator has no physical camera. It does not
            claim a real capture.
          </Text>
        </View>
      ) : null}

      {state.status === 'checking' ? (
        <StatusPanel
          testID="camera-checking"
          title="Checking camera access…"
          body="We are checking device capability and both required permissions."
        />
      ) : state.status === 'capability-undecided' ? (
        <StatusPanel
          actionLabel="Check again"
          body={
            state.errorMessage ??
            'Camera availability needs to be checked before capture can begin.'
          }
          onAction={refreshAccess}
          testID="camera-capability-undecided"
          title="Camera availability needs checking"
        />
      ) : state.status === 'unsupported' ? (
        <StatusPanel
          body="This device cannot provide the camera and microphone needed for a still moment. Use a physical device or the explicit simulator demo fixture."
          testID="camera-unsupported"
          title="Camera capture is not supported here"
        />
      ) : state.status === 'permission-undecided' ? (
        <StatusPanel
          actionLabel="Allow camera and microphone"
          body="Rewind needs both permissions before the capture control becomes available."
          onAction={requestAccess}
          testID="camera-permission-undecided"
          title="Allow access to continue"
        />
      ) : state.status === 'permission-denied' ? (
        <StatusPanel
          actionLabel="Try again"
          secondaryActionLabel="Open Settings"
          body={
            state.errorMessage ??
            'Camera or microphone access is off. Try again, or allow both permissions in Settings.'
          }
          onAction={requestAccess}
          onSecondaryAction={openSettings}
          testID="camera-permission-denied"
          title="Camera access is off"
        />
      ) : state.status === 'permission-blocked' ? (
        <StatusPanel
          actionLabel="Open Settings"
          body="Camera or microphone access is blocked. Open Settings, allow both permissions, then return and check again."
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
          testID={state.status === 'write-failed' ? 'camera-write-failed' : 'camera-capture-failed'}
          title={state.status === 'write-failed' ? 'Local save failed' : 'Capture failed'}
        />
      ) : state.activePreview ? (
        <PreviewPanel
          demo={platform.kind === 'demo'}
          metadata={state.activePreview.metadata}
          onAccept={accept}
          onDiscard={discard}
          onRetake={retake}
          previewUri={state.activePreview.uri}
          saving={state.status === 'saving'}
          saved={state.status === 'saved'}
        />
      ) : (
        <View style={styles.captureArea}>
          <View
            accessibilityLabel="Camera and microphone access granted"
            style={styles.accessGranted}
          >
            <Text style={styles.accessGrantedTitle}>ACCESS GRANTED</Text>
            <Text style={styles.accessGrantedText}>
              Camera and microphone are ready for a still moment.
            </Text>
          </View>
          {platform.supportsLivePreview ? (
            <CameraView
              accessibilityLabel="Live camera preview"
              facing="back"
              onCameraReady={() => setCameraReady(true)}
              ref={cameraRef}
              style={styles.livePreview}
              testID="camera-live-preview"
            />
          ) : (
            <View accessibilityLabel="Simulator fixture preview area" style={styles.fixturePreview}>
              <Text style={styles.fixturePreviewText}>READY FOR A FIXTURE PREVIEW</Text>
            </View>
          )}
          <Pressable
            accessibilityHint="Takes one still image and opens a preview"
            accessibilityLabel="Take still image"
            accessibilityRole="button"
            accessibilityState={{ busy: state.status === 'capturing', disabled: !cameraReady }}
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
          {settingsError ? <Text style={styles.errorText}>{settingsError}</Text> : null}
        </View>
      )}
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
      <Text style={styles.previewMeta}>
        {metadata.width} × {metadata.height} · {metadata.format.toUpperCase()}
      </Text>
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
            accessibilityState={{ busy: saving, disabled: saving }}
            disabled={saving}
            onPress={onAccept}
            style={[styles.actionButton, saving && styles.disabledControl]}
          >
            <Text style={styles.actionButtonText}>{saving ? 'Saving…' : 'Use this still'}</Text>
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
  screen: { flex: 1, gap: 18, padding: 24 },
  heading: { gap: 7 },
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
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    justifyContent: 'center',
    minHeight: 52,
    padding: 14,
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
