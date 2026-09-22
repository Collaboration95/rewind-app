import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import App from '../App';
import { resetLocalDemoData } from '../src/data/demo-repository';
import type { CameraPlatform } from '../src/capture/contracts';
import type { RecordedClip } from '../src/domain/video';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

const recordedClip: RecordedClip = {
  sourceUri: 'file://navigation-test-clip.mp4',
  format: 'mp4',
  mimeType: 'video/mp4',
  width: 720,
  height: 1280,
  durationSeconds: 8,
  hasAudio: true,
  byteLength: 2_048,
  source: 'camera',
};

interface TestVideoPlatform extends CameraPlatform {
  recordClip(maxDurationSeconds: number): Promise<RecordedClip>;
  stopRecording(): void;
  cancelRecording(): void;
}

function videoPlatform() {
  let resolveRecording!: (clip: RecordedClip) => void;
  const recordClip = jest.fn(
    (_maxDurationSeconds: number) =>
      new Promise<RecordedClip>((resolve) => {
        resolveRecording = resolve;
      }),
  );
  const cancelRecording = jest.fn();
  const platform: TestVideoPlatform = {
    kind: 'expo',
    supportsLivePreview: false,
    supportsVideoRecording: true,
    captureStill: jest.fn().mockResolvedValue({
      sourceUri: 'file://navigation-test-still.jpg',
      format: 'jpg',
      width: 1_200,
      height: 900,
      source: 'camera',
    }),
    getCapabilities: jest.fn().mockResolvedValue({ camera: 'supported', microphone: 'supported' }),
    getPermissions: jest.fn().mockResolvedValue({ camera: 'granted', microphone: 'granted' }),
    requestPermissions: jest.fn().mockResolvedValue({ camera: 'granted', microphone: 'granted' }),
    openSettings: jest.fn().mockResolvedValue(undefined),
    recordClip,
    stopRecording: jest.fn(),
    cancelRecording,
  };
  return {
    platform,
    recordClip,
    cancelRecording,
    resolveRecording: (clip: RecordedClip) => resolveRecording(clip),
  };
}

async function activeApp(props: { cameraPlatform?: CameraPlatform } = {}) {
  const result = await render(<App {...props} />);
  await result.findByTestId('home-scroll');
  return result;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  await resetLocalDemoData();
});

describe('application navigation regressions', () => {
  it('visits every primary route and keeps its tab selected while stale routes unmount', async () => {
    const result = await activeApp();

    expect(result.getByRole('tab', { name: 'Home', selected: true })).toBeTruthy();
    expect(result.getByTestId('home-scroll')).toBeTruthy();

    await fireEvent.press(result.getByRole('tab', { name: 'Camera' }));
    expect(await result.findByTestId('camera-screen')).toBeTruthy();
    expect(result.getByRole('tab', { name: 'Camera', selected: true })).toBeTruthy();
    expect(result.queryByTestId('home-scroll')).toBeNull();

    await fireEvent.press(result.getByRole('tab', { name: 'Chat' }));
    expect(await result.findByTestId('chat-screen')).toBeTruthy();
    expect(await result.findByTestId('chat-unavailable')).toBeTruthy();
    expect(result.getByRole('tab', { name: 'Chat', selected: true })).toBeTruthy();
    expect(result.queryByTestId('camera-screen')).toBeNull();

    await fireEvent.press(result.getByRole('tab', { name: 'Archive' }));
    expect(await result.findByTestId('archive-unavailable')).toBeTruthy();
    expect(result.getByRole('tab', { name: 'Archive', selected: true })).toBeTruthy();
    expect(result.queryByTestId('chat-screen')).toBeNull();

    await fireEvent.press(result.getByRole('tab', { name: 'Settings' }));
    expect(result.getByTestId('settings-identity')).toBeTruthy();
    expect(result.getByRole('tab', { name: 'Settings', selected: true })).toBeTruthy();
    expect(result.queryByTestId('archive-unavailable')).toBeNull();
  });

  it('returns from create-group with Cancel and preserves the Settings tab context', async () => {
    const result = await activeApp();

    await fireEvent.press(result.getByRole('tab', { name: 'Settings' }));
    await fireEvent.press(result.getByRole('button', { name: 'Create a local group' }));

    expect(await result.findByRole('header', { name: 'Create a group' })).toBeTruthy();
    expect(result.getByTestId('group-name-input')).toBeTruthy();
    expect(result.getByRole('tab', { name: 'Settings', selected: true })).toBeTruthy();
    expect(result.queryByTestId('settings-identity')).toBeNull();

    await fireEvent.changeText(result.getByTestId('group-name-input'), 'Discarded draft');
    await fireEvent.press(result.getByRole('button', { name: 'Cancel' }));

    expect(result.getByTestId('settings-identity')).toBeTruthy();
    expect(result.getByRole('tab', { name: 'Settings', selected: true })).toBeTruthy();
    expect(result.queryByRole('header', { name: 'Create a group' })).toBeNull();
  });

  it('enters video from Camera, cancels recording on Back, and ignores a late completion', async () => {
    const fixture = videoPlatform();
    const result = await activeApp({ cameraPlatform: fixture.platform });

    await fireEvent.press(result.getByRole('tab', { name: 'Camera' }));
    await result.findByTestId('camera-screen');
    await fireEvent.press(result.getByTestId('camera-record-clip'));

    await result.findByTestId('video-live-preview');
    expect(result.getByRole('tab', { name: 'Camera', selected: true })).toBeTruthy();
    await fireEvent.press(result.getByTestId('video-record'));
    await result.findByTestId('video-recording');

    await fireEvent.press(result.getByRole('button', { name: 'Back to stills' }));
    expect(fixture.cancelRecording).toHaveBeenCalledTimes(1);
    expect(await result.findByTestId('camera-screen')).toBeTruthy();
    expect(result.queryByTestId('video-capture-screen')).toBeNull();

    await act(async () => {
      fixture.resolveRecording(recordedClip);
    });
    expect(result.queryByTestId('video-review')).toBeNull();
    expect(result.getByTestId('camera-screen')).toBeTruthy();
  });
});
