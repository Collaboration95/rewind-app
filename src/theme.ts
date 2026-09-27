/**
 * "Atelier" palette: a warm, near-black darkroom with ivory type, a brass
 * label colour and one safelight-amber accent for the next action.
 */
export const COLORS = {
  accent: '#EBA374',
  /** Text placed on an accent fill. */
  accentInk: '#1C1510',
  background: '#161413',
  deep: '#0F0E0D',
  edge: '#BFA57E',
  /** Secondary copy that still clears 4.5:1 on `background`. */
  faint: '#8E8377',
  ink: '#F3E9DA',
  line: '#37322D',
  muted: '#ABA092',
  paper: '#1F1C1A',
  /** Instant-print paper and the ink written on it. */
  print: '#ECE3D3',
  printInk: '#2A231D',
  printMuted: '#6B5F52',
} as const;

/** Concept A ("Today's moment") layout rhythm. */
export const SPACE = {
  page: 24,
  section: 16,
  panel: 17,
} as const;

/**
 * Loaded by `useAppFonts`; until they arrive the platform falls back to its
 * own serif/sans, and CJK glyphs always fall back to the system face.
 */
export const FONTS = {
  display: 'InstrumentSerif_400Regular',
  displayItalic: 'InstrumentSerif_400Regular_Italic',
  sans: 'Inter_400Regular',
  sansMedium: 'Inter_500Medium',
  sansSemiBold: 'Inter_600SemiBold',
} as const;
