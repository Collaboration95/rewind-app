import Svg, { Circle, Path } from 'react-native-svg';

import { WARM } from './tokens';

const polar = (c: number, r: number, deg: number) => {
  const a = (deg * Math.PI) / 180;
  return `${(c + r * Math.cos(a)).toFixed(2)} ${(c + r * Math.sin(a)).toFixed(2)}`;
};

/** The shutter's allowance ring: one segment per moment, used ones lit (app.js `ring`). */
export function SegmentRing({
  used,
  total = 5,
  size = 76,
  on = WARM.ringOn,
  off = WARM.ringOff,
}: {
  used: number;
  total?: number;
  size?: number;
  on?: string;
  off?: string;
}) {
  const c = 38;
  const r = 35;
  const gap = 9;
  return (
    <Svg
      accessibilityElementsHidden
      height={size}
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', left: 0, top: 0 }}
      viewBox="0 0 76 76"
      width={size}
    >
      {Array.from({ length: total }, (_, i) => {
        const a0 = -90 + (i * 360) / total + gap / 2;
        const a1 = -90 + ((i + 1) * 360) / total - gap / 2;
        return (
          <Path
            key={i}
            d={`M${polar(c, r, a0)}A${r} ${r} 0 0 1 ${polar(c, r, a1)}`}
            fill="none"
            stroke={i < used ? on : off}
            strokeLinecap="round"
            strokeWidth={3}
          />
        );
      })}
    </Svg>
  );
}

/** A continuous arc: the record ring in the camera (app.js `arcRing`). */
export function ArcRing({
  fraction,
  size = 86,
  on = WARM.ringOn,
  off = WARM.ringOff,
}: {
  fraction: number;
  size?: number;
  on?: string;
  off?: string;
}) {
  const frac = Math.max(0.001, Math.min(fraction, 0.999));
  const end = -90 + 360 * frac;
  return (
    <Svg
      accessibilityElementsHidden
      height={size}
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', left: 0, top: 0 }}
      viewBox="0 0 76 76"
      width={size}
    >
      <Circle cx={38} cy={38} fill="none" r={35} stroke={off} strokeWidth={3} />
      <Path
        d={`M${polar(38, 35, -90)}A35 35 0 ${frac > 0.5 ? 1 : 0} 1 ${polar(38, 35, end)}`}
        fill="none"
        stroke={on}
        strokeLinecap="round"
        strokeWidth={3}
      />
    </Svg>
  );
}
