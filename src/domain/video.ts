export const MAX_CLIP_DURATION_SECONDS = 15;

export type ClipSource = 'camera' | 'demo-fixture';

export interface RecordedClip {
  sourceUri: string;
  format: 'mp4';
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
    status: 'pending' | 'cancelled';
    createdAt: string;
  };
  existing: boolean;
}
