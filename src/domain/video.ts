export const MAX_CLIP_DURATION_SECONDS = 15;

export type ClipSource = 'camera' | 'demo-fixture';

export interface RecordedClip {
  sourceUri: string;
  format: 'mp4';
  width: number;
  height: number;
  durationSeconds: number;
  hasAudio: boolean;
  source: ClipSource;
}

export type CaptureMode = 'soft-focus' | 'high-contrast';

export const CAPTURE_MODES: readonly CaptureMode[] = ['soft-focus', 'high-contrast'];
