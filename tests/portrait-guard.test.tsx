import { render } from '@testing-library/react-native';
import { Platform, Text } from 'react-native';

import { PortraitGuard, isPhoneLandscape, useAllowLandscape } from '../src/runtime/PortraitGuard';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ fontScale: 1, height: 428, scale: 3, width: 926 }),
}));

const originalOS = Platform.OS;

function CameraScreen() {
  useAllowLandscape();
  return <Text>camera</Text>;
}

describe('portrait guard (#327)', () => {
  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
  });

  it('covers only phone-sized landscape viewports', () => {
    expect(isPhoneLandscape(926, 428)).toBe(true); // iPhone 14 Plus sideways
    expect(isPhoneLandscape(428, 926)).toBe(false); // portrait
    expect(isPhoneLandscape(1180, 820)).toBe(false); // tablet landscape
    expect(isPhoneLandscape(1440, 900)).toBe(false); // desktop
    // The keyboard shortens an upright iPhone's window until it looks sideways.
    expect(isPhoneLandscape(402, 380, 'portrait')).toBe(false);
    expect(isPhoneLandscape(874, 402, 'landscape')).toBe(true);
  });

  it('covers ordinary screens in phone landscape', async () => {
    const screen = await render(
      <PortraitGuard>
        <Text>home</Text>
      </PortraitGuard>,
    );
    expect(screen.getByTestId('portrait-guard')).toBeTruthy();
  });

  it('lets camera screens work in landscape', async () => {
    const screen = await render(
      <PortraitGuard>
        <CameraScreen />
      </PortraitGuard>,
    );
    expect(screen.queryByTestId('portrait-guard')).toBeNull();
  });
});
