import { statfs } from 'node:fs/promises';

type FilesystemCapacity =
  | { state: 'available'; totalBytes: number; availableBytes: number }
  | { state: 'unavailable'; totalBytes: null; availableBytes: null };

const unavailable = (): FilesystemCapacity => ({
  state: 'unavailable',
  totalBytes: null,
  availableBytes: null,
});

/** Fixed projection only; invalid or unrepresentable metadata stays unknown. */
export function capacityFromStatfs(metadata: unknown): FilesystemCapacity {
  if (!metadata || typeof metadata !== 'object') return unavailable();
  const { bsize, blocks, bavail } = metadata as Record<string, unknown>;
  if (
    typeof bsize !== 'bigint' ||
    typeof blocks !== 'bigint' ||
    typeof bavail !== 'bigint' ||
    bsize <= 0n ||
    blocks < 0n ||
    bavail < 0n ||
    bavail > blocks
  )
    return unavailable();
  const total = bsize * blocks;
  const available = bsize * bavail;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return unavailable();
  return { state: 'available', totalBytes: Number(total), availableBytes: Number(available) };
}

/** Operator-only explicit path; statfs reads metadata, never directory/media contents. */
export async function filesystemCapacity(
  path: string,
  probe: (path: string) => Promise<unknown> = (target) => statfs(target, { bigint: true }),
): Promise<FilesystemCapacity> {
  try {
    return capacityFromStatfs(await probe(path));
  } catch {
    // No exception, path, mount identity or raw statfs payload enters output.
    return unavailable();
  }
}
