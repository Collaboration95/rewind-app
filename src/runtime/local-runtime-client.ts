import type { ClipUploadInput, PendingClipUpload } from '../domain/video';

/**
 * Upload transport used by the capture screens. The real-account adapter
 * (`createRealAccountVideoRuntimeClient`) implements it with bearer-token
 * requests; its positional session argument is ignored.
 */
export interface RuntimeClient {
  readonly baseUrl: string;
  uploadClip?(
    sessionId: string,
    groupId: string,
    input: ClipUploadInput,
    signal?: AbortSignal,
  ): Promise<PendingClipUpload>;
  stageClipSource?(
    sessionId: string,
    groupId: string,
    idempotencyKey: string,
    base64: string,
    signal?: AbortSignal,
  ): Promise<{ uri: string; byteLength: number }>;
  cancelClipUpload?(sessionId: string, groupId: string, jobId: string): Promise<void>;
  processClipJob?(
    sessionId: string,
    groupId: string,
    jobId: string,
  ): Promise<PendingClipUpload['job']>;
  deleteContribution?(
    sessionId: string,
    groupId: string,
    contributionId: string,
  ): Promise<{ contributionId: string; jobId: string; restored: { count: 1; seconds: number } }>;
}

export class LocalRuntimeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly details?: { field?: string; reason?: string },
  ) {
    super(message);
    this.name = 'LocalRuntimeError';
  }
}
