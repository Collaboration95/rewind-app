import { isPhoneLandscape } from '../src/runtime/PortraitGuard';

describe('portrait guard (#327)', () => {
  it('covers only phone-sized landscape viewports', () => {
    expect(isPhoneLandscape(926, 428)).toBe(true); // iPhone 14 Plus sideways
    expect(isPhoneLandscape(428, 926)).toBe(false); // portrait
    expect(isPhoneLandscape(1180, 820)).toBe(false); // tablet landscape
    expect(isPhoneLandscape(1440, 900)).toBe(false); // desktop
  });
});
