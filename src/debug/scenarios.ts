/**
 * Screen states that the Settings debug mode can force, mirroring the state
 * selector of the rewind-ui-ab design study. `live` always means real data.
 * These are presentation overrides only: they never write runtime, session,
 * group, contribution, or media data.
 */
export const DEBUG_SCREENS = {
  home: [
    'live',
    'loading',
    'empty',
    'denied',
    'error',
    'processing',
    'delayed',
    'released',
    'quota',
  ],
  entry: ['live', 'loading', 'error'],
  group: ['live', 'error', 'loading'],
  join: ['live', 'error', 'loading'],
  camera: ['live', 'permission', 'denied', 'loading', 'preview', 'saved', 'error'],
  video: [
    'live',
    'permission',
    'denied',
    'preview',
    'uploading',
    'queued',
    'processing',
    'sealed',
    'error',
    'quota',
  ],
  chat: ['live', 'loading', 'empty', 'denied', 'error'],
  archive: ['live', 'loading', 'empty', 'denied', 'error', 'processing', 'delayed', 'released'],
  settings: ['live', 'error', 'loading'],
} as const;

export type DebugScreen = keyof typeof DEBUG_SCREENS;
export type DebugScenario<S extends DebugScreen = DebugScreen> = (typeof DEBUG_SCREENS)[S][number];
export type DebugRuntimeMode = 'live' | 'offline';

export const DEBUG_SCREEN_ORDER: DebugScreen[] = [
  'home',
  'camera',
  'video',
  'chat',
  'archive',
  'settings',
  'group',
  'join',
  'entry',
];

export const DEBUG_SCREEN_LABELS: Record<DebugScreen, string> = {
  home: 'Home / Cycle',
  entry: 'Demo entry',
  group: 'Create group',
  join: 'Join group',
  camera: 'Camera / Still',
  video: 'Camera / Clip',
  chat: 'Chat',
  archive: 'Archive',
  settings: 'Settings',
};

export const DEBUG_SCENARIO_LABELS: Record<string, string> = {
  live: 'Live data',
  loading: 'Loading',
  empty: 'Empty',
  denied: 'Access denied',
  error: 'Error / retry',
  processing: 'Processing',
  delayed: 'Delayed reveal',
  released: 'Released',
  quota: 'Allowance used',
  permission: 'Permission needed',
  preview: 'Review',
  saved: 'Saved locally',
  uploading: 'Uploading',
  queued: 'Queued',
  sealed: 'Sealed',
};

/** Short description of what each forced state shows, for the debug sheet. */
export const DEBUG_SCENARIO_HINTS: Partial<Record<DebugScreen, Partial<Record<string, string>>>> = {
  home: {
    quota: 'Allowance at zero; Add a moment is disabled.',
    processing: 'Group film is compiling; no playback.',
  },
  camera: {
    preview: 'Fixture still under review; nothing is captured.',
    saved: 'Local acceptance only; allowance unchanged.',
  },
  video: {
    uploading: 'Sample upload; cancel returns to review.',
    sealed: 'Metadata-only sealed contribution. Also shown on Home.',
    quota: 'Non-retryable limit. Also shown on Home.',
  },
};

export function isDebugScreen(value: string): value is DebugScreen {
  return Object.hasOwn(DEBUG_SCREENS, value);
}

export function isScenarioFor(screen: DebugScreen, value: string): boolean {
  return (DEBUG_SCREENS[screen] as readonly string[]).includes(value);
}
