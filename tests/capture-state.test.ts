import { accessState, cameraAccessStatus, isCaptureReady } from '../src/capture/capture-state';

describe('camera capability and permission matrix', () => {
  const supported = { camera: 'supported' as const, microphone: 'supported' as const };

  it.each([
    [
      'camera capability undecided',
      { ...supported, camera: 'undecided' as const },
      'capability-undecided',
    ],
    [
      'microphone capability undecided',
      { ...supported, microphone: 'undecided' as const },
      'capability-undecided',
    ],
    ['camera unsupported', { ...supported, camera: 'unsupported' as const }, 'unsupported'],
    ['microphone unsupported', { ...supported, microphone: 'unsupported' as const }, 'unsupported'],
  ])('%s is distinct', (_label, capabilities, expected) => {
    expect(cameraAccessStatus(capabilities, { camera: 'granted', microphone: 'granted' })).toBe(
      expected,
    );
  });

  it.each([
    [
      'permission undecided',
      { camera: 'undetermined' as const, microphone: 'granted' as const },
      'permission-undecided',
    ],
    [
      'permission denied',
      { camera: 'denied' as const, microphone: 'granted' as const },
      'permission-denied',
    ],
    [
      'permission blocked',
      { camera: 'blocked' as const, microphone: 'granted' as const },
      'permission-blocked',
    ],
    [
      'microphone denied',
      { camera: 'granted' as const, microphone: 'denied' as const },
      'permission-denied',
    ],
  ])('%s is distinct', (_label, permissions, expected) => {
    expect(cameraAccessStatus(supported, permissions)).toBe(expected);
  });

  it('enables capture only when both capabilities and permissions are granted', () => {
    const state = {
      ...accessState(supported, { camera: 'granted', microphone: 'granted' }),
      activePreview: null,
    };
    expect(state.status).toBe('ready');
    expect(isCaptureReady(state)).toBe(true);
    expect(
      isCaptureReady({
        ...state,
        status: 'permission-denied',
      }),
    ).toBe(false);
  });
});
