import { permissionState } from '../src/capture/platform';

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
