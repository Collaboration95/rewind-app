function readExpoRuntimeUrl(): string | undefined {
  // Expo replaces EXPO_PUBLIC_* references at bundle time. The guard keeps
  // tests and non-Expo tooling safe when process.env is unavailable.
  if (typeof process === 'undefined') return undefined;
  return process.env.EXPO_PUBLIC_LOCAL_BASE_URL;
}

function readExpoInviteWebOrigin(): string | undefined {
  if (typeof process === 'undefined') return undefined;
  return process.env.EXPO_PUBLIC_INVITE_WEB_ORIGIN;
}

/** Public HTTPS origin that serves the web invite route for native shares. */
export function getConfiguredInviteWebOrigin(): string | null {
  const value = readExpoInviteWebOrigin()?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function getLocalRuntimeBaseUrl(): string | null {
  const value = readExpoRuntimeUrl()?.trim();
  return value ? value.replace(/\/$/, '') : null;
}
