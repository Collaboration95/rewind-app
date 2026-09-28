export const MAX_CLIP_DURATION_SECONDS = 15;

/**
 * Renders a duration to one decimal place everywhere it reaches the screen.
 * Recorded and server-verified durations are floating-point seconds (e.g.
 * 5.843333333333334); this is the one place that rounds them for display so
 * every screen agrees on the same precision.
 */
export function formatDurationSeconds(value: number): string {
  return `${value.toFixed(1)} seconds`;
}

export type ClipSource = 'camera' | 'demo-fixture' | 'file';

export interface RecordedClip {
  sourceUri: string;
  format: 'mp4';
  mimeType: 'video/mp4';
  width: number;
  height: number;
  durationSeconds: number;
  hasAudio: boolean;
  byteLength?: number;
  source: ClipSource;
}

export type CaptureMode = 'soft-focus' | 'high-contrast';

export const CAPTURE_MODES: readonly CaptureMode[] = ['soft-focus', 'high-contrast'];

export interface ClipUploadInput {
  idempotencyKey: string;
  sourceUri: string;
  mimeType: 'video/mp4';
  byteLength: number;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: true;
  /** Review metadata forwarded to the local processing worker. */
  mode?: CaptureMode;
  trimStartSeconds?: number;
  trimEndSeconds?: number;
  sourceDurationSeconds?: number;
  /** Explicit tombstone selected by the member for this replacement upload. */
  replacesContributionId?: string;
}

export interface PendingClipUpload {
  contribution: {
    id: string;
    cycleId: string;
    groupId: string;
    memberId: string;
    durationSeconds: number;
    createdAt: string;
  };
  job: {
    id: string;
    groupId: string;
    contributionId: string;
    kind: 'clip';
    status: 'pending' | 'processing' | 'ready' | 'failed' | 'cancelled';
    createdAt: string;
  };
  existing: boolean;
}
