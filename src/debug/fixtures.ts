import type { ContributionStatus } from '../capture/contribution-status';

/**
 * Labelled, metadata-only fixtures for debug previews. They never contain a
 * file URI, media path, or anything that could address real media.
 */
const FIXTURE_CREATED_AT = '2026-09-27T10:24:00.000Z';

export function debugContributionStatus(videoScenario: string | null): ContributionStatus | null {
  switch (videoScenario) {
    case 'queued':
      return { createdAt: FIXTURE_CREATED_AT, retryable: false, state: 'queued' };
    case 'processing':
      return { createdAt: FIXTURE_CREATED_AT, retryable: false, state: 'processing' };
    case 'sealed':
      return {
        createdAt: FIXTURE_CREATED_AT,
        deletionAvailability: 'available',
        durationSeconds: 2,
        retryable: false,
        state: 'sealed',
      };
    case 'error':
      return { createdAt: FIXTURE_CREATED_AT, retryable: true, state: 'failed' };
    case 'quota':
      return {
        createdAt: FIXTURE_CREATED_AT,
        reason: 'quota_exceeded',
        retryable: false,
        state: 'failed',
      };
    default:
      return null;
  }
}

export const DEBUG_STILL_METADATA = {
  format: 'jpg',
  height: 900,
  width: 1200,
} as const;
