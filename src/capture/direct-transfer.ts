import type AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { CAPTURE_MODES, DEFAULT_CAPTURE_MODE, type ClipUploadInput } from '../domain/video';
import { ClipUploadError, MAX_CLIP_BYTES } from './clip-uploader';
import type { AuthenticatedRequest } from './real-account-video-runtime';

export type DirectTransferSource = (
  { kind: 'blob'; blob: Blob } | { kind: 'file'; uri: string } | { kind: 'base64'; base64: string }
) & { dispose?: () => Promise<void> | void };
export interface DirectTransferIntent {
  id: string;
  cycleId: string;
  profileId: string;
  state: 'open' | 'pinned' | 'completed' | 'expired';
  expiresAt: string;
  versionId: string | null;
  contributionId: string | null;
  jobId: string | null;
}
export interface DirectTransferCapability {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}
export type DirectTransferProgress = {
  phase:
    | 'preparing'
    | 'requesting'
    | 'uploading'
    | 'reconciling'
    | 'completing'
    | 'complete'
    | 'failed'
    | 'cancelled';
  sentBytes: number;
  totalBytes: number;
};
export interface DirectTransferControl {
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  onProgress?: (progress: DirectTransferProgress) => void;
}
export interface DirectTransferOptions {
  /** Never use the authenticated app request here. */
  storageFetch?: typeof fetch;
  sha256?: (bytes: Uint8Array<ArrayBuffer>) => Promise<string>;
  readNativeFile?: (uri: string) => Promise<Uint8Array>;
  checkpointStore?: Pick<typeof AsyncStorage, 'getItem' | 'setItem'>;
  now?: () => Date;
}
interface RequestMetadata {
  mediaType: 'video' | 'photo';
  contentType: ClipUploadInput['mimeType'];
  byteLength: number;
  durationSeconds: number;
  trimStartSeconds: number;
  trimEndSeconds: number;
  mode: NonNullable<ClipUploadInput['mode']>;
  clientProcessed?: true;
  replacesContributionId?: string;
}
interface Checkpoint {
  format: 1;
  groupId: string;
  metadata: string;
  request: RequestMetadata & { sha256: string };
  intentId: string | null;
  cycleId: string | null;
  profileId: string | null;
  putStarted: boolean;
  versionId: string | null;
}
function failure(
  code: string,
  message: string,
  retryable = true,
  status?: number,
): ClipUploadError {
  return new ClipUploadError(message, { code, retryable, status });
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw failure(
      'invalid_response',
      'The transfer response could not be verified. Retry to check its status.',
    );
  return value as Record<string, unknown>;
}
function validVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    value !== 'null' &&
    value !== 'pending'
  );
}
function intent(value: unknown): DirectTransferIntent {
  const result = record(value);
  if (
    typeof result.id !== 'string' ||
    !result.id ||
    typeof result.cycleId !== 'string' ||
    !result.cycleId ||
    typeof result.profileId !== 'string' ||
    !result.profileId ||
    !['open', 'pinned', 'completed', 'expired'].includes(String(result.state)) ||
    typeof result.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(result.expiresAt)) ||
    (result.versionId !== null && !validVersion(result.versionId)) ||
    (result.state === 'pinned' && !validVersion(result.versionId)) ||
    (result.state === 'completed' &&
      (!validVersion(result.versionId) ||
        typeof result.contributionId !== 'string' ||
        !result.contributionId ||
        typeof result.jobId !== 'string' ||
        !result.jobId))
  )
    throw failure(
      'invalid_response',
      'The transfer status could not be verified. Retry to check its status.',
    );
  return result as unknown as DirectTransferIntent;
}
function metadata(input: ClipUploadInput): RequestMetadata {
  const photo = input.mediaType === 'photo';
  const start = photo ? 0 : (input.trimStartSeconds ?? 0);
  const end = photo ? 3 : (input.trimEndSeconds ?? input.durationSeconds + start);
  const duration = photo ? 3 : end - start;
  if (
    !/^[A-Za-z0-9_-]{8,100}$/.test(input.idempotencyKey) ||
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength < 1 ||
    input.byteLength > MAX_CLIP_BYTES ||
    !Number.isInteger(input.width) ||
    !Number.isInteger(input.height) ||
    input.width < 1 ||
    input.height < 1 ||
    (photo
      ? !['image/jpeg', 'image/png'].includes(input.mimeType)
      : input.mimeType !== 'video/mp4' || !input.hasAudio) ||
    !Number.isFinite(start) ||
    start < 0 ||
    !Number.isFinite(end) ||
    end > 15 ||
    duration < 0.5 ||
    duration > 15 ||
    (!photo &&
      (!Number.isFinite(input.durationSeconds) ||
        input.durationSeconds <= 0 ||
        input.durationSeconds > 15 ||
        (input.sourceDurationSeconds !== undefined &&
          (!Number.isFinite(input.sourceDurationSeconds) || end > input.sourceDurationSeconds)))) ||
    !CAPTURE_MODES.includes(input.mode ?? DEFAULT_CAPTURE_MODE) ||
    (input.clientProcessed !== undefined && typeof input.clientProcessed !== 'boolean') ||
    (input.replacesContributionId !== undefined &&
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.replacesContributionId))
  )
    throw failure(
      'validation',
      'Choose a valid photo or MP4 video with audio, within 15 seconds and 50 MB.',
      false,
    );
  return {
    mediaType: photo ? 'photo' : 'video',
    contentType: input.mimeType,
    byteLength: input.byteLength,
    durationSeconds: duration,
    trimStartSeconds: start,
    trimEndSeconds: end,
    mode: input.mode ?? DEFAULT_CAPTURE_MODE,
    ...(input.clientProcessed ? { clientProcessed: true as const } : {}),
    ...(input.replacesContributionId
      ? { replacesContributionId: input.replacesContributionId }
      : {}),
  };
}
export function decodeTransferBase64(base64: string): Uint8Array<ArrayBuffer> {
  if (
    typeof base64 !== 'string' ||
    base64.length > Math.ceil(MAX_CLIP_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  )
    throw failure('validation', 'The captured media could not be read. Capture it again.', false);
  try {
    const binary = atob(base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw failure('validation', 'The captured media could not be read. Capture it again.', false);
  }
}
export async function digestTransferBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  try {
    let digest: ArrayBuffer;
    if (Platform.OS === 'web') {
      if (!globalThis.crypto?.subtle) throw new Error();
      digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load native crypto only for the native adapter.
      const crypto = require('expo-crypto') as typeof import('expo-crypto');
      digest = await crypto.digest(crypto.CryptoDigestAlgorithm.SHA256, bytes);
    }
    if (!(digest instanceof ArrayBuffer) || digest.byteLength !== 32) throw new Error();
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  } catch {
    throw failure(
      'checksum_unavailable',
      'Media verification is unavailable. Use the secure app or retry after updating it.',
      false,
    );
  }
}
async function readNativeFile(uri: string): Promise<Uint8Array> {
  if (!uri.startsWith('file://'))
    throw failure('validation', 'Choose a local captured media file.', false);
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Evaluate the native file adapter only for file-URI sources.
  const fs = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
  const info = await fs.getInfoAsync(uri);
  if (!info.exists || info.isDirectory || info.size < 1 || info.size > MAX_CLIP_BYTES)
    throw failure('validation', 'The captured file is missing or exceeds 50 MB.', false);
  return decodeTransferBase64(
    await fs.readAsStringAsync(uri, { encoding: fs.EncodingType.Base64 }),
  );
}
function checksumHeader(sha256: string): string {
  return btoa(
    String.fromCharCode(...Uint8Array.from(sha256.match(/../g)!, (pair) => parseInt(pair, 16))),
  );
}
function capability(
  value: unknown,
  request: Checkpoint['request'],
  expiresAt: string,
  now: Date,
): DirectTransferCapability {
  const result = record(value);
  const headers = record(result.headers);
  let url: URL;
  try {
    url = new URL(String(result.url));
  } catch {
    throw failure('invalid_response', 'The private upload address could not be verified.', false);
  }
  if (
    result.method !== 'PUT' ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    typeof result.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(result.expiresAt)) ||
    Date.parse(result.expiresAt) > Date.parse(expiresAt) ||
    Date.parse(result.expiresAt) <= now.getTime()
  )
    throw failure(
      'expired',
      'The private upload has expired. Check the transfer status before starting a new capture.',
      false,
    );
  const checked: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      typeof value !== 'string' ||
      /[\r\n]/.test(value) ||
      !/^(?:content-type|cache-control|x-amz-(?:checksum-sha256|expected-bucket-owner|meta-media-ref|tagging|server-side-encryption(?:-aws-kms-key-id)?))$/.test(
        lower,
      ) ||
      checked[lower] !== undefined
    )
      throw failure('invalid_response', 'The private upload headers could not be verified.', false);
    checked[lower] = value;
  }
  if (
    checked['x-amz-tagging'] !== undefined &&
    checked['x-amz-tagging'] !== 'rewind-media-class=incoming'
  )
    throw failure('invalid_response', 'The private upload lifecycle could not be verified.', false);
  if (
    checked['content-type'] !== request.contentType ||
    checked['x-amz-checksum-sha256'] !== checksumHeader(request.sha256)
  )
    throw failure(
      'invalid_response',
      'The private upload does not match the verified media.',
      false,
    );
  return { method: 'PUT', url: String(result.url), headers: checked, expiresAt: result.expiresAt };
}

