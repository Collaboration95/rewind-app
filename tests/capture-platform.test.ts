import { ExpoCameraPlatform, permissionState } from '../src/capture/platform';

jest.mock('expo-camera', () => ({
  Camera: {
    getCameraPermissionsAsync: jest.fn(),
    getMicrophonePermissionsAsync: jest.fn(),
    requestCameraPermissionsAsync: jest.fn(),
    requestMicrophonePermissionsAsync: jest.fn(),
  },
  // Native Expo Camera surfaces do not register the web-only availability
  // probe. The adapter must still reach the permission/device decision.
  CameraView: {},
}));

jest.mock('expo-device', () => ({ isDevice: true }));

describe('Expo permission normalization', () => {
  it.each([
    [{ status: 'granted' }, 'granted'],
    [{ status: 'undetermined' }, 'undetermined'],
    [{ status: 'denied', canAskAgain: true }, 'denied'],
    [{ status: 'denied', canAskAgain: false }, 'blocked'],
  ])('maps %o to %s', (response, expected) => {
    expect(permissionState(response)).toBe(expected);
  });
});

it('treats a missing native availability probe as available on a physical device', async () => {
  const platform = new ExpoCameraPlatform({ getCameraRef: () => null });
  await expect(platform.getCapabilities()).resolves.toEqual({
    camera: 'supported',
    microphone: 'supported',
  });
});
