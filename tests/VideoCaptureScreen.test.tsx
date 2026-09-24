import React, { useState } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, View } from 'react-native';
import { ClipUploadSession } from '../src/capture/clip-uploader';

import { DemoSessionProvider, useOptionalDemoSession } from '../src/session/DemoSessionProvider';
import { VideoCaptureScreen } from '../src/capture/VideoCaptureScreen';
import { DemoCameraPlatform } from '../src/capture/platform';
import type { DemoSession, DemoSessionStore } from '../src/domain/session';
import type { PendingClipUpload, RecordedClip } from '../src/domain/video';
import type { CameraPlatform, PermissionSnapshot } from '../src/capture/contracts';
import type { VideoRecordingPlatform } from '../src/capture/video-recording';
import { LocalRuntimeError } from '../src/runtime/local-runtime-client';
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
  mimeType: 'video/mp4',
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

function fileFallbackPlatform(
  permissions: PermissionSnapshot = { camera: 'granted', microphone: 'granted' },
): TestVideoPlatform {
  return {
    ...videoPlatform(permissions),
    getCapabilities: jest
      .fn()
      .mockResolvedValue({ camera: 'unsupported', microphone: 'unsupported' }),
    pickVideoFile: jest.fn().mockResolvedValue({ ...clip, source: 'file' as const }),
    supportsFileFallback: true,
    supportsVideoRecording: false,
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
    <DemoSessionProvider
      clock={() => new Date('2026-09-11T12:00:00.000Z')}
      runtimeClient={client}
      store={demoSessionStore()}
    >
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
  it('distinguishes denied access from a temporary capability outage', async () => {
    const denied = await render(
      <VideoCaptureScreen platform={videoPlatform({ camera: 'denied', microphone: 'granted' })} />,
    );
    await denied.findByTestId('video-permission-denied');
    expect(denied.queryByTestId('video-record')).toBeNull();

    const temporary = videoPlatform({ camera: 'granted', microphone: 'granted' });
    (temporary.getCapabilities as jest.Mock).mockResolvedValue({
      camera: 'undecided',
      microphone: 'supported',
    });
    const temporaryResult = await render(<VideoCaptureScreen platform={temporary} />);
    await temporaryResult.findByTestId('video-temporarily-unavailable');
    expect(temporaryResult.queryByTestId('video-record')).toBeNull();
  });

  it('offers a labelled video file fallback without exposing unsupported recording', async () => {
    const platform = fileFallbackPlatform();
    const result = await render(<VideoCaptureScreen platform={platform} />);

    await result.findByTestId('video-unsupported');
    expect(result.queryByTestId('video-record')).toBeNull();
    await fireEvent.press(result.getByRole('button', { name: 'Choose a video file' }));
    await result.findByTestId('video-review');
    expect(platform.pickVideoFile).toHaveBeenCalledTimes(1);
    expect(result.getByText(/FILE FALLBACK · selected locally/)).toBeTruthy();
    expect(
      result.getByText(
        /Selected MP4 8.0 seconds · 720 × 1280 portrait · audio track detected; server verifies/,
      ),
    ).toBeTruthy();
  });

  it('releases the previous browser video on replacement and the current one on unmount', async () => {
    const previousRevoke = URL.revokeObjectURL;
    const revokeObjectURL = jest.fn();
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const platform = fileFallbackPlatform();
    (platform.pickVideoFile as jest.Mock)
      .mockResolvedValueOnce({ ...clip, source: 'file', sourceUri: 'blob:selected-one' })
      .mockResolvedValueOnce({ ...clip, source: 'file', sourceUri: 'blob:selected-two' });

    try {
      const result = await render(<VideoCaptureScreen platform={platform} />);
      await result.findByTestId('video-unsupported');
      await fireEvent.press(result.getByRole('button', { name: 'Choose a video file' }));
      await result.findByTestId('video-review');
      await fireEvent.press(result.getByRole('button', { name: 'Choose a video file' }));
      await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:selected-one'));
      expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:selected-two');

      await result.unmount();
      await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:selected-two'));
      expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: previousRevoke,
      });
    }
  });

  it('releases a selected browser video when defensive validation fails', async () => {
    const previousRevoke = URL.revokeObjectURL;
    const revokeObjectURL = jest.fn();
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const platform = fileFallbackPlatform();
    (platform.pickVideoFile as jest.Mock).mockResolvedValue({
      ...clip,
      hasAudio: false,
      source: 'file',
      sourceUri: 'blob:invalid-selected-video',
    });

    try {
      const result = await render(<VideoCaptureScreen platform={platform} />);
      await result.findByTestId('video-unsupported');
      await fireEvent.press(result.getByRole('button', { name: 'Choose a video file' }));
      await result.findByText('Microphone audio is required for a clip.');
      expect(result.queryByTestId('video-review')).toBeNull();
      expect(revokeObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:invalid-selected-video');
    } finally {
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: previousRevoke,
      });
    }
  });

  it('retains a failed file for retry, then releases it when the route unmounts', async () => {
    const previousRevoke = URL.revokeObjectURL;
    const revokeObjectURL = jest.fn();
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const platform = fileFallbackPlatform();
    (platform.pickVideoFile as jest.Mock).mockResolvedValue({
      ...clip,
      source: 'file',
      sourceUri: 'blob:failed-upload-video',
    });
    const client = runtimeClient({
      uploadClip: jest.fn().mockRejectedValue(new Error('runtime temporarily unavailable')),
    });

    try {
      const result = await render(
        <DemoSessionProvider
          clock={() => new Date('2026-09-11T12:00:00.000Z')}
          runtimeClient={client}
          store={demoSessionStore()}
        >
          <SessionReadyMarker />
          <VideoCaptureScreen platform={platform} runtimeClient={client} />
        </DemoSessionProvider>,
      );
      await result.findByTestId('demo-session-ready');
      await result.findByTestId('video-unsupported');
      await fireEvent.press(result.getByRole('button', { name: 'Choose a video file' }));
      await result.findByTestId('video-review');
      await fireEvent.press(result.getByRole('button', { name: 'Upload clip' }));
      await result.findByText('runtime temporarily unavailable');
      expect(revokeObjectURL).not.toHaveBeenCalled();

      await result.unmount();
      await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:failed-upload-video'));
      expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: previousRevoke,
      });
    }
  });

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

  it('offers an authenticated fresh synthetic clip only in the local Demo fixture', async () => {
    const createSyntheticDemoClip = jest.fn().mockResolvedValue(upload);
    const processClipJob = jest.fn().mockResolvedValue({ ...upload.job, status: 'ready' as const });
    const client = runtimeClient({ createSyntheticDemoClip, processClipJob });
    const result = await render(
      <DemoSessionProvider
        clock={() => new Date('2026-09-11T12:00:00.000Z')}
        runtimeClient={client}
        store={demoSessionStore()}
      >
        <SessionReadyMarker />
        <VideoCaptureScreen platform={new DemoCameraPlatform()} runtimeClient={client} />
      </DemoSessionProvider>,
    );

    await result.findByTestId('demo-session-ready');
    await result.findByTestId('video-unsupported');
    expect(result.getByText(/fresh, non-sensitive synthetic clip/)).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Create synthetic Demo clip' }));

    await result.findByTestId('camera-contribution-status-sealed');
    expect(createSyntheticDemoClip).toHaveBeenCalledWith('demo-session-ui', 'demo-group');
    expect(processClipJob).toHaveBeenCalledWith('demo-session-ui', 'demo-group', 'job-ui');
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
    expect(
      result.getByText('Recorded 8.0 seconds · 720 × 1280 portrait · audio included'),
    ).toBeTruthy();
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

  it('forwards trim and mode metadata and invokes server processing before local cleanup', async () => {
    const processClipJob = jest.fn().mockResolvedValue({
      contributionId: 'contribution-ui',
      createdAt: '2026-09-11T00:00:00.000Z',
      groupId: 'demo-group',
      id: 'job-ui',
      kind: 'clip',
      status: 'ready',
    });
    const uploadClip = jest.fn().mockResolvedValue(upload);
    const result = await renderReviewWithRuntime(
      videoPlatformForReview(),
      runtimeClient({ uploadClip, processClipJob }),
    );
    await fireEvent.changeText(result.getByDisplayValue('0'), '1');
    await fireEvent.changeText(result.getByDisplayValue('8'), '5');
    await fireEvent.press(result.getByRole('radio', { name: 'High Contrast' }));
    await fireEvent.press(result.getByRole('button', { name: 'Save trim and mode' }));
    await fireEvent.press(result.getByRole('button', { name: 'Upload clip' }));
    await result.findByText('Upload queued as one pending contribution.');
    expect(uploadClip).toHaveBeenCalledWith(
      'demo-session-ui',
      'demo-group',
      expect.objectContaining({
        durationSeconds: 4,
        hasAudio: true,
        height: 1280,
        mimeType: 'video/mp4',
        mode: 'high-contrast',
        sourceDurationSeconds: 8,
        trimEndSeconds: 5,
        trimStartSeconds: 1,
        width: 720,
      }),
    );
    expect(processClipJob).toHaveBeenCalledWith('demo-session-ui', 'demo-group', 'job-ui');
  });

  it('carries the selected contribution ID through delete and its replacement upload', async () => {
    const replacementUpload = {
      ...upload,
      contribution: { ...upload.contribution, id: 'contribution-replacement-ui' },
      job: {
        ...upload.job,
        contributionId: 'contribution-replacement-ui',
        id: 'job-replacement-ui',
      },
    };
    const processClipJob = jest
      .fn()
      .mockResolvedValueOnce({ ...upload.job, status: 'ready' as const })
      .mockResolvedValueOnce({ ...replacementUpload.job, status: 'ready' as const });
    const uploadClip = jest
      .fn()
      .mockResolvedValueOnce(upload)
      .mockResolvedValueOnce(replacementUpload);
    const deleteContribution = jest.fn().mockResolvedValue({
      contributionId: upload.contribution.id,
      jobId: upload.job.id,
      restored: { count: 1 as const, seconds: 8 },
    });
    const platform = videoPlatformForReview();
    (platform.recordClip as jest.Mock)
      .mockResolvedValueOnce(clip)
      .mockResolvedValueOnce({ ...clip, sourceUri: 'file://replacement-clip.mp4' });
    const result = await renderReviewWithRuntime(
      platform,
      runtimeClient({ processClipJob, uploadClip, deleteContribution }),
    );

    await fireEvent.press(result.getByRole('button', { name: 'Upload clip' }));
    await result.findByTestId('camera-contribution-status-sealed');
    await fireEvent.press(result.getByRole('button', { name: 'Delete and replace' }));

    expect(deleteContribution).toHaveBeenCalledWith(
      'demo-session-ui',
      'demo-group',
      'contribution-ui',
    );
    await result.findByTestId('video-live-preview');
    expect(result.queryByTestId('camera-contribution-status-sealed')).toBeNull();
    expect(
      result.getByText(
        'Contribution deleted. Your weekly allowance is restored for a replacement.',
      ),
    ).toBeTruthy();

    await fireEvent.press(result.getByTestId('video-record'));
    await result.findByTestId('video-review');
    await fireEvent.press(result.getByRole('button', { name: 'Upload clip' }));
    await result.findByTestId('camera-contribution-status-sealed');
    expect(uploadClip).toHaveBeenNthCalledWith(
      2,
      'demo-session-ui',
      'demo-group',
      expect.objectContaining({ replacesContributionId: 'contribution-ui' }),
    );
  });

  it('persists a used delete allowance in the status and removes the action', async () => {
    const deleteContribution = jest
      .fn()
      .mockRejectedValue(
        new LocalRuntimeError(
          'The weekly delete-and-replace allowance has already been used.',
          409,
          'contribution_deletion_used',
        ),
      );
    const processClipJob = jest.fn().mockResolvedValue({ ...upload.job, status: 'ready' as const });
    const result = await renderReviewWithRuntime(
      videoPlatformForReview(),
      runtimeClient({ deleteContribution, processClipJob }),
    );

    await fireEvent.press(result.getByRole('button', { name: 'Upload clip' }));
    await result.findByTestId('camera-contribution-status-sealed');
    await fireEvent.press(result.getByRole('button', { name: 'Delete and replace' }));
    await result.findByTestId('camera-contribution-status-delete-used');
    expect(result.queryByRole('button', { name: 'Delete and replace' })).toBeNull();
  });

  it('renders a returned processing failure as retryable contribution state after upload completes', async () => {
    const processClipJob = jest
      .fn()
      .mockResolvedValueOnce({ ...upload.job, status: 'failed' as const })
      .mockResolvedValueOnce({ ...upload.job, status: 'ready' as const });
    const uploadClip = jest.fn().mockResolvedValue(upload);
    const result = await renderReviewWithRuntime(
      videoPlatformForReview(),
      runtimeClient({ uploadClip, processClipJob }),
    );

    await fireEvent.press(result.getByRole('button', { name: 'Upload clip' }));
    await result.findByTestId('camera-contribution-status-failed');
    expect(result.queryByText('Upload queued as one pending contribution.')).toBeNull();
    expect(result.getByRole('button', { name: 'Retry upload' })).toBeTruthy();

    await fireEvent.press(result.getByRole('button', { name: 'Retry upload' }));
    await result.findByTestId('camera-contribution-status-sealed');
    expect(uploadClip).toHaveBeenCalledTimes(2);
    expect(processClipJob).toHaveBeenCalledTimes(2);
  });

  it('does not offer retry for a typed terminal processing rejection', async () => {
    const processClipJob = jest
      .fn()
      .mockRejectedValue(
        new LocalRuntimeError('The contribution is not authorised.', 403, 'forbidden'),
      );
    const result = await renderReviewWithRuntime(
      videoPlatformForReview(),
      runtimeClient({ processClipJob }),
    );

    await fireEvent.press(result.getByRole('button', { name: 'Upload clip' }));
    await result.findByTestId('camera-contribution-status-failed');
    expect(
      result.getByText(
        'This contribution cannot be retried. Retake it to submit a new contribution.',
      ),
    ).toBeTruthy();
    expect(result.queryByRole('button', { name: 'Retry upload' })).toBeNull();
    expect(result.queryByText('Upload queued as one pending contribution.')).toBeNull();
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
