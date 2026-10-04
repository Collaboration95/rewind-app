export const MAX_CLIP_DURATION_SECONDS = 15;

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

/** The four original retro looks offered for new captures. */
export type CaptureMode = 'disposable-flash' | 'ccd' | '8mm' | 'vhs';

export const CAPTURE_MODES: readonly CaptureMode[] = ['disposable-flash', 'ccd', '8mm', 'vhs'];

export const DEFAULT_CAPTURE_MODE: CaptureMode = 'ccd';

export const CAPTURE_MODE_LABELS: Record<CaptureMode, string> = {
  'disposable-flash': 'Disposable Flash',
  ccd: 'Compact Digital',
  '8mm': '8mm Home Movie',
  vhs: 'VHS Camcorder',
};

export interface ClipUploadInput {
  mediaType?: 'video' | 'photo';
  idempotencyKey: string;
  sourceUri: string;
  mimeType: 'video/mp4' | 'image/jpeg' | 'image/png';
  byteLength: number;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: true;
  /** Review metadata forwarded to the local processing worker. */
  mode?: CaptureMode;
  /**
   * The look was already applied on this device (web), so the server only
   * normalizes. Without it the server applies `mode` (native apps).
   */
  clientProcessed?: boolean;
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
