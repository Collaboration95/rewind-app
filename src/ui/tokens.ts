import { Platform, type TextStyle } from 'react-native';

// Warm Glass tokens, ported from the design's `.c6` and `.dark` variables
// (docs/design/home-directions/styles-r2.css and styles-screens.css on
// ui-concept/final-screens).
export const WARM = {
  bg: '#f6ede3',
  ink: '#33231a',
  // Secondary text: 4.5:1 even on the brightest warm glow.
  muted: 'rgba(51, 35, 26, 0.74)',
  line: 'rgba(51, 35, 26, 0.1)',
  accent: '#e0703a',
  sheet: 'rgba(255, 250, 244, 0.97)',
  avBg: '#f0d9c4',
  avInk: '#6b4028',
  ringOn: '#e8834a',
  ringOff: 'rgba(51, 35, 26, 0.14)',
  danger: '#c2452f',
  dangerInk: '#8f2615',
  badge: '#d6343a',
  // Ink on the peach buttons.
  peachInk: '#2a1a10',
  peachTop: '#ffd2a6',
  peachBottom: '#ff9f6b',
  peachSoft: '#ffd9b0',
  heroInk: '#3a2216',
} as const;

export const DARK = {
  bg: '#16100c',
  ink: '#f8ece0',
  muted: 'rgba(248, 236, 224, 0.72)',
  line: 'rgba(255, 255, 255, 0.14)',
  ringOff: 'rgba(255, 255, 255, 0.3)',
  ringOn: '#ffc08f',
  avBg: '#4a3326',
} as const;

// One colour per member, across avatars, chat and the film cast.
export const MEMBER_COLORS = [
  '#E07A5F',
  '#E9B44C',
  '#7FB08F',
  '#6D90C4',
  '#B480B0',
  '#E58F9F',
  '#4FA69C',
  '#C7895A',
  '#8D95C9',
  '#CFA66E',
] as const;

/** A stable member colour from any id, so a person keeps theirs across screens. */
export function memberColor(id: string | undefined | null): string {
  let hash = 0;
  for (const char of id ?? '') hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return MEMBER_COLORS[hash % MEMBER_COLORS.length];
}

export const FONT = {
  serif: 'Fraunces',
  body: 'Geist',
  mono: 'DMMono-Regular',
  monoMedium: 'DMMono-Medium',
} as const;

// Fraunces is drawn with its soft axis on; the variation settings only apply
// on the web, where the variable font is loaded through @font-face.
const soft = (opsz?: number): TextStyle =>
  Platform.OS === 'web'
    ? ({
        fontVariationSettings: opsz ? `'SOFT' 100, 'opsz' ${opsz}` : "'SOFT' 100",
      } as TextStyle)
    : {};

export function serif(size: number, weight: TextStyle['fontWeight'] = '400', opsz?: number) {
  return { fontFamily: FONT.serif, fontSize: size, fontWeight: weight, ...soft(opsz) };
}

export const MOTION = {
  push: 350,
  menu: 220,
  toast: 2600,
  tip: 1900,
  launchFade: 500,
  launchMinimum: 600,
  ease: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
} as const;

// Phone metrics the design is drawn at.
export const LAYOUT = {
  gutter: 22,
  maxWidth: 520,
  headerHeight: 56,
  dockHeight: 76,
} as const;
