import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CameraView } from 'expo-camera';
import { AppState, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { RuntimeClient } from '../runtime/local-runtime-client';
import { useOptionalDemoSession } from '../session/DemoSessionProvider';
import { COLORS } from '../theme';
import type { CaptureMode, ClipUploadInput, RecordedClip } from '../domain/video';
import { ClipUploadSession, type ClipUploadProgress } from './clip-uploader';
import { BoundedVideoRecordingSession, type VideoRecordingPlatform } from './video-recording';
import { ClipReviewSession, InMemoryPendingClipMetadataStore } from './video-review';
import { ExpoCameraPlatform, removeManagedRecordedClip } from './platform';
import type { CameraPlatform } from './contracts';

type AccessStatus =
  'checking' | 'ready' | 'unsupported' | 'permission' | 'permission-blocked' | 'error';

export interface VideoCaptureScreenProps {
  platform?: CameraPlatform;
  runtimeClient?: RuntimeClient | null;
  onBack?: () => void;
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

export function VideoCaptureScreen({
  onBack,
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
  const activeUploadRef = useRef(false);
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

  const isCaptureActive = useCallback(() => mountedRef.current && !captureLeftRef.current, []);
  const cancelActiveWork = useCallback((): Promise<void> => {
    if (captureLeftRef.current) return Promise.resolve();
    captureLeftRef.current = true;
    recorderRef.current?.cancel();
    if (activeUploadRef.current) {
      const cancellation = uploadSessionRef.current?.cancel();
      return cancellation?.catch(() => undefined) ?? Promise.resolve();
    }
    return Promise.resolve();
  }, []);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      void cancelActiveWork().finally(() => {
        const sourceUri = clipRef.current?.sourceUri;
        if (sourceUri) void removeManagedRecordedClip(sourceUri).catch(() => undefined);
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
      if (capabilities.camera !== 'supported' || capabilities.microphone !== 'supported') {
        setAccess('unsupported');
      } else if (permissions.camera === 'blocked' || permissions.microphone === 'blocked') {
        setAccess('permission-blocked');
      } else if (permissions.camera !== 'granted' || permissions.microphone !== 'granted') {
        setAccess('permission');
      } else {
        setAccess('ready');
      }
    } catch {
      if (!isCaptureActive()) return;
      setAccess('error');
      setError('We could not check recording access. Try again.');
    }
  }, [isCaptureActive, platform, recorder]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);

  // Native Settings does not tell the route when the user changes a
  // permission. Re-check when the app becomes active again so a blocked
  // screen can transition directly to the live preview after returning.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const requestAccess = useCallback(async () => {
    if (!isCaptureActive()) return;
    setError(null);
    try {
      await platform.requestPermissions();
      if (isCaptureActive()) await refresh();
    } catch {
      if (!isCaptureActive()) return;
      setError('Camera access could not be requested. Open Settings and try again.');
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
      if (!isCaptureActive()) return;
      const nextReview = new ClipReviewSession(recorded, reviewStore);
      setClip(recorded);
      setReview(nextReview);
      setStartText('0');
      setEndText(String(recorded.durationSeconds));
      setMode('soft-focus');
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
      if (currentClip) await removeManagedRecordedClip(currentClip.sourceUri);
    } catch {
      setError('The clip could not be removed from local storage. Try again.');
      return;
    }
    recorder?.reset();
    setClip(null);
    setReview(null);
    setUploadProgress({ status: 'idle', percent: 0 });
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

  const upload = async () => {
    if (!isCaptureActive()) return;
    if (!review || !clip || !uploadSession) {
      setError('Connect the local runtime and an active Demo session before uploading.');
      return;
    }
    const input: ClipUploadInput = {
      byteLength: clip.byteLength ?? 0,
      durationSeconds: review.getReview().endSeconds - review.getReview().startSeconds,
      hasAudio: true,
      height: clip.height,
      idempotencyKey: `clip-${Date.now()}`,
      mimeType: 'video/mp4',
      sourceUri: clip.sourceUri,
      width: clip.width,
    };
    try {
      activeUploadRef.current = true;
      await review.savePending(input.idempotencyKey);
      if (!isCaptureActive()) return;
      await uploadSession.upload(input, (progress) => {
        if (isCaptureActive() && activeUploadRef.current) setUploadProgress(progress);
      });
      try {
        await removeManagedRecordedClip(clip.sourceUri);
      } catch {
        setError('The queued clip is ready, but its local cache file could not be removed.');
      }
    } catch (uploadError) {
      if (!isCaptureActive()) return;
      setError(
        uploadError instanceof Error ? uploadError.message : 'The clip could not be uploaded.',
      );
    } finally {
      activeUploadRef.current = false;
    }
  };

  const retryUpload = async () => {
    if (!isCaptureActive()) return;
    try {
      activeUploadRef.current = true;
      await uploadSession?.retry((progress) => {
        if (isCaptureActive() && activeUploadRef.current) setUploadProgress(progress);
      });
    } catch (uploadError) {
      if (!isCaptureActive()) return;
      setError(
        uploadError instanceof Error ? uploadError.message : 'The clip could not be uploaded.',
      );
    } finally {
      activeUploadRef.current = false;
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
      const message =
        cancelError instanceof Error && cancelError.message ? cancelError.message : 'Try again.';
      setUploadProgress({ status: 'failed', percent: 10, message });
      setError(`The upload could not be cancelled. ${message}`);
    }
  }, [isCaptureActive, uploadProgress.status, uploadSession]);

  const leaveCapture = useCallback(() => {
    const currentClip = clipRef.current;
    void cancelActiveWork().finally(() => {
      if (currentClip) void removeManagedRecordedClip(currentClip.sourceUri).catch(() => undefined);
    });
    onBack?.();
  }, [cancelActiveWork, onBack]);

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
          testID="video-unsupported"
          title="Recording is not supported here"
          body="Use a physical device with camera and microphone access. The simulator fixture does not claim to record a real clip."
        />
      ) : null}
      {access === 'permission' ? (
        <Panel
          actionLabel="Allow camera and microphone"
          onAction={requestAccess}
          testID="video-permission"
          title="Allow access to record"
          body="Both camera and microphone permissions are required before recording."
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
            Recorded {clip.durationSeconds.toFixed(1)} seconds · portrait · audio included
          </Text>
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
          {uploadProgress.status === 'complete' ? (
            <Text style={styles.success}>Upload queued as one pending contribution.</Text>
          ) : (
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
          {uploadProgress.status === 'failed' ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void retryUpload()}
              style={styles.outlineButton}
            >
              <Text style={styles.outlineText}>Retry upload</Text>
            </Pressable>
          ) : null}
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
  onAction,
  testID,
  title,
}: {
  actionLabel?: string;
  body: string;
  onAction?: () => void | Promise<void>;
  testID?: string;
  title: string;
}) {
  return (
    <View style={styles.panel} testID={testID}>
      <Text style={styles.panelTitle}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
      {actionLabel && onAction ? (
        <Pressable accessibilityRole="button" onPress={onAction} style={styles.outlineButton}>
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
