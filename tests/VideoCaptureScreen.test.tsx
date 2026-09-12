import React, { useState } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, View } from 'react-native';
import { ClipUploadSession } from '../src/capture/clip-uploader';

import { DemoSessionProvider, useOptionalDemoSession } from '../src/session/DemoSessionProvider';
import { VideoCaptureScreen } from '../src/capture/VideoCaptureScreen';
import type { DemoSession, DemoSessionStore } from '../src/domain/session';
import type { PendingClipUpload, RecordedClip } from '../src/domain/video';
import type { CameraPlatform, PermissionSnapshot } from '../src/capture/contracts';
import type { VideoRecordingPlatform } from '../src/capture/video-recording';
import type { RuntimeClient } from '../src/runtime/local-runtime-client';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('expo-camera', () => {
  // Jest module factories run outside the ES module scope.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  const CameraView = ReactModule.forwardRef((props: Record<string, unknown>, _ref: unknown) => (
    <View {...props} />
  ));
  return { CameraView };
});

beforeEach(async () => {
  await AsyncStorage.clear();
});

const clip: RecordedClip = {
  byteLength: 2048,
  durationSeconds: 8,
  format: 'mp4',
  hasAudio: true,
  height: 1280,
  source: 'camera',
  sourceUri: 'file://clip.mp4',
  width: 720,
};

type TestVideoPlatform = CameraPlatform & VideoRecordingPlatform;

function videoPlatform(permissions: PermissionSnapshot): TestVideoPlatform {
  return {
    cancelRecording: jest.fn(),
    captureStill: jest.fn(),
    getCapabilities: jest.fn().mockResolvedValue({ camera: 'supported', microphone: 'supported' }),
    getPermissions: jest.fn().mockResolvedValue(permissions),
    kind: 'expo',
    openSettings: jest.fn().mockResolvedValue(undefined),
    recordClip: jest.fn().mockResolvedValue(clip),
    requestPermissions: jest.fn().mockResolvedValue(permissions),
    stopRecording: jest.fn(),
    supportsLivePreview: true,
  };
}

const demoSession: DemoSession = {
  accessKind: 'demo',
  actor: { displayName: 'Amber', isSynthetic: true, memberId: 'demo-1' },
  expiresAt: '2026-09-12T00:00:00.000Z',
  groupId: 'demo-group',
  id: 'demo-session-ui',
  invalidatedAt: null,
  startedAt: '2026-09-11T00:00:00.000Z',
};

const upload = {
  contribution: {
    createdAt: '2026-09-11T00:00:00.000Z',
    cycleId: 'cycle-ui',
    durationSeconds: 8,
    groupId: 'demo-group',
    id: 'contribution-ui',
    memberId: 'demo-1',
  },
  existing: false,
  job: {
    contributionId: 'contribution-ui',
    createdAt: '2026-09-11T00:00:00.000Z',
    groupId: 'demo-group',
    id: 'job-ui',
    kind: 'clip' as const,
    status: 'pending' as const,
  },
} satisfies PendingClipUpload;

