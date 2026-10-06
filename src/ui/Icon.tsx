import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { WARM } from './tokens';

// The design's icon set (`I` in app.js, screens.js and tabs.js): 24×24
// outlines. `d` parts take the warm accent fill and `f` parts are filled ink,
// as in the design's `.ic .d` and `.ic .f` rules.
type Part =
  | { p: string; k?: 'd' | 'f' }
  | { c: [number, number, number]; k?: 'd' | 'f' }
  | { r: [number, number, number, number, number]; k?: 'd' | 'f' };

const ICONS = {
  home: [
    { r: [10, 14.8, 4, 5.2, 0.8], k: 'd' },
    { p: 'M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z' },
  ],
  chat: [
    { p: 'M20 12a7.5 7.5 0 0 1-11 6.6L4 20l1.4-4.6A7.5 7.5 0 1 1 20 12Z' },
    { c: [12, 12, 2.3], k: 'd' },
  ],
  archive: [
    { c: [11, 12, 7.5] },
    { c: [11, 12, 1], k: 'f' },
    { c: [11, 8.3, 1.5] },
    { c: [14.7, 12, 1.5] },
    { c: [11, 15.7, 1.5] },
    { c: [7.3, 12, 1.5] },
    { p: 'M11 19.5h9' },
  ],
  camera: [
    {
      p: 'M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.4-2h5.6l1.4 2h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z',
    },
    { c: [12, 12.5, 3.5] },
    { c: [12, 12.5, 2], k: 'd' },
  ],
  lock: [{ r: [5, 10.5, 14, 9.5, 2] }, { p: 'M8 10.5V8a4 4 0 0 1 8 0v2.5' }],
  chev: [{ p: 'm7 10 5 5 5-5' }],
  check: [{ p: 'm5.5 12.5 4.2 4.2L18.5 8' }],
  play: [{ p: 'M8.5 5.8v12.4a.6.6 0 0 0 .9.5l10-6.2a.6.6 0 0 0 0-1l-10-6.2a.6.6 0 0 0-.9.5Z' }],
  bell: [{ p: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z' }, { p: 'M10 20.5a2 2 0 0 0 4 0' }],
  back: [{ p: 'm14.5 6-6 6 6 6' }],
  close: [{ p: 'M6.5 6.5l11 11M17.5 6.5l-11 11' }],
  flash: [{ p: 'M13 3.5 6.5 13h5l-1 7.5L17.5 11h-5z' }],
  flip: [
    { p: 'M4.5 12a7.5 7.5 0 0 1 13.2-4.9M19.5 12a7.5 7.5 0 0 1-13.2 4.9' },
    { p: 'M18 3.8v3.6h-3.6M6 20.2v-3.6h3.6' },
  ],
  plus: [{ p: 'M12 5v14M5 12h14' }],
  out: [
    {
      p: 'M14 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19H14M10 12h10M16.5 8.5 20 12l-3.5 3.5',
    },
  ],
  pause: [{ p: 'M8.5 6v12M15.5 6v12' }],
  save: [{ p: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14' }],
  replay: [{ p: 'M5 12a7 7 0 1 0 2.1-5' }, { p: 'M5 4.5V9h4.5' }],
  copy: [{ r: [8, 8, 11, 11, 2] }, { p: 'M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15' }],
  share: [
    { p: 'M12 15V4M8 7.5 12 4l4 3.5' },
    {
      p: 'M8.5 10H7a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 17 10h-1.5',
    },
  ],
  key: [{ c: [8, 15, 3.5] }, { p: 'm10.5 12.5 8-8M15.5 7.5l2 2M17.5 5.5l1.5 1.5' }],
  send: [{ p: 'M4 11.5 20 4l-6.5 16-2.5-6.5z' }, { p: 'm11 13.5 9-9.5' }],
  trash: [{ p: 'M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7' }],
  quote: [{ p: 'M5 18V12a5 5 0 0 1 5-5M14 18v-6a5 5 0 0 1 5-5' }],
  snooze: [{ p: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z' }, { p: 'M10 9.5h4l-4 4h4' }],
  clock: [{ c: [12, 12, 8] }, { p: 'M12 7.5V12l3 2' }],
  users: [
    { c: [9, 9, 3.2] },
    { p: 'M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6' },
    { p: 'M15.5 6.2a3 3 0 0 1 0 5.6M17.5 14.6c1.6.6 2.6 2 3 4.4' },
  ],
  video: [{ r: [3.5, 6.5, 12, 11, 2] }, { p: 'm15.5 10.5 5-3v9l-5-3' }],
  expand: [{ p: 'M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15' }],
  forward: [{ p: 'm9.5 6 6 6-6 6' }],
  eye: [
    { p: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z' },
    { c: [12, 12, 3] },
  ],
  eyeOff: [
    { p: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z' },
    { c: [12, 12, 3] },
    { p: 'M4 4l16 16' },
  ],
} satisfies Record<string, Part[]>;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 22,
  color = WARM.ink,
  strokeWidth = 1.6,
  filled = false,
  accent = WARM.accent,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  /** Fill the outline too, as the design does for play and pause glyphs. */
  filled?: boolean;
  accent?: string;
}) {
  return (
    <Svg
      accessibilityElementsHidden
      height={size}
      importantForAccessibility="no-hide-descendants"
      viewBox="0 0 24 24"
      width={size}
    >
      {(ICONS[name] as Part[]).map((part, index) => {
        const paint =
          part.k === 'd'
            ? { fill: accent, fillOpacity: 0.9, stroke: 'none' }
            : part.k === 'f'
              ? { fill: color, stroke: 'none' }
              : {
                  fill: filled ? color : 'none',
                  stroke: color,
                  strokeWidth,
                  strokeLinecap: 'round' as const,
                  strokeLinejoin: 'round' as const,
                };
        if ('p' in part) return <Path key={index} d={part.p} {...paint} />;
        if ('c' in part)
          return <Circle key={index} cx={part.c[0]} cy={part.c[1]} r={part.c[2]} {...paint} />;
        const [x, y, width, height, rx] = part.r;
        return <Rect key={index} x={x} y={y} width={width} height={height} rx={rx} {...paint} />;
      })}
    </Svg>
  );
}
