import { MAX_CLIP_UPLOAD_ATTEMPTS } from '../src/capture/clip-uploader';
import {
  CAPTURE_INTERRUPTION_EVENTS,
  EXHAUSTED_UPLOAD_MESSAGE,
  INTERRUPTED_UPLOAD_MESSAGE,
  UNRECOVERABLE_UPLOAD_MESSAGE,
  decideInterruption,
  isLiveProcessingStatus,
  reconcileContributionStatus,
} from '../src/capture/capture-interruption';
import type { ContributionStatus } from '../src/capture/contribution-status';

const storedStatus: ContributionStatus = {
  contributionId: 'contribution-1',
  createdAt: '2026-09-20T00:00:00.000Z',
  durationSeconds: 4,
  jobId: 'job-1',
  retryable: false,
  state: 'processing',
};

describe('capture interruption decisions', () => {
  it('defines a decision for every interruption event', () => {
    for (const event of CAPTURE_INTERRUPTION_EVENTS) {
      expect(Object.keys(decideInterruption(event)).sort()).toEqual(
        [
          'cancelRecording',
          'cancelUploadRequest',
          'clearAcceptedMetadata',
          'clearContributionStatus',
          'discardPreview',
          'recheckAccess',
          'reconcileContributionStatus',
          'releaseLocalCapture',
          'retainLocalCaptureForRetry',
          'sweepOrphanedFiles',
        ].sort(),
      );
    }
  });

  it('never both releases and retains the local capture for one event', () => {
    for (const event of CAPTURE_INTERRUPTION_EVENTS) {
      const decision = decideInterruption(event);
      expect(decision.releaseLocalCapture && decision.retainLocalCaptureForRetry).toBe(false);
    }
  });

  it('keeps the local clip for a bounded retry when the app is backgrounded', () => {
    const decision = decideInterruption('background');
    expect(decision).toMatchObject({
      cancelRecording: true,
      cancelUploadRequest: true,
      releaseLocalCapture: false,
      retainLocalCaptureForRetry: true,
    });
  });

  it('reconciles the contribution and re-checks access on foreground', () => {
    expect(decideInterruption('foreground')).toMatchObject({
      cancelRecording: false,
      reconcileContributionStatus: true,
      recheckAccess: true,
    });
  });

  it('discards transient files but retains accepted metadata on a route change', () => {
    expect(decideInterruption('route-change')).toMatchObject({
      clearAcceptedMetadata: false,
      discardPreview: true,
      releaseLocalCapture: true,
    });
  });

  it('sweeps unreachable files and reconciles status after a reload or restart', () => {
    for (const event of ['reload', 'restart'] as const) {
      expect(decideInterruption(event)).toMatchObject({
        clearAcceptedMetadata: false,
        reconcileContributionStatus: true,
        sweepOrphanedFiles: true,
      });
    }
  });

  it('clears the contribution status on sign-out without erasing accepted stills', () => {
    expect(decideInterruption('sign-out')).toMatchObject({
      clearAcceptedMetadata: false,
      clearContributionStatus: true,
      sweepOrphanedFiles: true,
    });
  });

  it('erases accepted stills and cached media on reset', () => {
    expect(decideInterruption('reset')).toMatchObject({
      clearAcceptedMetadata: true,
      clearContributionStatus: true,
      sweepOrphanedFiles: true,
    });
  });
});

describe('interrupted contribution reconciliation', () => {
  it('turns a stored processing record into a bounded retry when the clip is still local', () => {
    const reconciled = reconcileContributionStatus(storedStatus, {
      attemptsRemaining: MAX_CLIP_UPLOAD_ATTEMPTS - 1,
      resumable: true,
    });
    expect(reconciled).toMatchObject({
      message: INTERRUPTED_UPLOAD_MESSAGE,
      retryable: true,
      state: 'failed',
    });
  });

  it('reports an unrecoverable interruption when only durable metadata survived', () => {
    const reconciled = reconcileContributionStatus(
      { ...storedStatus, state: 'queued' },
      { attemptsRemaining: MAX_CLIP_UPLOAD_ATTEMPTS, resumable: false },
    );
    expect(reconciled).toMatchObject({
      message: UNRECOVERABLE_UPLOAD_MESSAGE,
      retryable: false,
      state: 'failed',
    });
  });

  it('makes an exhausted retry budget terminal instead of offering a dead action', () => {
    const reconciled = reconcileContributionStatus(
      { ...storedStatus, message: 'temporary', retryable: true, state: 'failed' },
      { attemptsRemaining: 0, resumable: true },
    );
    expect(reconciled).toMatchObject({
      message: EXHAUSTED_UPLOAD_MESSAGE,
      retryable: false,
    });
  });

  it('leaves a sealed contribution and an absent status untouched', () => {
    const sealed = reconcileContributionStatus(
      { ...storedStatus, state: 'sealed' },
      { attemptsRemaining: 0, resumable: false },
    );
    expect(sealed).toMatchObject({ state: 'sealed' });
    expect(reconcileContributionStatus(null, { attemptsRemaining: 1, resumable: true })).toBeNull();
  });

  it('identifies only queued and processing records as live-looking', () => {
    expect(isLiveProcessingStatus({ ...storedStatus, state: 'processing' })).toBe(true);
    expect(isLiveProcessingStatus({ ...storedStatus, state: 'queued' })).toBe(true);
    expect(isLiveProcessingStatus({ ...storedStatus, state: 'sealed' })).toBe(false);
    expect(isLiveProcessingStatus({ ...storedStatus, state: 'failed' })).toBe(false);
    expect(isLiveProcessingStatus(null)).toBe(false);
  });
});
