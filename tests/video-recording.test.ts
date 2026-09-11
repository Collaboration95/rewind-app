import { MAX_CLIP_DURATION_SECONDS } from '../src/domain/video';
import {
  BoundedVideoRecordingSession,
  validateRecordedClip,
  VideoRecordingError,
} from '../src/capture/video-recording';
import type { RecordedClip } from '../src/domain/video';

const clip: RecordedClip = {
  durationSeconds: 12,
  format: 'mp4',
  hasAudio: true,
  height: 1280,
  source: 'camera',
  sourceUri: 'file://clip.mp4',
  width: 720,
};

describe('bounded video recording', () => {
  it('passes the 15-second cap to the platform and returns a valid portrait clip', async () => {
    const platform = {
      cancelRecording: jest.fn(),
      recordClip: jest.fn().mockResolvedValue(clip),
      stopRecording: jest.fn(),
    };
    const session = new BoundedVideoRecordingSession(platform);

    await expect(session.start()).resolves.toEqual(clip);
    expect(platform.recordClip).toHaveBeenCalledWith(MAX_CLIP_DURATION_SECONDS);
    expect(session.getState()).toEqual({ status: 'complete', clip });
  });

  it.each([
    [{ ...clip, durationSeconds: 16 }, '15 seconds'],
    [{ ...clip, width: 1280, height: 720 }, 'portrait'],
    [{ ...clip, hasAudio: false }, 'audio'],
  ])('rejects an invalid capture %o', (invalid, message) => {
    expect(() => validateRecordedClip(invalid)).toThrow(message);
  });

  it('stops and cancels an in-flight recording without accepting a clip', async () => {
    let resolveRecording: (value: RecordedClip) => void = () => undefined;
    const platform = {
      cancelRecording: jest.fn(),
      recordClip: jest
        .fn()
        .mockImplementation(
          () => new Promise<RecordedClip>((resolve) => (resolveRecording = resolve)),
        ),
      stopRecording: jest.fn(),
    };
    const session = new BoundedVideoRecordingSession(platform);
    const pending = session.start();
    session.setElapsed(20);
    expect(session.getState()).toEqual({
      status: 'recording',
      elapsedSeconds: MAX_CLIP_DURATION_SECONDS,
    });
    session.stop();
    session.cancel();
    expect(platform.stopRecording).toHaveBeenCalledTimes(1);
    expect(platform.cancelRecording).toHaveBeenCalledTimes(1);
    expect(session.getState()).toEqual({ status: 'cancelled' });
    resolveRecording(clip);
    await expect(pending).rejects.toThrow('cancelled');
    expect(session.getState()).toEqual({ status: 'cancelled' });
  });

  it('rejects a second start while a recording is active', async () => {
    const platform = {
      cancelRecording: jest.fn(),
      recordClip: jest.fn(() => new Promise<RecordedClip>(() => undefined)),
      stopRecording: jest.fn(),
    };
    const session = new BoundedVideoRecordingSession(platform);
    void session.start();
    await expect(session.start()).rejects.toBeInstanceOf(VideoRecordingError);
  });
});
