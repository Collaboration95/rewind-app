import type { ClipUploadInput, PendingClipUpload } from '../domain/video';
import { parseContributionLedgerPage, type ContributionLedgerPage } from '../domain/contributions';
import { LocalRuntimeError, type RuntimeClient } from '../runtime/local-runtime-client';
import {
  createDirectTransferClient,
  decodeTransferBase64,
  type DirectTransferControl,
  type DirectTransferOptions,
  type DirectTransferSource,
} from './direct-transfer';

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
  options: DirectTransferOptions & { transferMode?: 'direct' | 'server' } = {},
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
  transferContribution: ReturnType<typeof createDirectTransferClient>['transferContribution'];
  cancelDirectTransfers(groupId?: string, idempotencyKey?: string): void;
  dispose(): void;
} {
  const groupQuery = (groupId: string) => `groupId=${encodeURIComponent(groupId)}`;
  // Direct transfer is selected explicitly by the real capture integration;
  // disk rollback retains the existing factory behavior.
  const transferMode = options.transferMode ?? 'server';
  const direct = createDirectTransferClient(authenticatedRequest, options);
  const staged = new Map<
    string,
    { groupId: string; key: string; base64: string; mimeType: string }
  >();
  const stageLocal = (groupId: string, key: string, base64: string, mimeType: string) => {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(key) || !groupId || groupId.length > 128)
      throw new LocalRuntimeError(
        'The capture key or selected group is invalid.',
        400,
        'validation',
      );
    const bytes = decodeTransferBase64(base64);
    const uri = `direct-transfer://${encodeURIComponent(groupId)}/${key}`;
    const existing = staged.get(uri);
    if (existing && (existing.base64 !== base64 || existing.mimeType !== mimeType))
      throw new LocalRuntimeError(
        'Use a new capture key when changing the media.',
        409,
        'idempotency_conflict',
      );
    staged.set(uri, { groupId, key, base64, mimeType });
    return { uri, byteLength: bytes.byteLength };
  };
  return {
    baseUrl: '',
    transferContribution(
      groupId: string,
      input: ClipUploadInput,
      source: DirectTransferSource,
      control?: DirectTransferControl,
    ) {
      return direct.transferContribution(groupId, input, source, control);
    },
    cancelDirectTransfers(groupId, key) {
      direct.cancel(groupId, key);
      for (const [uri, item] of staged)
        if ((!groupId || item.groupId === groupId) && (!key || item.key === key))
          staged.delete(uri);
    },
    dispose() {
      direct.dispose();
      staged.clear();
    },
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
    async stageClipSource(_sessionId, groupId, idempotencyKey, base64, signal?: AbortSignal) {
      if (transferMode === 'direct')
        return stageLocal(groupId, idempotencyKey, base64, 'video/mp4');
      const bytes = decodeBase64(base64);
      const body = await readResponse<{ source: { uri: string; byteLength: number } }>(
        await authenticatedRequest(
          `/contributions/upload/source?${groupQuery(groupId)}&idempotencyKey=${encodeURIComponent(idempotencyKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'video/mp4' },
            body: bytes as unknown as BodyInit,
            ...(signal ? { signal } : {}),
          },
        ),
      );
      return body.source;
    },
    async stagePhotoSource(_sessionId, groupId, idempotencyKey, base64, mimeType) {
      if (transferMode === 'direct') return stageLocal(groupId, idempotencyKey, base64, mimeType);
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
    async uploadClip(
      _sessionId,
      groupId,
      input: ClipUploadInput,
      signal?: AbortSignal,
    ): Promise<PendingClipUpload> {
      if (transferMode === 'direct') {
        const held = staged.get(input.sourceUri);
        let source: DirectTransferSource;
        if (held) {
          if (
            held.groupId !== groupId ||
            held.key !== input.idempotencyKey ||
            held.mimeType !== input.mimeType
          )
            throw new LocalRuntimeError(
              'The captured media belongs to another transfer.',
              403,
              'forbidden',
            );
          source = { kind: 'base64', base64: held.base64 };
        } else if (input.sourceUri.startsWith('file://'))
          source = { kind: 'file', uri: input.sourceUri };
        else if (input.sourceUri.startsWith('blob:')) {
          const response = await fetch(input.sourceUri, { credentials: 'omit', signal });
          if (!response.ok)
            throw new LocalRuntimeError(
              'The browser capture could not be read.',
              400,
              'missing_source',
            );
          source = { kind: 'blob', blob: await response.blob() };
        } else if (input.sourceUri.startsWith('direct-transfer://')) {
          // A completed checkpoint can be recovered without rereading disposed
          // source bytes. An uncompleted transfer still fails its byte check.
          source = { kind: 'base64', base64: '' };
        } else
          throw new LocalRuntimeError(
            'Choose local captured media before uploading.',
            400,
            'missing_source',
          );
        const completed = await direct.transferContribution(groupId, input, source, { signal });
        staged.delete(input.sourceUri);
        // The intent receipt intentionally contains no invented timestamps.
        // Preserve RuntimeClient's legacy receipt using authoritative ledger metadata.
        const body = await readResponse<unknown>(
          await authenticatedRequest(`/contributions?${groupQuery(groupId)}`),
        );
        const page = parseContributionLedgerPage(body);
        const entry = page?.entries.find(
          (item) =>
            item.contributionId === completed.contributionId && item.jobId === completed.jobId,
        );
        if (
          !page ||
          page.cycleId !== completed.cycleId ||
          page.memberId !== completed.profileId ||
          !entry
        )
          throw new LocalRuntimeError(
            'The contribution is registered. Refresh its status before uploading again.',
            503,
            'contribution_registered',
          );
        return {
          contribution: {
            id: entry.contributionId,
            cycleId: page.cycleId,
            groupId,
            memberId: page.memberId,
            durationSeconds: entry.durationSeconds,
            createdAt: entry.createdAt,
          },
          job: {
            id: entry.jobId!,
            contributionId: entry.contributionId,
            groupId,
            kind: 'clip',
            status:
              entry.state === 'sealed'
                ? 'ready'
                : entry.state === 'processing'
                  ? 'processing'
                  : entry.state === 'failed'
                    ? 'failed'
                    : entry.state === 'deleted' || entry.state === 'replaced'
                      ? 'cancelled'
                      : 'pending',
            createdAt: entry.createdAt,
          },
          existing: true,
        };
      }
      if (input.sourceUri.startsWith('blob:')) {
        const response = await fetch(input.sourceUri, { credentials: 'omit', signal });
        if (!response.ok)
          throw new LocalRuntimeError(
            'The browser capture could not be read.',
            400,
            'missing_source',
          );
        const blob = await response.blob();
        const stagedBody = await readResponse<{ source: { uri: string; byteLength: number } }>(
          await authenticatedRequest(
            `/contributions/upload/source?${groupQuery(groupId)}&idempotencyKey=${encodeURIComponent(input.idempotencyKey)}`,
            { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: blob, signal },
          ),
        );
        input = {
          ...input,
          sourceUri: stagedBody.source.uri,
          byteLength: stagedBody.source.byteLength,
        };
      }
      const body = await readResponse<{ upload: PendingClipUpload }>(
        await authenticatedRequest(`/contributions/upload?${groupQuery(groupId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          ...(signal ? { signal } : {}),
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
