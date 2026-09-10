import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { CameraCaptureScreen } from '../src/capture/CameraCaptureScreen';
import {
  DemoCameraPlatform,
  InMemoryCaptureFileStore,
  InMemoryImageMetadataStore,
} from '../src/capture';
import type { CameraPlatform } from '../src/capture/contracts';

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
) {
  return render(
    <CameraCaptureScreen
      createCaptureId={() => 'capture-ui'}
      fileStore={stores.files}
      metadataStore={stores.metadata}
      now={() => new Date('2026-09-10T00:00:00.000Z')}
      platform={platform}
    />,
  );
}

describe('CameraCaptureScreen', () => {
  it('shows the ready state, then fixture preview and metadata-only acceptance', async () => {
    const files = new InMemoryCaptureFileStore();
    const metadata = new InMemoryImageMetadataStore();
    const result = await screen(new DemoCameraPlatform(), { files, metadata });

    await result.findByTestId('camera-capture');
    expect(result.getByRole('button', { name: 'Take still image' })).toBeEnabled();
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
      'capability-undecided',
      { camera: 'undecided' as const, microphone: 'supported' as const },
      { camera: 'granted' as const, microphone: 'granted' as const },
      'camera-capability-undecided',
      'Camera availability needs checking',
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
      'Allow access to continue',
    ],
    [
      'permission-denied',
      { camera: 'supported' as const, microphone: 'supported' as const },
      { camera: 'denied' as const, microphone: 'granted' as const },
      'camera-permission-denied',
      'Camera access is off',
    ],
    [
      'permission-blocked',
      { camera: 'supported' as const, microphone: 'supported' as const },
      { camera: 'blocked' as const, microphone: 'granted' as const },
      'camera-permission-blocked',
      'Permission is blocked',
    ],
  ])(
    'renders the %s state without exposing a capture control',
    async (_label, capabilities, permissions, testID, title) => {
      const platform = new DemoCameraPlatform({ capabilities, permissions });
      const result = await screen(platform);
      expect(await result.findByTestId(testID)).toBeTruthy();
      expect(result.getByText(title)).toBeTruthy();
      expect(result.queryByRole('button', { name: 'Take still image' })).toBeNull();
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
    await fireEvent.press(result.getByRole('button', { name: 'Allow camera and microphone' }));
    await waitFor(() => expect(requestPermissions).toHaveBeenCalled());
    await result.findByTestId('camera-capture');
    expect(result.getByRole('button', { name: 'Take still image' })).toBeEnabled();
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
});
