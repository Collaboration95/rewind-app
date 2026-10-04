import { resolve } from 'node:path';
import type { RuntimeConfig } from '../config';
import type { RuntimeServerOptions } from '../http';
import { createMediaRuntime, type MediaRuntime } from './runtime-store';

/** One adapter shared by HTTP, worker and lifecycle; creation sends no requests. */
export async function configureRuntimeMedia(
  config: RuntimeConfig,
  create: typeof createMediaRuntime = createMediaRuntime,
): Promise<{ options: RuntimeServerOptions; close(): void }> {
  if (!config.media) return { options: {}, close() {} };
  const runtime: MediaRuntime = await create(config.media);
  return {
    options: {
      mediaStore: runtime.store,
      mediaEnvironment: config.media.environment,
      ...(runtime.uploadTransport
        ? {
            uploadIntents: {
              store: runtime.store,
              transport: runtime.uploadTransport,
              environment: config.media.environment,
              scratchDir: resolve(config.dataDir, 'media', 'intent-scratch'),
              ffmpegBin: config.ffmpegBin,
            },
          }
        : {}),
    },
    close: () => runtime.close(),
  };
}