function demoSessionStore(): DemoSessionStore {
  return {
    clear: jest.fn().mockResolvedValue(undefined),
    load: jest.fn().mockResolvedValue(demoSession),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

function runtimeClient(overrides: Partial<RuntimeClient> = {}): RuntimeClient {
  return {
    baseUrl: 'http://runtime.test',
    cancelClipUpload: jest.fn().mockResolvedValue(undefined),
    uploadClip: jest.fn().mockResolvedValue(upload),
    ...overrides,
  } as unknown as RuntimeClient;
}

function SessionReadyMarker() {
  const session = useOptionalDemoSession()?.session;
  return session ? <View testID="demo-session-ready" /> : null;
}

async function renderReview(videoPlatform: TestVideoPlatform = videoPlatformForReview()) {
  const result = await render(<VideoCaptureScreen platform={videoPlatform} />);
  await result.findByTestId('video-live-preview');
  await fireEvent.press(result.getByTestId('video-record'));
  await result.findByTestId('video-review');
  return result;
}

function videoPlatformForReview(): TestVideoPlatform {
  return videoPlatform({ camera: 'granted', microphone: 'granted' });
}

async function renderReviewWithRuntime(videoPlatform: TestVideoPlatform, client: RuntimeClient) {
  const result = await render(
    <DemoSessionProvider runtimeClient={client} store={demoSessionStore()}>
      <SessionReadyMarker />
      <VideoCaptureScreen platform={videoPlatform} runtimeClient={client} />
    </DemoSessionProvider>,
  );
  await result.findByTestId('demo-session-ready');
  await result.findByTestId('video-live-preview');
  await fireEvent.press(result.getByTestId('video-record'));
  await result.findByTestId('video-review');
  return result;
}

describe('VideoCaptureScreen', () => {
  it('offers Open Settings for permanently blocked camera or microphone access', async () => {
    const platform = videoPlatform({ camera: 'blocked', microphone: 'granted' });
    const result = await render(<VideoCaptureScreen platform={platform} />);

    await waitFor(() => expect(result.getByTestId('video-permission-blocked')).toBeTruthy());
    expect(result.getByText('Permission is blocked')).toBeTruthy();
    expect(result.queryByTestId('video-record')).toBeNull();

    await fireEvent.press(result.getByRole('button', { name: 'Open Settings' }));
    expect(platform.openSettings).toHaveBeenCalledTimes(1);
  });

  it('cancels recording before leaving and ignores a late platform completion', async () => {
    const platform = videoPlatform({ camera: 'granted', microphone: 'granted' });
    let resolveRecording!: (value: RecordedClip) => void;
    (platform.recordClip as jest.Mock).mockImplementation(
      () => new Promise<RecordedClip>((resolve) => (resolveRecording = resolve)),
    );

    function Harness() {
      const [visible, setVisible] = useState(true);
      return visible ? (
        <VideoCaptureScreen platform={platform} onBack={() => setVisible(false)} />
      ) : null;
    }

    const result = await render(<Harness />);
    await waitFor(() => expect(result.getByTestId('video-record')).toBeTruthy());
    await fireEvent.press(result.getByTestId('video-record'));
    await waitFor(() => expect(result.getByTestId('video-recording')).toBeTruthy());

    await fireEvent.press(result.getByRole('button', { name: 'Back to stills' }));
    expect(platform.cancelRecording).toHaveBeenCalledTimes(1);
    expect(result.queryByTestId('video-capture-screen')).toBeNull();

    resolveRecording(clip);
    await waitFor(() => expect(result.queryByTestId('video-review')).toBeNull());
  });

  it('keeps recording unavailable until both permissions are granted', async () => {
    const permissions = { camera: 'undetermined' as const, microphone: 'undetermined' as const };
    const platform = videoPlatform(permissions);
    (platform.getPermissions as jest.Mock)
      .mockResolvedValueOnce(permissions)
      .mockResolvedValue({ camera: 'granted', microphone: 'granted' });
    (platform.requestPermissions as jest.Mock).mockResolvedValue({
      camera: 'granted',
      microphone: 'granted',
    });
    const result = await render(<VideoCaptureScreen platform={platform} />);

    await result.findByTestId('video-permission');
    expect(result.queryByTestId('video-record')).toBeNull();
    await fireEvent.press(result.getByRole('button', { name: 'Allow camera and microphone' }));

    await result.findByTestId('video-live-preview');
    expect(result.getByTestId('video-record')).toBeEnabled();
    expect(platform.requestPermissions).toHaveBeenCalledTimes(1);
  });

  it('shows recording progress and transitions to clip review after stopping', async () => {
    const platform = videoPlatformForReview();
    let resolveRecording!: (value: RecordedClip) => void;
    (platform.recordClip as jest.Mock).mockImplementation(
      () => new Promise<RecordedClip>((resolve) => (resolveRecording = resolve)),
    );
    const result = await render(<VideoCaptureScreen platform={platform} />);
    await result.findByTestId('video-live-preview');

    await fireEvent.press(result.getByTestId('video-record'));
    await result.findByTestId('video-recording');
    expect(result.getByText(/0 \/ 15 seconds/)).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Stop and review' }));
    expect(platform.stopRecording).toHaveBeenCalledTimes(1);
    resolveRecording(clip);

    await result.findByTestId('video-review');
    expect(result.getByText('Recorded 8.0 seconds · portrait · audio included')).toBeTruthy();
    expect(platform.recordClip).toHaveBeenCalledWith(15);
  });

  it('keeps trim errors actionable for bounds outside the clip and clips that are too short', async () => {
    const outside = await renderReview();
    await fireEvent.changeText(outside.getByDisplayValue('0'), '4');
    await fireEvent.changeText(outside.getByDisplayValue('8'), '9');
    await fireEvent.press(outside.getByRole('button', { name: 'Save trim and mode' }));
    expect(await outside.findByText('Choose trim bounds inside the recorded clip.')).toBeTruthy();

    const tooShort = await renderReview();
    await fireEvent.changeText(tooShort.getByDisplayValue('8'), '0.25');
    await fireEvent.press(tooShort.getByRole('button', { name: 'Save trim and mode' }));
    expect(await tooShort.findByText('Keep at least half a second in the clip.')).toBeTruthy();
  });

  it('surfaces an upload failure and retries the same review successfully', async () => {
    const uploadClip = jest
      .fn()
      .mockRejectedValueOnce(new Error('runtime temporarily unavailable'))
      .mockResolvedValueOnce(upload);
    const client = runtimeClient({ uploadClip });
    const result = await renderReviewWithRuntime(videoPlatformForReview(), client);

    await fireEvent.press(result.getByRole('button', { name: 'Upload clip' }));
    await result.findByText('runtime temporarily unavailable');
    expect(result.getByRole('button', { name: 'Retry upload' })).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Retry upload' }));

    await result.findByText('Upload queued as one pending contribution.');
    expect(uploadClip).toHaveBeenCalledTimes(2);
  });

  it('cancels a queued server job before retaking an uploaded clip', async () => {
    const cancelClipUpload = jest.fn().mockResolvedValue(undefined);
    const client = runtimeClient({ cancelClipUpload });
    const result = await renderReviewWithRuntime(videoPlatformForReview(), client);

    await fireEvent.press(result.getByRole('button', { name: 'Upload clip' }));
    await result.findByText('Upload queued as one pending contribution.');
    await fireEvent.press(result.getByRole('button', { name: 'Retake' }));

    await result.findByTestId('video-live-preview');
    expect(cancelClipUpload).toHaveBeenCalledWith('demo-session-ui', 'demo-group', 'job-ui');
  });

  it('cancels an active recording and ignores a late recorder completion', async () => {
    const platform = videoPlatformForReview();
    let resolveRecording!: (value: RecordedClip) => void;
    (platform.recordClip as jest.Mock).mockImplementation(
      () => new Promise<RecordedClip>((resolve) => (resolveRecording = resolve)),
    );
    const result = await render(<VideoCaptureScreen platform={platform} />);
    await result.findByTestId('video-live-preview');
    await fireEvent.press(result.getByTestId('video-record'));
    await result.findByTestId('video-recording');

    await fireEvent.press(result.getByRole('button', { name: 'Cancel recording' }));
    expect(platform.cancelRecording).toHaveBeenCalledTimes(1);
    expect(result.queryByTestId('video-review')).toBeNull();
    expect(result.getByTestId('video-record')).toBeTruthy();
    resolveRecording(clip);
    await waitFor(() => expect(result.queryByTestId('video-review')).toBeNull());
    expect(result.queryByRole('alert')).toBeNull();
  });

  it('cancels an in-flight upload and returns to the retryable review state', async () => {
    let resolveUpload!: (value: PendingClipUpload) => void;
    const uploadClip = jest.fn(
      () => new Promise<PendingClipUpload>((resolve) => (resolveUpload = resolve)),
    );
    const client = runtimeClient({ uploadClip });
    const result = await renderReviewWithRuntime(videoPlatformForReview(), client);

    await fireEvent.press(result.getByRole('button', { name: 'Upload clip' }));
    await result.findByRole('button', { name: 'Cancel upload' });
    await fireEvent.press(result.getByRole('button', { name: 'Cancel upload' }));
    resolveUpload(upload);
    await waitFor(() => expect(result.getByRole('button', { name: 'Upload clip' })).toBeTruthy());
    expect(result.queryByText('Upload queued as one pending contribution.')).toBeNull();
    await result.findByText('The upload was cancelled.');
  });

  it('leaves the uploading state immediately when the upload transport never settles', async () => {
    const uploadClip = jest.fn(() => new Promise<PendingClipUpload>(() => undefined));
    const result = await renderReviewWithRuntime(
      videoPlatformForReview(),
      runtimeClient({ uploadClip }),
    );

    await fireEvent.press(result.getByRole('button', { name: 'Upload clip' }));
    await result.findByRole('button', { name: 'Cancel upload' });
    await fireEvent.press(result.getByRole('button', { name: 'Cancel upload' }));

    await result.findByRole('button', { name: 'Upload clip' });
    expect(result.queryByRole('button', { name: 'Cancel upload' })).toBeNull();
  });

  it('reports a cancellation failure without leaving an uploading state', async () => {
    const cancel = jest
      .spyOn(ClipUploadSession.prototype, 'cancel')
      .mockRejectedValue(new Error('runtime unavailable'));
    const uploadClip = jest.fn(() => new Promise<PendingClipUpload>(() => undefined));
    const result = await renderReviewWithRuntime(
      videoPlatformForReview(),
      runtimeClient({ uploadClip }),
    );

    await fireEvent.press(result.getByRole('button', { name: 'Upload clip' }));
    await result.findByRole('button', { name: 'Cancel upload' });
    await fireEvent.press(result.getByRole('button', { name: 'Cancel upload' }));

    await result.findByText('The upload could not be cancelled. runtime unavailable');
    expect(result.getByRole('button', { name: 'Retry upload' })).toBeTruthy();
    expect(result.queryByRole('button', { name: 'Cancel upload' })).toBeNull();
    cancel.mockRestore();
  });

  it('refreshes permissions when the app becomes active after returning from Settings', async () => {
    const blocked = { camera: 'blocked' as const, microphone: 'granted' as const };
    const granted = { camera: 'granted' as const, microphone: 'granted' as const };
    const platform = videoPlatform(blocked);
    const getPermissions = jest.fn().mockResolvedValueOnce(blocked).mockResolvedValue(granted);
    platform.getPermissions = getPermissions;
    let onAppStateChange!: Parameters<typeof AppState.addEventListener>[1];
    const subscription = { remove: jest.fn() };
    const addEventListener = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_eventName, listener) => {
        onAppStateChange = listener;
        return subscription;
      });
    const result = await render(<VideoCaptureScreen platform={platform} />);

    await result.findByTestId('video-permission-blocked');
    await act(async () => {
      onAppStateChange('active');
    });
    await result.findByTestId('video-live-preview');
    expect(getPermissions).toHaveBeenCalledTimes(2);

    await result.unmount();
    expect(subscription.remove).toHaveBeenCalledTimes(1);
    addEventListener.mockRestore();
  });
});
