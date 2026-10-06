// Build-time version flags (#491). Hosted dev and local runs set
// DISPLAY_CURRENT_VERSION=true; a main (prod) build leaves it off. Check
// DISPLAY_CURRENT_VERSION to vary dev-only UI. Expo inlines only literal
// process.env.EXPO_PUBLIC_* references, so keep them spelled out.
const hasEnv = typeof process !== 'undefined';

export const DISPLAY_CURRENT_VERSION =
  hasEnv && process.env.EXPO_PUBLIC_DISPLAY_CURRENT_VERSION === 'true';

/** `<branch>-<short commit hash>`, or `local` when the build did not set it. */
export const CURRENT_VERSION = (hasEnv && process.env.EXPO_PUBLIC_CURRENT_VERSION) || 'local';
