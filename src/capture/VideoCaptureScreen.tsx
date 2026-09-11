import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CameraView } from 'expo-camera';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { RuntimeClient } from '../runtime/local-runtime-client';
import { useOptionalDemoSession } from '../session/DemoSessionProvider';
import { COLORS } from '../theme';
import type { CaptureMode, ClipUploadInput, RecordedClip } from '../domain/video';
import { ClipUploadSession, type ClipUploadProgress } from './clip-uploader';
import { BoundedVideoRecordingSession, type VideoRecordingPlatform } from './video-recording';
import { ClipReviewSession, InMemoryPendingClipMetadataStore } from './video-review';
import { ExpoCameraPlatform } from './platform';
import type { CameraPlatform } from './contracts';

type AccessStatus = 'checking' | 'ready' | 'unsupported' | 'permission' | 'error';

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

  const refresh = useCallback(async () => {
    setAccess('checking');
    setError(null);
    if (platform.kind === 'demo' || !recorder) {
      setAccess('unsupported');
      return;
    }
    try {
      const [capabilities, permissions] = await Promise.all([
        platform.getCapabilities(),
        platform.getPermissions(),
      ]);
      if (capabilities.camera !== 'supported' || capabilities.microphone !== 'supported') {
        setAccess('unsupported');
      } else if (permissions.camera !== 'granted' || permissions.microphone !== 'granted') {
        setAccess('permission');
      } else {
        setAccess('ready');
      }
    } catch {
      setAccess('error');
      setError('We could not check recording access. Try again.');
    }
  }, [platform, recorder]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);

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
    if (!recorder || access !== 'ready') return;
    setError(null);
    setRecording(true);
    setRecordingStartedAt(Date.now());
    setElapsedSeconds(0);
    try {
      const recorded = await recorder.start();
      const nextReview = new ClipReviewSession(recorded, reviewStore);
      setClip(recorded);
      setReview(nextReview);
      setStartText('0');
      setEndText(String(recorded.durationSeconds));
      setMode('soft-focus');
      setRecording(false);
      setRecordingStartedAt(null);
    } catch (recordingError) {
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
    await review?.retake();
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
      await review.savePending(input.idempotencyKey);
      await uploadSession.upload(input, setUploadProgress);
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : 'The clip could not be uploaded.',
      );
    }
  };

  const retryUpload = async () => {
    try {
      await uploadSession?.retry(setUploadProgress);
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : 'The clip could not be uploaded.',
      );
    }
  };

  return (
    <View style={styles.screen} testID="video-capture-screen">
      <View style={styles.header}>
        {onBack ? (
          <Pressable accessibilityRole="button" onPress={onBack} style={styles.backButton}>
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
          onAction={async () => {
            try {
              await platform.requestPermissions();
              await refresh();
            } catch {
              setError('Camera access could not be requested. Open Settings and try again.');
            }
          }}
          testID="video-permission"
          title="Allow access to record"
          body="Both camera and microphone permissions are required before recording."
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
              onPress={() => void uploadSession?.cancel()}
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
