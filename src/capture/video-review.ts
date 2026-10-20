import {
  CAPTURE_MODES,
  DEFAULT_CAPTURE_MODE,
  type CaptureMode,
  type RecordedClip,
} from '../domain/video';

export { CAPTURE_MODE_LABELS } from '../domain/video';

export interface TrimBounds {
  startSeconds: number;
  endSeconds: number;
}

export interface PendingClipMetadata extends TrimBounds {
  clipId: string;
  durationSeconds: number;
  mode: CaptureMode;
  createdAt: string;
}

export interface PendingClipMetadataStore {
  save(metadata: PendingClipMetadata): Promise<void>;
  load(clipId: string): Promise<PendingClipMetadata | null>;
  clear(clipId: string): Promise<void>;
}

// Older builds persisted pending clip metadata here; reset still clears it.
export const PENDING_CLIP_METADATA_KEY = '@rewind/pending-clip-metadata-v1';

export type TrimValidation =
  | { ok: true; bounds: TrimBounds }
  | { ok: false; reason: 'invalid' | 'outside_clip' | 'too_short' };

export function validateTrimBounds(
  startSeconds: number,
  endSeconds: number,
  durationSeconds: number,
): TrimValidation {
  if (![startSeconds, endSeconds, durationSeconds].every(Number.isFinite)) {
    return { ok: false, reason: 'invalid' };
  }
  if (durationSeconds <= 0 || startSeconds < 0 || endSeconds > durationSeconds) {
    return { ok: false, reason: 'outside_clip' };
  }
  if (endSeconds <= startSeconds) return { ok: false, reason: 'invalid' };
  if (endSeconds - startSeconds < 0.5) return { ok: false, reason: 'too_short' };
  return { ok: true, bounds: { startSeconds, endSeconds } };
}

export function clampTrimmedPlaybackTime(
  seconds: number,
  startSeconds: number,
  endSeconds: number,
): number {
  if (!Number.isFinite(seconds)) return startSeconds;
  return Math.min(endSeconds, Math.max(startSeconds, seconds));
}

export class InMemoryPendingClipMetadataStore implements PendingClipMetadataStore {
  private readonly values = new Map<string, PendingClipMetadata>();
  async save(metadata: PendingClipMetadata): Promise<void> {
    this.values.set(metadata.clipId, { ...metadata });
  }
  async load(clipId: string): Promise<PendingClipMetadata | null> {
    const value = this.values.get(clipId);
    return value ? { ...value } : null;
  }
  async clear(clipId: string): Promise<void> {
    this.values.delete(clipId);
  }
}

export class ClipReviewSession {
  private readonly clip: RecordedClip;
  private readonly now: () => Date;
  private readonly metadataStore: PendingClipMetadataStore;
  private readonly defaultClipId: string;
  private pendingClipId: string | null = null;
  private bounds: TrimBounds;
  private mode: CaptureMode = DEFAULT_CAPTURE_MODE;

  constructor(clip: RecordedClip, metadataStore: PendingClipMetadataStore, now = () => new Date()) {
    this.clip = { ...clip };
    this.metadataStore = metadataStore;
    this.now = now;
    this.defaultClipId = `pending-clip-${Math.abs(hashClipId(clip.sourceUri))}`;
    this.bounds = { startSeconds: 0, endSeconds: clip.durationSeconds };
  }

  getClip(): RecordedClip {
    return { ...this.clip };
  }

  getReview(): PendingClipMetadata {
    return {
      clipId: this.pendingClipId ?? this.defaultClipId,
      createdAt: this.now().toISOString(),
      durationSeconds: this.clip.durationSeconds,
      mode: this.mode,
      ...this.bounds,
    };
  }

  setTrim(startSeconds: number, endSeconds: number): TrimValidation {
    const result = validateTrimBounds(startSeconds, endSeconds, this.clip.durationSeconds);
    if (result.ok) this.bounds = result.bounds;
    return result;
  }

  setMode(mode: CaptureMode): void {
    if (!CAPTURE_MODES.includes(mode)) throw new Error('Choose an original capture mode.');
    this.mode = mode;
  }

  async savePending(clipId = this.clip.sourceUri): Promise<PendingClipMetadata> {
    this.pendingClipId = clipId === this.clip.sourceUri ? this.defaultClipId : clipId;
    const metadata = { ...this.getReview(), clipId: this.pendingClipId };
    await this.metadataStore.save(metadata);
    return { ...metadata };
  }

  async retake(): Promise<void> {
    await this.metadataStore.clear(this.pendingClipId ?? this.defaultClipId);
    this.pendingClipId = null;
  }
}

function hashClipId(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return hash;
}
