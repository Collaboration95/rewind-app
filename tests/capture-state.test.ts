import { accessState, cameraAccessStatus, isCaptureReady } from '../src/capture/capture-state';

describe('camera capability and permission matrix', () => {
  const supported = { camera: 'supported' as const, microphone: 'supported' as const };

  it.each([
    [
      'camera capability undecided',
      { ...supported, camera: 'undecided' as const },
      'temporarily-unavailable',
    ],
    ['camera unsupported', { ...supported, camera: 'unsupported' as const }, 'unsupported'],
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
  ])('%s is distinct', (_label, permissions, expected) => {
    expect(cameraAccessStatus(supported, permissions)).toBe(expected);
  });

  it('enables still capture with camera permission without requiring microphone access', () => {
    const state = {
      ...accessState(
        { camera: 'supported', microphone: 'unsupported' },
        { camera: 'granted', microphone: 'denied' },
      ),
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
