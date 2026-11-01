// Shared clip limits, server-probed metadata shape and idempotency-key hashing.
import { createHash } from 'node:crypto';

import type { RewindDatabase } from '../db';

export const MAX_CLIP_BYTES = 50 * 1024 * 1024;
export const MAX_CLIP_DURATION_SECONDS = 15;

export interface ServerClipMetadata {
  sourceUri: string;
  mediaType?: 'video' | 'photo';
  mimeType: 'video/mp4' | 'image/jpeg' | 'image/png';
  byteLength: number;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  verifiedAt?: string;
}

export function keyHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export function recordClipMediaMetadata(
  database: RewindDatabase,
  metadata: ServerClipMetadata,
  verifiedAt = new Date(),
): void {
  const mediaType = metadata.mediaType ?? 'video';
  if (
    !metadata.sourceUri ||
    (mediaType === 'video' && metadata.mimeType !== 'video/mp4') ||
    (mediaType === 'photo' && !['image/jpeg', 'image/png'].includes(metadata.mimeType)) ||
    !Number.isInteger(metadata.byteLength) ||
    metadata.byteLength <= 0 ||
    metadata.byteLength > MAX_CLIP_BYTES ||
    !Number.isFinite(metadata.durationSeconds) ||
    metadata.durationSeconds <= 0 ||
    metadata.durationSeconds > MAX_CLIP_DURATION_SECONDS ||
    !Number.isInteger(metadata.width) ||
    metadata.width <= 0 ||
    !Number.isInteger(metadata.height) ||
    metadata.height <= 0 ||
    metadata.hasAudio !== true
  ) {
    throw new RangeError('Server media metadata does not describe an acceptable clip.');
  }
  database
    .prepare(
      `INSERT INTO media_metadata
        (source_uri, mime_type, byte_length, duration_seconds, width, height, has_audio, verified_at, media_type)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(source_uri) DO UPDATE SET
         mime_type = excluded.mime_type,
         byte_length = excluded.byte_length,
         duration_seconds = excluded.duration_seconds,
         width = excluded.width,
         height = excluded.height,
         has_audio = excluded.has_audio,
         verified_at = excluded.verified_at,
         media_type = excluded.media_type`,
    )
    .run(
      metadata.sourceUri,
      metadata.mimeType,
      metadata.byteLength,
      metadata.durationSeconds,
      metadata.width,
      metadata.height,
      metadata.verifiedAt ?? verifiedAt.toISOString(),
      mediaType,
    );
}
