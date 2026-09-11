import { MAX_CLIP_DURATION_SECONDS, type RecordedClip } from '../domain/video';

export interface VideoRecordingPlatform {
  recordClip(maxDurationSeconds: number): Promise<RecordedClip>;
  stopRecording(): void;
  cancelRecording(): void;
}

export type VideoRecordingState =
  | { status: 'idle' }
  | { status: 'recording'; elapsedSeconds: number }
  | { status: 'complete'; clip: RecordedClip }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string };

export class VideoRecordingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoRecordingError';
  }
}

export function validateRecordedClip(clip: RecordedClip): void {
  if (!clip.sourceUri) throw new VideoRecordingError('The recorded clip has no local file.');
  if (clip.format !== 'mp4') throw new VideoRecordingError('The clip must be an MP4 video.');
  if (!Number.isFinite(clip.durationSeconds) || clip.durationSeconds <= 0) {
    throw new VideoRecordingError('The recorded clip has no valid duration.');
  }
  if (clip.durationSeconds > MAX_CLIP_DURATION_SECONDS) {
    throw new VideoRecordingError('Recordings must be 15 seconds or shorter.');
  }
  if (!Number.isFinite(clip.width) || !Number.isFinite(clip.height) || clip.width >= clip.height) {
    throw new VideoRecordingError('Recordings must use portrait orientation.');
  }
  if (!clip.hasAudio) throw new VideoRecordingError('Microphone audio is required for a clip.');
}

export class BoundedVideoRecordingSession {
  private state: VideoRecordingState = { status: 'idle' };
  private generation = 0;

  constructor(private readonly platform: VideoRecordingPlatform) {}

  getState(): VideoRecordingState {
    return this.state.status === 'complete'
      ? { status: 'complete', clip: { ...this.state.clip } }
      : { ...this.state };
  }

  async start(): Promise<RecordedClip> {
    if (this.state.status === 'recording') {
      throw new VideoRecordingError('A clip is already recording.');
    }
    const generation = ++this.generation;
    this.state = { status: 'recording', elapsedSeconds: 0 };
    try {
      const clip = await this.platform.recordClip(MAX_CLIP_DURATION_SECONDS);
      if (generation !== this.generation || this.state.status !== 'recording') {
        throw new VideoRecordingError('The recording was cancelled.');
      }
      validateRecordedClip(clip);
      this.state = { status: 'complete', clip: { ...clip } };
      return { ...clip };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The clip could not be recorded.';
      this.state = { status: 'failed', message };
      throw error instanceof VideoRecordingError ? error : new VideoRecordingError(message);
    }
  }

  setElapsed(elapsedSeconds: number): void {
    if (this.state.status !== 'recording') return;
    this.state = {
      status: 'recording',
      elapsedSeconds: Math.min(MAX_CLIP_DURATION_SECONDS, Math.max(0, elapsedSeconds)),
    };
  }

  stop(): void {
    if (this.state.status === 'recording') this.platform.stopRecording();
  }

  cancel(): void {
    if (this.state.status === 'recording') {
      this.platform.cancelRecording();
      this.generation += 1;
      this.state = { status: 'cancelled' };
    }
  }

  reset(): void {
    this.generation += 1;
    this.state = { status: 'idle' };
  }
}
