import type { ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';

export interface MediaServingLease {
  release(): void;
}

/** Process-wide bounds for anonymous integrity snapshots held during media requests. */
export class MediaServingBudget {
  private active = 0;
  private reservedBytes = 0;

  constructor(
    readonly maxConcurrent = 3,
    /** Keep 32 MiB of a 128 MiB runtime tmpfs free for unrelated temporary work. */
    readonly maxSnapshotBytes = 96 * 1024 * 1024,
  ) {}

  tryAcquire(byteLength: number): MediaServingLease | null {
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength <= 0 ||
      byteLength > this.maxSnapshotBytes ||
      this.active >= this.maxConcurrent ||
      this.reservedBytes + byteLength > this.maxSnapshotBytes
    )
      return null;
    this.active += 1;
    this.reservedBytes += byteLength;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        this.reservedBytes = Math.max(0, this.reservedBytes - byteLength);
      },
    };
  }

  snapshot(): { active: number; reservedBytes: number } {
    return { active: this.active, reservedBytes: this.reservedBytes };
  }
}

export const mediaServingBudget = new MediaServingBudget();

/** Keep capacity reserved until the anonymous snapshot's read descriptor closes. */
export function releaseBudgetWhenSnapshotCloses(
  lease: MediaServingLease,
  stream: Readable,
  response: ServerResponse,
): void {
  stream.once('close', () => lease.release());
  response.once('close', () => {
    if (!stream.destroyed) stream.destroy();
  });
}