/** Retains no app credentials, signed URLs or source URI in durable checkpoints. */
export function createDirectTransferClient(
  authenticatedRequest: AuthenticatedRequest,
  options: DirectTransferOptions = {},
) {
  const hash = options.sha256 ?? digestTransferBytes;
  const storage = options.checkpointStore ?? {
    async getItem(key: string) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Disk rollback must not evaluate native checkpoint modules.
      const module = require('@react-native-async-storage/async-storage') as typeof AsyncStorage & {
        default?: typeof AsyncStorage;
      };
      return (module.default ?? module).getItem(key);
    },
    async setItem(key: string, value: string) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load native checkpoints only when direct transfer is used.
      const module = require('@react-native-async-storage/async-storage') as typeof AsyncStorage & {
        default?: typeof AsyncStorage;
      };
      await (module.default ?? module).setItem(key, value);
    },
  };
  const storageFetch = (options.storageFetch ?? globalThis.fetch).bind(globalThis);
  const now = options.now ?? (() => new Date());
  const active = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<DirectTransferIntent>;
      metadata: string;
      source: string | Blob;
    }
  >();
  const disposed = new Set<string>();
  let generation = 0;
  function cancel(groupId?: string, idempotencyKey?: string) {
    if (!groupId) generation++;
    for (const [key, operation] of active) {
      if (
        (!groupId || key.startsWith(`${encodeURIComponent(groupId)}/`)) &&
        (!idempotencyKey || key.endsWith(`/${idempotencyKey}`))
      )
        operation.controller.abort();
    }
  }
  async function transferContribution(
    groupId: string,
    input: ClipUploadInput,
    source: DirectTransferSource,
    control: DirectTransferControl = {},
  ): Promise<DirectTransferIntent> {
    const normalized = metadata(input);
    if (typeof groupId !== 'string' || !groupId || groupId.length > 128)
      throw failure('validation', 'Select a real group before uploading.', false);
    const localKey = `${encodeURIComponent(groupId)}/${input.idempotencyKey}`;
    const signature = JSON.stringify(normalized);
    const sourceIdentity =
      source.kind === 'blob' ? source.blob : source.kind === 'file' ? source.uri : source.base64;
    const running = active.get(localKey);
    if (running) {
      if (running.metadata !== signature || running.source !== sourceIdentity)
        throw failure(
          'idempotency_conflict',
          'Use a new capture key when changing the contribution.',
          false,
        );
      return running.promise;
    }
    const controller = new AbortController();
    const epoch = generation;
    const abort = () => controller.abort();
    control.signal?.addEventListener('abort', abort, { once: true });
    if (control.signal?.aborted) abort();
    const current = () => {
      if (controller.signal.aborted || epoch !== generation || control.isCurrent?.() === false)
        throw failure(
          'cancelled',
          'The transfer was cancelled. Check its status before starting another capture.',
          false,
        );
    };
    const progress = (phase: DirectTransferProgress['phase'], sentBytes = 0) => {
      current();
      control.onProgress?.({ phase, sentBytes, totalBytes: normalized.byteLength });
      current();
    };
    const root = `/real/groups/${encodeURIComponent(groupId)}/upload-intents`;
    let bytes: Uint8Array<ArrayBuffer> | null = null;
    let checkpoint: Checkpoint;
    let checkpointKey: string;
    let accepted: DirectTransferIntent | null = null;
    async function save() {
      current();
      try {
        await storage.setItem(checkpointKey, JSON.stringify(checkpoint));
      } catch {
        throw failure(
          'checkpoint_failed',
          'Transfer recovery could not be saved. Retry to check its status.',
        );
      }
      current();
    }
    async function json(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
      current();
      let response: Response;
      try {
        response = await authenticatedRequest(path, { ...init, signal: controller.signal });
      } catch (error) {
        current();
        if (error instanceof ClipUploadError) throw error;
        const status = (error as { status?: number })?.status;
        if (
          ['insecure-transport', 'response'].includes((error as { reason?: string })?.reason ?? '')
        )
          throw failure(
            'insecure_transport',
            'Open the secure Rewind address before transferring media.',
            false,
          );
        if (status === 401 || status === 403)
          throw failure(
            'authorization',
            'Sign in and select this group again to check the transfer.',
            false,
            status,
          );
        throw failure('offline', 'The transfer response was lost. Retry to check its status.');
      }
      current();
      if (response.status === 401 || response.status === 403)
        throw failure(
          'authorization',
          'Sign in and select this group again to check the transfer.',
          false,
          response.status,
        );
      let body: Record<string, unknown>;
      try {
        body = record(await response.json());
      } catch {
        throw failure(
          'invalid_response',
          'The server returned an unreadable response. Retry to check the transfer status.',
        );
      }
      current();
      if (!response.ok) {
        const code = typeof body.error === 'string' ? body.error : 'transfer_failed';
        const message =
          response.status === 401 || response.status === 403
            ? 'Sign in and select this group again to check the transfer.'
            : code.endsWith('quota_exceeded')
              ? 'This week has no remaining contribution allowance.'
              : code.endsWith('source_unavailable') || code.endsWith('storage_failed')
                ? 'Storage has not confirmed one exact uploaded version. Check status again; do not resend the media.'
                : code.endsWith('version_conflict')
                  ? 'This transfer has conflicting media versions. Keep the original capture and check its status.'
                  : code.endsWith('closed_cycle')
                    ? 'This collection has closed. Check the transfer status before capturing for the next cycle.'
                    : code.endsWith('expired')
                      ? 'The transfer has expired. Start a new capture after checking its status.'
                      : 'The contribution could not be accepted. Check its status and capture allowance.';
        throw failure(
          code,
          message,
          response.status >= 500 || response.status === 429,
          response.status,
        );
      }
      return body;
    }
    function checkedIntent(value: unknown): DirectTransferIntent {
      const result = intent(value);
      if (checkpoint.intentId && result.id !== checkpoint.intentId)
        throw failure(
          'idempotency_conflict',
          'The transfer identity changed. Check the original capture.',
          false,
        );
      if (
        (checkpoint.cycleId && result.cycleId !== checkpoint.cycleId) ||
        (checkpoint.profileId && result.profileId !== checkpoint.profileId)
      )
        throw failure(
          'idempotency_conflict',
          'The transfer cycle or owner changed. Check the original contribution.',
          false,
        );
      if (checkpoint.versionId && result.versionId && result.versionId !== checkpoint.versionId)
        throw failure(
          'version_conflict',
          'A different media version is already pinned. Check the original contribution.',
          false,
        );
      if (
        result.state === 'expired' ||
        (result.state !== 'completed' && Date.parse(result.expiresAt) <= now().getTime())
      )
        throw failure(
          'expired',
          'This transfer has expired. Capture again for the current collection.',
          false,
        );
      return result;
    }
    async function status(): Promise<DirectTransferIntent> {
      progress('reconciling');
      return checkedIntent(
        (await json(`${root}/${encodeURIComponent(checkpoint.intentId!)}`)).intent,
      );
    }
    async function reconcile(): Promise<DirectTransferIntent> {
      progress('reconciling');
      const path = `${root}/${encodeURIComponent(checkpoint.intentId!)}/reconcile`;
      const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
      try {
        return checkedIntent((await json(path, init)).intent);
      } catch (error) {
        if (!(error instanceof ClipUploadError) || !error.retryable) throw error;
        // Reconciliation may have registered the contribution before its
        // response was lost. Check status before one bounded, idempotent retry.
        const selected = await status();
        if (selected.state === 'completed' || selected.versionId) return selected;
        return checkedIntent((await json(path, init)).intent);
      }
    }
    async function readBytes(): Promise<Uint8Array<ArrayBuffer>> {
      if (bytes) return bytes;
      current();
      try {
        if (source.kind === 'blob') {
          if (source.blob.size !== normalized.byteLength) throw new Error();
          bytes = new Uint8Array(await source.blob.arrayBuffer());
        } else if (source.kind === 'file') {
          if (!source.uri.startsWith('file://')) throw new Error();
          bytes = new Uint8Array(await (options.readNativeFile ?? readNativeFile)(source.uri));
        } else bytes = decodeTransferBase64(source.base64);
      } catch (error) {
        if (error instanceof ClipUploadError) throw error;
        throw failure(
          'missing_source',
          'The captured media is no longer available. Capture again.',
          false,
        );
      }
      current();
      if (bytes.byteLength !== normalized.byteLength)
        throw failure('validation', 'The captured media size changed. Capture it again.', false);
      return bytes;
    }
    const work = (async () => {
      try {
        progress('preparing');
        const keyBytes = Uint8Array.from(
          `${encodeURIComponent(groupId)}/${input.idempotencyKey}`,
          (character) => character.charCodeAt(0),
        );
        checkpointKey = `rewind.direct-transfer.v1.${await hash(keyBytes)}`;
        current();
        let saved: string | null;
        try {
          saved = await storage.getItem(checkpointKey);
        } catch {
          throw failure(
            'checkpoint_failed',
            'Transfer recovery could not be loaded. Retry before uploading.',
          );
        }
        current();
        if (saved) {
          try {
            checkpoint = JSON.parse(saved) as Checkpoint;
            if (
              checkpoint.format !== 1 ||
              checkpoint.groupId !== groupId ||
              checkpoint.metadata !== signature ||
              !/^[a-f0-9]{64}$/.test(checkpoint.request.sha256) ||
              JSON.stringify({ ...checkpoint.request, sha256: undefined }) !== signature ||
              typeof checkpoint.putStarted !== 'boolean' ||
              (checkpoint.intentId !== null &&
                (typeof checkpoint.intentId !== 'string' ||
                  !checkpoint.intentId ||
                  checkpoint.intentId.length > 128)) ||
              (checkpoint.cycleId !== null && typeof checkpoint.cycleId !== 'string') ||
              (checkpoint.profileId !== null && typeof checkpoint.profileId !== 'string') ||
              (checkpoint.versionId !== null && !validVersion(checkpoint.versionId))
            )
              throw new Error();
          } catch {
            throw failure(
              'idempotency_conflict',
              'The capture differs from its saved transfer. Check the original contribution.',
              false,
            );
          }
        } else {
          const sha256 = await hash(await readBytes());
          current();
          if (!/^[a-f0-9]{64}$/.test(sha256))
            throw failure(
              'checksum_unavailable',
              'The media checksum could not be verified.',
              false,
            );
          checkpoint = {
            format: 1,
            groupId,
            metadata: signature,
            request: { ...normalized, sha256 },
            intentId: null,
            cycleId: null,
            profileId: null,
            putStarted: false,
            versionId: null,
          };
          await save();
        }
        let selected: DirectTransferIntent;
        let upload: unknown = null;
        if (checkpoint.intentId) selected = await status();
        else {
          progress('requesting');
          const request = { ...checkpoint.request, idempotencyKey: input.idempotencyKey };
          let body: Record<string, unknown>;
          try {
            body = await json(root, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(request),
            });
          } catch (error) {
            if (!(error instanceof ClipUploadError) || !error.retryable) throw error;
            progress('reconciling');
            body = await json(root, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(request),
            });
          }
          selected = checkedIntent(body.intent);
          upload = body.upload;
          checkpoint.intentId = selected.id;
          checkpoint.cycleId = selected.cycleId;
          checkpoint.profileId = selected.profileId;
          await save();
        }
        if (selected.state === 'completed') accepted = selected;
        else if (selected.versionId) {
          checkpoint.versionId = selected.versionId;
          await save();
        } else if (checkpoint.versionId) {
          // A lost completion request may never have reached the CAS. The
          // version recorded from the PUT is still safe to complete exactly.
        } else if (checkpoint.putStarted) {
          selected = await reconcile();
          if (selected.state === 'completed') accepted = selected;
          else if (selected.versionId) {
            checkpoint.versionId = selected.versionId;
            await save();
          } else
            throw failure(
              'version_unknown',
              'Storage could not confirm one exact uploaded version. Check status; do not resend the media.',
            );
        } else {
          if (upload === null) {
            progress('requesting');
            const body = await json(root, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...checkpoint.request, idempotencyKey: input.idempotencyKey }),
            });
            selected = checkedIntent(body.intent);
            upload = body.upload;
            if (selected.state === 'completed') accepted = selected;
            else if (selected.versionId) checkpoint.versionId = selected.versionId;
          }
          if (!accepted && !checkpoint.versionId) {
            const prepared = await readBytes();
            if ((await hash(prepared)) !== checkpoint.request.sha256)
              throw failure(
                'idempotency_conflict',
                'The media bytes changed. Use a new capture key.',
                false,
              );
            current();
            const signed = capability(upload, checkpoint.request, selected.expiresAt, now());
            checkpoint.putStarted = true;
            await save();
            capability(signed, checkpoint.request, selected.expiresAt, now());
            progress('uploading');
            try {
              const response = await storageFetch(signed.url, {
                method: 'PUT',
                headers: signed.headers,
                body: source.kind === 'blob' ? source.blob : prepared.buffer,
                signal: controller.signal,
                credentials: 'omit',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
                mode: 'cors',
                cache: 'no-store',
              });
              current();
              if (!response.ok)
                throw failure(
                  response.status === 403 ? 'storage_expired' : 'storage_failed',
                  response.status === 403
                    ? 'The private upload was rejected or expired. Check its status before retrying.'
                    : 'Storage could not confirm the upload. Check its status before retrying.',
                  true,
                  response.status,
                );
              const versionId = response.headers.get('x-amz-version-id');
              if (!validVersion(versionId))
                throw failure(
                  'version_unknown',
                  'Storage did not expose the uploaded version. Check status; do not resend the media.',
                );
              checkpoint.versionId = versionId;
              await save();
              progress('uploading', normalized.byteLength);
            } catch (error) {
              current();
              selected = await status();
              if (selected.state === 'completed') accepted = selected;
              else if (selected.versionId) {
                checkpoint.versionId = selected.versionId;
                await save();
              } else {
                if (error instanceof ClipUploadError && error.code === 'storage_expired')
                  throw error;
                selected = await reconcile();
                if (selected.state === 'completed') accepted = selected;
                else if (selected.versionId) {
                  checkpoint.versionId = selected.versionId;
                  await save();
                } else
                  throw failure(
                    'version_unknown',
                    'Storage could not confirm one exact uploaded version. Check status; do not resend the media.',
                  );
              }
            }
          }
        }
        if (!accepted) {
          if (!checkpoint.versionId)
            throw failure(
              'version_unknown',
              'The uploaded version is not yet known. Check its status again.',
            );
          progress('completing', normalized.byteLength);
          try {
            accepted = checkedIntent(
              (
                await json(`${root}/${encodeURIComponent(checkpoint.intentId!)}/complete`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ versionId: checkpoint.versionId }),
                })
              ).intent,
            );
          } catch (error) {
            if (!(error instanceof ClipUploadError) || !error.retryable) throw error;
            selected = await status();
            if (selected.state === 'completed') accepted = selected;
            else {
              progress('completing', normalized.byteLength);
              accepted = checkedIntent(
                (
                  await json(`${root}/${encodeURIComponent(checkpoint.intentId!)}/complete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ versionId: checkpoint.versionId }),
                  })
                ).intent,
              );
            }
          }
        }
        if (accepted.state !== 'completed')
          throw failure(
            'invalid_response',
            'The contribution is not yet confirmed. Retry to check its status.',
          );
        current();
        checkpoint.versionId = accepted.versionId;
        await save();
        bytes = null;
        if (!disposed.has(localKey) && source.dispose) {
          try {
            await source.dispose();
          } catch {
            throw failure(
              'source_disposal_failed',
              'The contribution is registered, but its local file could not be removed. Retry cleanup.',
            );
          }
          disposed.add(localKey);
          current();
        }
        progress('complete', normalized.byteLength);
        return accepted;
      } catch (error) {
        bytes = null;
        if (controller.signal.aborted || epoch !== generation || control.isCurrent?.() === false)
          throw failure(
            'cancelled',
            'The transfer was cancelled. Check its status before starting another capture.',
            false,
          );
        control.onProgress?.({ phase: 'failed', sentBytes: 0, totalBytes: normalized.byteLength });
        throw error instanceof ClipUploadError
          ? error
          : failure(
              'transfer_failed',
              'The transfer could not be confirmed. Retry to check its status.',
            );
      } finally {
        control.signal?.removeEventListener('abort', abort);
      }
    })();
    active.set(localKey, {
      controller,
      promise: work,
      metadata: signature,
      source: sourceIdentity,
    });
    try {
      return await work;
    } finally {
      if (active.get(localKey)?.promise === work) active.delete(localKey);
    }
  }
  return { transferContribution, cancel, dispose: () => cancel() };
}
