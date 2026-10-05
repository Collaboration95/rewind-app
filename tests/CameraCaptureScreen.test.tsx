import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import { CameraCaptureScreen } from '../src/capture/CameraCaptureScreen';
import {
  DemoCameraPlatform,
  InMemoryCaptureFileStore,
  InMemoryImageMetadataStore,
} from '../src/capture';
import type { CameraPlatform } from '../src/capture/contracts';
import {
  ContributionStatusProvider,
  type ContributionStatus,
  type ContributionStatusStore,
} from '../src/capture/contribution-status';

jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('expo-camera', () => {
  // Jest module factories run outside the ES module scope.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  const CameraView = ReactModule.forwardRef((props: Record<string, unknown>, ref: unknown) => {
    ReactModule.useImperativeHandle(ref, () => ({
      takePictureAsync: async () => ({
        format: 'jpg',
        height: 900,
        uri: 'file://test.jpg',
        width: 1200,
      }),
    }));
    return <View {...props} />;
  });
  CameraView.isAvailableAsync = jest.fn().mockResolvedValue(true);
  return {
    Camera: {
      getCameraPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
      getMicrophonePermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
      requestCameraPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
      requestMicrophonePermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
    },
    CameraView,
  };
});

async function screen(
  platform: CameraPlatform,
  stores = {
    files: new InMemoryCaptureFileStore(),
    metadata: new InMemoryImageMetadataStore(),
  },
  createCaptureId: () => string = () => 'capture-ui',
) {
  return render(
    <CameraCaptureScreen
      createCaptureId={createCaptureId}
      fileStore={stores.files}
      metadataStore={stores.metadata}
      now={() => new Date('2026-09-10T00:00:00.000Z')}
      platform={platform}
    />,
  );
}

/**
 * Drive the AppState subscription deterministically and restore the captured
 * original afterwards. The React Native preset already installs
 * `addEventListener` as a jest mock, so restoring that mock would leave later
 * unmounts calling `undefined.remove()`.
 */
function stubAppState(): { emit: (state: string) => void; restore: () => void } {
  const original = AppState.addEventListener;
  let listener: ((state: string) => void) | null = null;
  (AppState as unknown as { addEventListener: unknown }).addEventListener = ((
    _eventName: string,
    next: (state: string) => void,
  ) => {
    listener = next;
    return { remove: jest.fn() };
  }) as never;
  return {
    emit: (state) => listener?.(state),
    restore: () => {
      (AppState as unknown as { addEventListener: unknown }).addEventListener = original;
    },
  };
}

