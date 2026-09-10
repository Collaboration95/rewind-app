import { LocalRuntimeClient, type RuntimeClient } from './local-runtime-client';

export interface ConfiguredRuntime {
  baseUrl: string;
  client: RuntimeClient;
}

function readExpoRuntimeUrl(): string | undefined {
  // Expo replaces EXPO_PUBLIC_* references at bundle time. The guard keeps
  // tests and non-Expo tooling safe when process.env is unavailable.
  if (typeof process === 'undefined') return undefined;
  return process.env.EXPO_PUBLIC_LOCAL_BASE_URL;
}

export function getLocalRuntimeBaseUrl(): string | null {
  const value = readExpoRuntimeUrl()?.trim();
  return value ? value.replace(/\/$/, '') : null;
}

export function createConfiguredRuntime(): ConfiguredRuntime | null {
  const baseUrl = getLocalRuntimeBaseUrl();
  return baseUrl ? { baseUrl, client: new LocalRuntimeClient(baseUrl) } : null;
}
