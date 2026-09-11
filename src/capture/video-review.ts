import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  CAPTURE_MODES,
  type CaptureMode,
  type RecordedClip,
} from '../domain/video';

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

export const PENDING_CLIP_METADATA_KEY = '@rewind/pending-clip-metadata-v1';

export const CAPTURE_MODE_LABELS: Record<CaptureMode, string> = {
  'high-contrast': 'High Contrast',
  'soft-focus': 'Soft Focus',
};

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

function isPendingMetadata(value: unknown): value is PendingClipMetadata {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PendingClipMetadata>;
  return (
    typeof candidate.clipId === 'string' &&
    typeof candidate.durationSeconds === 'number' &&
    typeof candidate.startSeconds === 'number' &&
    typeof candidate.endSeconds === 'number' &&
    typeof candidate.createdAt === 'string' &&
    CAPTURE_MODES.includes(candidate.mode as CaptureMode) &&
    validateTrimBounds(candidate.startSeconds, candidate.endSeconds, candidate.durationSeconds).ok
  );
}

export class AsyncStoragePendingClipMetadataStore implements PendingClipMetadataStore {
  async save(metadata: PendingClipMetadata): Promise<void> {
    const current = await this.read();
    await AsyncStorage.setItem(
      PENDING_CLIP_METADATA_KEY,
      JSON.stringify({ ...current, [metadata.clipId]: metadata }),
    );
  }

  async load(clipId: string): Promise<PendingClipMetadata | null> {
    const current = await this.read();
    const value = current[clipId];
    return value ? { ...value } : null;
  }

  async clear(clipId: string): Promise<void> {
    const current = await this.read();
    delete current[clipId];
    if (Object.keys(current).length === 0) await AsyncStorage.removeItem(PENDING_CLIP_METADATA_KEY);
    else await AsyncStorage.setItem(PENDING_CLIP_METADATA_KEY, JSON.stringify(current));
  }

  private async read(): Promise<Record<string, PendingClipMetadata>> {
    const raw = await AsyncStorage.getItem(PENDING_CLIP_METADATA_KEY);
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => isPendingMetadata(value)),
      ) as Record<string, PendingClipMetadata>;
    } catch {
      return {};
    }
  }
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
  private mode: CaptureMode = 'soft-focus';

  constructor(
    clip: RecordedClip,
    metadataStore: PendingClipMetadataStore,
    now = () => new Date(),
  ) {
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