describe('CameraCaptureScreen', () => {
  it.each([
    ['unsupported', 'granted', 'camera-unsupported'],
    ['supported', 'undetermined', 'camera-permission-undecided'],
    ['supported', 'denied', 'camera-permission-denied'],
  ] as const)(
    'keeps the group visible when camera capability is %s and permission is %s',
    async (capability, permission, panel) => {
      const platform: CameraPlatform = {
        kind: 'expo',
        getCapabilities: jest
          .fn()
          .mockResolvedValue({ camera: capability, microphone: 'supported' }),
        getPermissions: jest.fn().mockResolvedValue({ camera: permission, microphone: 'granted' }),
        requestPermissions: jest.fn(),
        captureStill: jest.fn(),
        openSettings: jest.fn(),
        supportsLivePreview: true,
      };
      const result = await render(
        <CameraCaptureScreen
          groupName="Garden circle"
          platform={platform}
          fileStore={new InMemoryCaptureFileStore()}
          metadataStore={new InMemoryImageMetadataStore()}
        />,
      );
      await result.findByTestId(panel);
      expect(result.getByText('Group · Garden circle')).toBeTruthy();
      expect(result.getByTestId('camera-group-context').props.accessibilityLiveRegion).toBe(
        'polite',
      );
      expect(platform.requestPermissions).not.toHaveBeenCalled();
      expect(platform.captureStill).not.toHaveBeenCalled();
    },
  );

  it('keeps selected-group context in the viewfinder and owned photo review', async () => {
    const platform = new DemoCameraPlatform();
    const files = new InMemoryCaptureFileStore();
    const metadata = new InMemoryImageMetadataStore();
    const result = await render(
      <CameraCaptureScreen
        groupName="Garden circle"
        platform={platform}
        fileStore={files}
        metadataStore={metadata}
      />,
    );
    await result.findByTestId('camera-capture');
    expect(result.getByText('Group · Garden circle')).toBeTruthy();
    await fireEvent.press(result.getByTestId('camera-capture'));
    await result.findByTestId('camera-preview-panel');
    expect(result.getByText('Group · Garden circle')).toBeTruthy();
    expect(files.size).toBe(1);
    await fireEvent.press(result.getByRole('button', { name: 'Retake' }));
    expect(result.getByText('Group · Garden circle')).toBeTruthy();
    expect(files.size).toBe(0);
  });

  it('offers a labelled image file fallback when live camera support is unavailable', async () => {
    const platform: CameraPlatform = {
      captureStill: jest.fn(),
      getCapabilities: jest
        .fn()
        .mockResolvedValue({ camera: 'unsupported', microphone: 'supported' }),
      getPermissions: jest.fn().mockResolvedValue({ camera: 'granted', microphone: 'granted' }),
      kind: 'expo',
      openSettings: jest.fn().mockResolvedValue(undefined),
      pickStillFile: jest.fn().mockResolvedValue({
        format: 'jpg',
        height: 900,
        source: 'file' as const,
        sourceUri: 'blob:test-image',
        width: 1200,
      }),
      requestPermissions: jest.fn(),
      supportsFileFallback: true,
      supportsLivePreview: true,
    };
    const result = await screen(platform);

    await result.findByTestId('camera-unsupported');
    expect(result.queryByRole('button', { name: 'Take photo' })).toBeNull();
    await fireEvent.press(result.getByRole('button', { name: 'Choose an image file' }));
    await result.findByTestId('camera-preview-panel');
    expect(platform.pickStillFile).toHaveBeenCalledTimes(1);
  });

  it('shows the ready state, then fixture preview and metadata-only acceptance', async () => {
    const files = new InMemoryCaptureFileStore();
    const metadata = new InMemoryImageMetadataStore();
    const result = await screen(new DemoCameraPlatform(), { files, metadata });

    await result.findByTestId('camera-capture');
    expect(result.getByRole('button', { name: 'Take photo' })).toBeEnabled();
    await fireEvent.press(result.getByTestId('camera-capture'));
    expect(await result.findByTestId('camera-demo-preview')).toBeTruthy();
    expect(result.queryByText(/fixture:\/\//)).toBeNull();
    expect(files.size).toBe(1);
    expect(await metadata.list()).toEqual([]);

    await fireEvent.press(result.getByRole('button', { name: 'Use this still' }));
    await result.findByText('Saved locally. Metadata only is retained.');
    expect(await metadata.list()).toEqual([
      expect.objectContaining({
        capturedAt: '2026-09-10T00:00:00.000Z',
        id: 'capture-ui',
      }),
    ]);
    expect((await metadata.list())[0]).not.toHaveProperty('uri');
  });

  it('presents a full-screen viewfinder with an accessible circular photo shutter', async () => {
    const platform: CameraPlatform = {
      captureStill: jest.fn().mockResolvedValue({
        format: 'jpg',
        height: 900,
        source: 'camera',
        sourceUri: 'file://test.jpg',
        width: 1200,
      }),
      getCapabilities: jest
        .fn()
        .mockResolvedValue({ camera: 'supported', microphone: 'supported' }),
      getPermissions: jest.fn().mockResolvedValue({ camera: 'granted', microphone: 'granted' }),
      kind: 'expo',
      openSettings: jest.fn().mockResolvedValue(undefined),
      requestPermissions: jest.fn().mockResolvedValue({ camera: 'granted', microphone: 'granted' }),
      supportsLivePreview: true,
    };
    const result = await screen(platform);

    await result.findByTestId('camera-live-preview');
    const screenRoot = result.getByTestId('camera-screen');
    const viewfinder = result.getByTestId('camera-live-preview');
    const shutter = result.getByRole('button', { name: 'Take photo' });
    expect(screenRoot.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ padding: 0 })]),
    );
    expect(viewfinder.props.accessibilityLabel).toBe('Live camera viewfinder');
    expect(shutter).toBeDisabled();
    expect(shutter.props.accessibilityHint).toContain('opens a preview');

    await act(async () => {
      fireEvent(result.getByTestId('camera-live-preview'), 'cameraReady');
    });
    await waitFor(() => expect(result.getByRole('button', { name: 'Take photo' })).toBeEnabled());
    await fireEvent.press(result.getByRole('button', { name: 'Take photo' }));
    await result.findByTestId('camera-preview-panel');
    expect(result.getByRole('button', { name: 'Retake' })).toBeTruthy();
  });

  it('cleans an active preview when retaking or discarding', async () => {
    const files = new InMemoryCaptureFileStore();
    const metadata = new InMemoryImageMetadataStore();
    const result = await screen(new DemoCameraPlatform(), { files, metadata });
    await result.findByTestId('camera-capture');

    await fireEvent.press(result.getByTestId('camera-capture'));
    await result.findByTestId('camera-demo-preview');
    await fireEvent.press(result.getByRole('button', { name: 'Retake' }));
    expect(result.queryByTestId('camera-demo-preview')).toBeNull();
    expect(files.size).toBe(0);

    await fireEvent.press(result.getByTestId('camera-capture'));
    await result.findByTestId('camera-demo-preview');
    await fireEvent.press(result.getByRole('button', { name: 'Discard' }));
    expect(result.queryByTestId('camera-demo-preview')).toBeNull();
    expect(files.size).toBe(0);
  });

  it.each([
    [
      'temporarily-unavailable',
      { camera: 'undecided' as const, microphone: 'supported' as const },
      { camera: 'granted' as const, microphone: 'granted' as const },
      'camera-temporarily-unavailable',
      'Camera is temporarily unavailable',
    ],
    [
      'unsupported',
      { camera: 'unsupported' as const, microphone: 'supported' as const },
      { camera: 'granted' as const, microphone: 'granted' as const },
      'camera-unsupported',
      'Camera capture is not supported here',
    ],
    [
      'permission-undecided',
      { camera: 'supported' as const, microphone: 'supported' as const },
      { camera: 'undetermined' as const, microphone: 'granted' as const },
      'camera-permission-undecided',
      'Allow the camera',
    ],
    [
      'permission-denied',
      { camera: 'supported' as const, microphone: 'supported' as const },
      { camera: 'denied' as const, microphone: 'granted' as const },
      'camera-permission-denied',
      'The camera is off',
    ],
    [
      'permission-blocked',
      { camera: 'supported' as const, microphone: 'supported' as const },
      { camera: 'blocked' as const, microphone: 'granted' as const },
      'camera-permission-blocked',
      'The camera is off',
    ],
  ])(
    'renders the %s state without exposing a capture control',
    async (_label, capabilities, permissions, testID, title) => {
      const platform = new DemoCameraPlatform({ capabilities, permissions });
      const result = await screen(platform);
      expect(await result.findByTestId(testID)).toBeTruthy();
      expect(result.getByText(title)).toBeTruthy();
      expect(result.queryByRole('button', { name: 'Take photo' })).toBeNull();
    },
  );

  it('requests undetermined permissions and enables the control only after both are granted', async () => {
    const platform = new DemoCameraPlatform({
      permissions: { camera: 'undetermined', microphone: 'undetermined' },
    });
    const requestPermissions = jest.spyOn(platform, 'requestPermissions').mockResolvedValue({
      camera: 'granted',
      microphone: 'granted',
    });
    const result = await screen(platform);
    await result.findByTestId('camera-permission-undecided');
    await fireEvent.press(result.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(requestPermissions).toHaveBeenCalled());
    await result.findByTestId('camera-capture');
    expect(result.getByRole('button', { name: 'Take photo' })).toBeEnabled();
  });

  it('keeps a capture failure actionable', async () => {
    const platform = new DemoCameraPlatform();
    jest.spyOn(platform, 'captureStill').mockRejectedValue(new Error('camera warm-up failed'));
    const result = await screen(platform);
    await result.findByTestId('camera-capture');
    await fireEvent.press(result.getByTestId('camera-capture'));
    await result.findByTestId('camera-capture-failed');
    expect(result.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('does not let an unverified destination become a preview', async () => {
    const files = new InMemoryCaptureFileStore();
    jest.spyOn(files, 'exists').mockResolvedValue(false);
    const result = await screen(new DemoCameraPlatform(), {
      files,
      metadata: new InMemoryImageMetadataStore(),
    });
    await result.findByTestId('camera-capture');
    await fireEvent.press(result.getByTestId('camera-capture'));
    await result.findByTestId('camera-write-failed');
    expect(result.queryByTestId('camera-demo-preview')).toBeNull();
  });

  it('resumes an already-captured preview after the app is backgrounded', async () => {
    const appState = stubAppState();
    const stores = {
      files: new InMemoryCaptureFileStore(),
      metadata: new InMemoryImageMetadataStore(),
    };
    const result = await screen(new DemoCameraPlatform(), stores);

    await result.findByTestId('camera-capture');
    await fireEvent.press(result.getByTestId('camera-capture'));
    await result.findByTestId('camera-demo-preview');

    await act(async () => {
      appState.emit('background');
    });

    // Backgrounding resumes an established preview: it is a durable managed
    // file this route still owns, and nothing about the suspension invalidates
    // it. Losing a captured still here would be the surprising outcome.
    expect(result.getByTestId('camera-preview-panel')).toBeTruthy();
    expect(stores.files.size).toBe(1);
    expect(await stores.metadata.list()).toEqual([]);

    // Returning to the foreground re-checks access and keeps the preview
    // actionable rather than stranding it.
    await act(async () => {
      appState.emit('active');
    });
    expect(result.getByTestId('camera-preview-panel')).toBeTruthy();
    appState.restore();
  });

  it('ignores a stale capture that resolves after the app was backgrounded', async () => {
    const appState = stubAppState();
    const platform = new DemoCameraPlatform();
    let resolveCapture!: (image: Awaited<ReturnType<CameraPlatform['captureStill']>>) => void;
    jest.spyOn(platform, 'captureStill').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
    );
    const stores = {
      files: new InMemoryCaptureFileStore(),
      metadata: new InMemoryImageMetadataStore(),
    };
    const result = await screen(platform, stores);

    await result.findByTestId('camera-capture');
    // Hold the capture pending so backgrounding happens mid-capture, which is
    // exactly the interruption the sequence guard has to survive. One act
    // block keeps the ordering explicit and avoids overlapping act() calls.
    await act(async () => {
      const press = fireEvent.press(result.getByTestId('camera-capture'));
      appState.emit('background');
      resolveCapture({
        format: 'jpg',
        height: 900,
        source: 'demo-fixture',
        sourceUri: 'fixture://late-still',
        width: 1200,
      });
      await press;
    });

    // A late completion must not publish a preview that this mount no longer
    // owns; the still route returns to its ready state instead.
    expect(result.queryByTestId('camera-preview-panel')).toBeNull();
    await result.findByTestId('camera-capture');
    expect(stores.files.size).toBe(0);
    appState.restore();
  });

  it('keeps a newer file-backed preview when an older capture finishes late', async () => {
    const appState = stubAppState();
    const files = new InMemoryCaptureFileStore();
    const stores = { files, metadata: new InMemoryImageMetadataStore() };
    const platform: CameraPlatform = {
      captureStill: jest
        .fn()
        .mockResolvedValueOnce({
          format: 'jpg',
          height: 900,
          source: 'camera' as const,
          sourceUri: 'file://older-capture.jpg',
          width: 1200,
        })
        .mockResolvedValueOnce({
          format: 'jpg',
          height: 900,
          source: 'camera' as const,
          sourceUri: 'file://newer-capture.jpg',
          width: 1200,
        }),
      getCapabilities: jest
        .fn()
        .mockResolvedValue({ camera: 'supported', microphone: 'supported' }),
      getPermissions: jest.fn().mockResolvedValue({ camera: 'granted', microphone: 'granted' }),
      kind: 'expo',
      openSettings: jest.fn().mockResolvedValue(undefined),
      requestPermissions: jest.fn().mockResolvedValue({ camera: 'granted', microphone: 'granted' }),
      supportsLivePreview: false,
    };
    const originalExists = files.exists.bind(files);
    const exists = jest.spyOn(files, 'exists');
    let resolveOlderExists!: (value: boolean) => void;
    exists.mockImplementation((uri) =>
      uri.endsWith('capture-older.jpg')
        ? new Promise<boolean>((resolve) => {
            resolveOlderExists = resolve;
          })
        : originalExists(uri),
    );
    let captureNumber = 0;
    const result = await screen(platform, stores, () =>
      ++captureNumber === 1 ? 'capture-older' : 'capture-newer',
    );

    await result.findByTestId('camera-capture');
    let olderCapture!: Promise<void>;
    await act(async () => {
      olderCapture = fireEvent.press(result.getByTestId('camera-capture'));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(exists).toHaveBeenCalledWith('memory://rewind-stills/capture-older.jpg'),
    );

    await act(async () => {
      appState.emit('background');
      appState.emit('active');
    });
    await result.findByTestId('camera-capture');
    await act(async () => {
      await fireEvent.press(result.getByTestId('camera-capture'));
    });
    await result.findByTestId('camera-preview-panel');
    const newerPreview = result.getByLabelText('Captured still preview');
    const newerUri = newerPreview.props.source.uri as string;
    expect(newerUri).toBe('memory://rewind-stills/capture-newer.jpg');
    expect(await files.exists(newerUri)).toBe(true);

    await act(async () => {
      resolveOlderExists(true);
      await olderCapture;
    });
    expect(result.getByTestId('camera-preview-panel')).toBeTruthy();
    expect(result.getByLabelText('Captured still preview').props.source.uri).toBe(newerUri);
    expect(await files.exists(newerUri)).toBe(true);
    expect(files.size).toBe(1);

    appState.restore();
  });

  it('seals a photo, shows Sealed with Done only, and Done closes the camera', async () => {
    const onBack = jest.fn();
    const onSubmitPhoto = jest.fn(async (): Promise<ContributionStatus> => ({
      createdAt: '2026-09-10T00:00:00.000Z',
      retryable: false,
      state: 'sealed',
    }));
    const result = await render(
      <CameraCaptureScreen
        fileStore={new InMemoryCaptureFileStore()}
        metadataStore={new InMemoryImageMetadataStore()}
        onBack={onBack}
        onSubmitPhoto={onSubmitPhoto}
        platform={new DemoCameraPlatform()}
      />,
    );
    await fireEvent.press(await result.findByTestId('camera-capture'));
    await result.findByTestId('camera-preview-panel');
    expect(result.getByRole('radio', { name: 'Compact Digital' })).toBeTruthy();
    await fireEvent.press(result.getByRole('button', { name: 'Seal' }));

    await result.findByTestId('camera-sealed');
    expect(onSubmitPhoto).toHaveBeenCalledTimes(1);
    expect(result.getByText('Nobody sees it before the film, not even you.')).toBeTruthy();
    expect(result.queryByRole('button', { name: /Tell the group/ })).toBeNull();
    await fireEvent.press(result.getByRole('button', { name: 'Done' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('turns the photo shutter off with less than 3 s left this week and says why', async () => {
    const stored: ContributionStatus = {
      allowance: {
        countUsed: 4,
        deletionAvailability: 'available',
        deletionsUsed: 0,
        maxCount: 5,
        maxSeconds: 30,
        secondsUsed: 28,
      },
      createdAt: '2026-09-10T00:00:00.000Z',
      retryable: false,
      state: 'sealed',
    };
    const store: ContributionStatusStore = {
      clear: jest.fn().mockResolvedValue(undefined),
      load: jest.fn().mockResolvedValue(stored),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const result = await render(
      <ContributionStatusProvider
        scope={{ groupId: 'g', memberId: 'm', sessionId: 's' }}
        store={store}
      >
        <CameraCaptureScreen
          fileStore={new InMemoryCaptureFileStore()}
          metadataStore={new InMemoryImageMetadataStore()}
          platform={new DemoCameraPlatform()}
        />
      </ContributionStatusProvider>,
    );
    expect(await result.findByText('1 left · 2 s')).toBeTruthy();
    expect(result.getByRole('button', { name: 'Take photo' })).toBeDisabled();
    expect(result.getByText('A photo needs 3 s; you have 2 s left this week.')).toBeTruthy();
    // A restored status never shows the Sealed screen; the lock count opens it.
    expect(result.queryByTestId('camera-sealed')).toBeNull();
    await fireEvent.press(result.getByRole('button', { name: 'Your moments: 4 sealed' }));
    expect(await result.findByTestId('camera-contribution-status-sealed')).toBeTruthy();
  });
});
