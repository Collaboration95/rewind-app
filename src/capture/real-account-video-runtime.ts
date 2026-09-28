import type { ClipUploadInput, PendingClipUpload } from '../domain/video';
import { parseContributionLedgerPage, type ContributionLedgerPage } from '../domain/contributions';
import { LocalRuntimeError, type RuntimeClient } from '../runtime/local-runtime-client';

export type AuthenticatedRequest = (path: string, init?: RequestInit) => Promise<Response>;

async function readResponse<T>(response: Response): Promise<T> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    // Keep malformed responses in the same bounded, recoverable error path.
  }
  if (!response.ok) {
    throw new LocalRuntimeError(
      typeof body.message === 'string' ? body.message : 'The media request could not be completed.',
      response.status,
      typeof body.error === 'string' ? body.error : undefined,
    );
  }
  return body as T;
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new LocalRuntimeError('The captured clip could not be prepared for upload.');
  }
}

/**
 * RuntimeClient adapter for a real account. Its positional session argument
 * is intentionally ignored; the authenticated request supplies the opaque
 * native bearer token or first-party web cookie and never serializes it.
 */
export function createRealAccountVideoRuntimeClient(
  authenticatedRequest: AuthenticatedRequest,
): Pick<
  RuntimeClient,
  'baseUrl' | 'stageClipSource' | 'uploadClip' | 'cancelClipUpload' | 'processClipJob'
> & {
  getContributionLedger(groupId: string): Promise<ContributionLedgerPage>;
  deleteContribution(sessionId: string, groupId: string, contributionId: string): Promise<void>;
  stagePhotoSource(
    sessionId: string,
    groupId: string,
    idempotencyKey: string,
    base64: string,
    mimeType: 'image/jpeg' | 'image/png',
  ): Promise<{ uri: string; byteLength: number }>;
} {
  const groupQuery = (groupId: string) => `groupId=${encodeURIComponent(groupId)}`;
  return {
    baseUrl: '',
    async getContributionLedger(groupId) {
      const response = await authenticatedRequest(`/contributions?${groupQuery(groupId)}`);
      const body = await readResponse<unknown>(response);
      const page = parseContributionLedgerPage(body);
      if (!page)
        throw new LocalRuntimeError(
          'Contributions could not be loaded.',
          undefined,
          'invalid_contribution_ledger',
        );
      return page;
    },
    async deleteContribution(_sessionId, groupId, contributionId) {
      await readResponse(
        await authenticatedRequest(
          `/contributions/${encodeURIComponent(contributionId)}?${groupQuery(groupId)}`,
          { method: 'DELETE' },
        ),
      );
    },
    async stageClipSource(_sessionId, groupId, idempotencyKey, base64) {
      const bytes = decodeBase64(base64);
      const body = await readResponse<{ source: { uri: string; byteLength: number } }>(
        await authenticatedRequest(
          `/contributions/upload/source?${groupQuery(groupId)}&idempotencyKey=${encodeURIComponent(idempotencyKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'video/mp4' },
            body: bytes as unknown as BodyInit,
          },
        ),
      );
      return body.source;
    },
    async stagePhotoSource(_sessionId, groupId, idempotencyKey, base64, mimeType) {
      const bytes = decodeBase64(base64);
      const body = await readResponse<{ source: { uri: string; byteLength: number } }>(
        await authenticatedRequest(
          `/contributions/upload/source?${groupQuery(groupId)}&idempotencyKey=${encodeURIComponent(idempotencyKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': mimeType },
            body: bytes as unknown as BodyInit,
          },
        ),
      );
      return body.source;
    },
    async uploadClip(_sessionId, groupId, input: ClipUploadInput): Promise<PendingClipUpload> {
      const body = await readResponse<{ upload: PendingClipUpload }>(
        await authenticatedRequest(`/contributions/upload?${groupQuery(groupId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }),
      );
      return body.upload;
    },
    async cancelClipUpload(_sessionId, groupId, jobId) {
      await readResponse(
        await authenticatedRequest(
          `/contributions/upload/${encodeURIComponent(jobId)}?${groupQuery(groupId)}`,
          { method: 'DELETE' },
        ),
      );
    },
    async processClipJob(_sessionId, groupId, jobId) {
      const path = `/contributions/jobs/${encodeURIComponent(jobId)}/process?${groupQuery(groupId)}`;
      const response = await authenticatedRequest(path, { method: 'POST' });
      if (response.status === 409) {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const status = await readResponse<{ clip: PendingClipUpload['job'] }>(
            await authenticatedRequest(
              `/clips/${encodeURIComponent(jobId)}?${groupQuery(groupId)}`,
            ),
          );
          if (status.clip.status === 'ready') return status.clip;
          if (status.clip.status === 'failed' || status.clip.status === 'cancelled') {
            throw new LocalRuntimeError(
              'The clip could not be processed. Retry the job.',
              503,
              'media_processing_failed',
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        const status = await readResponse<{ clip: PendingClipUpload['job'] }>(
          await authenticatedRequest(`/clips/${encodeURIComponent(jobId)}?${groupQuery(groupId)}`),
        );
        return status.clip;
      }
      const body = await readResponse<{ job: PendingClipUpload['job'] }>(response);
      return body.job;
    },
  };
}
