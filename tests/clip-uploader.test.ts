import {
  ClipUploadError,
  ClipUploadSession,
  validateClipUploadInput,
} from '../src/capture/clip-uploader';
import type { ClipUploadInput, PendingClipUpload } from '../src/domain/video';

const input: ClipUploadInput = {
  byteLength: 2048,
  durationSeconds: 8,
  hasAudio: true,
  height: 1280,
  idempotencyKey: 'retryable-1',
  mimeType: 'video/mp4',
  sourceUri: 'file://clip.mp4',
  width: 720,
};

const upload: PendingClipUpload = {
  contribution: {
    createdAt: '2026-09-10T12:00:00.000Z',
    cycleId: 'cycle-1',
    durationSeconds: 8,
    groupId: 'group-1',
    id: 'contribution-1',
    memberId: 'member-1',
  },
  existing: false,
  job: {
    contributionId: 'contribution-1',
    createdAt: '2026-09-10T12:00:00.000Z',
    groupId: 'group-1',
    id: 'job-1',
    kind: 'clip',
    status: 'pending',
  },
};

describe('local clip upload lifecycle', () => {
  it('rejects invalid media before transport and reports progress for a valid retryable upload', async () => {
    const transport = {
      cancelClipUpload: jest.fn().mockResolvedValue(undefined),
      uploadClip: jest.fn().mockResolvedValue(upload),
    };
    expect(validateClipUploadInput({ ...input, durationSeconds: 16 })).toContain('15 seconds');
    const session = new ClipUploadSession(transport);
    const progress: string[] = [];
    await expect(session.upload(input, (state) => progress.push(state.status))).resolves.toEqual(
      upload,
    );
    expect(progress).toEqual(['validating', 'uploading', 'complete']);
    expect(session.getProgress()).toMatchObject({ status: 'complete', percent: 100 });
    await expect(session.retry()).resolves.toEqual(upload);
    expect(transport.uploadClip).toHaveBeenCalledTimes(2);
  });

  it('cancels an in-flight upload and cancels a server job if it races completion', async () => {
    let resolveUpload: (value: PendingClipUpload) => void = () => undefined;
    const transport = {
      cancelClipUpload: jest.fn().mockResolvedValue(undefined),
      uploadClip: jest.fn(
        () => new Promise<PendingClipUpload>((resolve) => (resolveUpload = resolve)),
      ),
    };
    const session = new ClipUploadSession(transport);
    const pending = session.upload(input);
    await session.cancel();
    resolveUpload(upload);
    await expect(pending).rejects.toBeInstanceOf(ClipUploadError);
    expect(transport.cancelClipUpload).toHaveBeenCalledWith('job-1');
    expect(session.getProgress()).toEqual({ status: 'cancelled', percent: 0 });
  });

  it('marks cancellation locally before a runtime cancellation settles', async () => {
    let resolveCancellation: () => void = () => undefined;
    const transport = {
      cancelClipUpload: jest.fn(
        () => new Promise<void>((resolve) => (resolveCancellation = resolve)),
      ),
      uploadClip: jest.fn().mockResolvedValue(upload),
    };
    const session = new ClipUploadSession(transport);
    await session.upload(input);

    const cancellation = session.cancel();
    expect(session.getProgress()).toEqual({ status: 'cancelled', percent: 0 });
    resolveCancellation();
    await cancellation;
  });
});
