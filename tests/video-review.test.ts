import { CAPTURE_MODES, type RecordedClip } from '../src/domain/video';
import {
  ClipReviewSession,
  InMemoryPendingClipMetadataStore,
  validateTrimBounds,
} from '../src/capture/video-review';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const clip: RecordedClip = {
  durationSeconds: 12,
  format: 'mp4',
  hasAudio: true,
  height: 1280,
  source: 'camera',
  sourceUri: 'file://clip.mp4',
  width: 720,
};

describe('video review and trim', () => {
  it.each([
    [0, 10, 12, true],
    [-1, 10, 12, false],
    [1, 13, 12, false],
    [5, 4, 12, false],
    [1, 1.2, 12, false],
  ])('validates trim bounds %s–%s in %ss', (start, end, duration, valid) => {
    expect(validateTrimBounds(start, end, duration).ok).toBe(valid);
  });

  it('persists trim and an original mode as pending metadata', async () => {
    const store = new InMemoryPendingClipMetadataStore();
    const review = new ClipReviewSession(clip, store, () => new Date('2026-09-10T12:00:00.000Z'));
    expect(review.setTrim(2, 8)).toEqual({ ok: true, bounds: { startSeconds: 2, endSeconds: 8 } });
    review.setMode(CAPTURE_MODES[1]);
    const saved = await review.savePending('clip-1');
    expect(saved).toMatchObject({
      clipId: 'clip-1',
      endSeconds: 8,
      mode: 'high-contrast',
      startSeconds: 2,
    });
    expect(await store.load('clip-1')).toEqual(saved);
    await review.retake();
    expect(await store.load('clip-1')).toBeNull();
  });
});
