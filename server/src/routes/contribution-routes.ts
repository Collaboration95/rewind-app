// /contributions/* uploads, processing, ledger and /clips/:id status.
import { mediaDir } from '../config';
import { existsSync } from 'node:fs';

import { deleteContribution } from '../contributions';
import {
  ContributionLedgerQueryError,
  listContributionLedger,
  parseLedgerLimit,
  parseLedgerState,
} from '../contributions/ledger';
import { getContribution } from '../db';
import { probeClipWithFfmpeg, probePhotoWithFfmpeg } from '../ffmpeg';
import { processClipJob } from '../jobs';
import { maybeCleanupOrphanedStagedSources } from '../jobs/staged-cleanup-scheduler';
import {
  acquireStagedSourceLock,
  cancelClipUpload,
  claimStagedSource,
  cleanupStagedSource,
  createClipUpload,
  findStagedSource,
  markStagedSourceReady,
  reclaimStagedSource,
  recordClipMediaMetadata,
  stagedSourceId,
  stagedSourcePath,
  type ClipUploadInput,
} from '../media';

import {
  MAX_STAGED_SOURCE_BYTES,
  RequestPolicyError,
  cleanupFailedStagedClaim,
  requestBody,
  stageSourceBody,
} from './body';
import { MediaRouteContext, Route } from './context';
import { acquireRequestCapacity } from './limits';
import { mediaIdentityIsCurrent, requireAuthorisedMediaGroup } from './media-access';
import { decodePathSegment, sendJson, sendNotFound, sendSessionRequired } from './respond';

async function handleUploadSource(ctx: MediaRouteContext): Promise<void> {
  const { request, response, config, database, now, requestLimiters, url } = ctx;
  const groupId = url.searchParams.get('groupId');
  const idempotencyKey = url.searchParams.get('idempotencyKey') ?? '';
  const identity = requireAuthorisedMediaGroup(request, database, response, config, now(), groupId);
  if (!identity) return;
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
    sendJson(response, config, 400, {
      error: 'upload_invalid_key',
      message: 'Provide a retryable upload key.',
    });
    return;
  }
  const contentType = String(request.headers['content-type'] ?? '')
    .split(';', 1)[0]
    .trim();
  const photoType = contentType === 'image/jpeg' || contentType === 'image/png';
  if (contentType !== 'video/mp4' && contentType !== 'application/octet-stream' && !photoType) {
    sendJson(response, config, 400, {
      error: 'upload_invalid_media',
      message: 'Upload a JPEG or PNG photo, or an MP4 clip.',
    });
    return;
  }
  const releaseIntakeCapacity = acquireRequestCapacity(
    requestLimiters.intake,
    request,
    response,
    config,
  );
  if (!releaseIntakeCapacity) return;
  const stagingDir = mediaDir(config, 'staging');
  let releaseStagingLock: (() => void) | null = await acquireStagedSourceLock(stagingDir);
  try {
    await maybeCleanupOrphanedStagedSources(database, stagingDir);
    const sourceId = stagedSourceId(idempotencyKey);
    const sourceUri = `staged://${sourceId}`;
    const existingBeforeClaim = findStagedSource(database, sourceUri);
    const nextGeneration = existingBeforeClaim
      ? Math.max(1, existingBeforeClaim.claimGeneration)
      : 1;
    const sourcePath = stagedSourcePath(sourceUri, stagingDir, nextGeneration);
    if (!sourcePath) return sendNotFound(response, config);
    const claim = claimStagedSource(
      database,
      identity.groupId,
      identity.memberId,
      idempotencyKey,
      now(),
      sourcePath,
    );
    if (!claim.ok) {
      sendJson(response, config, 409, {
        error: 'upload_source_conflict',
        message: 'That upload key is already owned by another capture.',
      });
      return;
    }
    // The intake route always writes to the deterministic server-owned path;
    // never trust a path carried by a legacy/database row as a write target.
    let claimedSourcePath = claim.source.sourcePath ?? sourcePath;
    let claimGeneration = claim.source.claimGeneration;
    let canStage = !claim.existing;
    if (claim.existing && (claim.source.status === 'staged' || claim.source.status === 'pending')) {
      const existingMetadata = findStagedSource(database, sourceUri);
      if (
        existingMetadata?.status === 'staged' &&
        existingMetadata.byteLength &&
        existsSync(claimedSourcePath)
      ) {
        sendJson(response, config, 200, {
          source: { id: sourceId, uri: sourceUri, byteLength: existingMetadata.byteLength },
        });
        return;
      }
      if (
        existingMetadata?.status === 'pending' &&
        (!existingMetadata.claimExpiresAt ||
          Date.parse(existingMetadata.claimExpiresAt) > now().getTime())
      ) {
        sendJson(response, config, 409, {
          error: 'upload_source_conflict',
          message: 'That upload is already being staged. Retry after it completes.',
        });
        return;
      }
      // A successful claim without a file is recoverable after interruption.
      // Reclaiming increments the generation and assigns a new physical path,
      // fencing any stale body/probe callback from the old request.
      const reclaimed = reclaimStagedSource(
        database,
        identity.groupId,
        identity.memberId,
        idempotencyKey,
        stagedSourcePath(sourceUri, stagingDir, claimGeneration + 1) ?? sourcePath,
        now(),
      );
      if (!reclaimed.ok || !reclaimed.source.sourcePath) {
        sendJson(response, config, 409, {
          error: 'upload_source_conflict',
          message: 'That upload source changed while it was being recovered.',
        });
        return;
      }
      claimedSourcePath = reclaimed.source.sourcePath;
      claimGeneration = reclaimed.source.claimGeneration;
      canStage = true;
    }
    // A pending claim with a source path belongs to an intake request that is
    // already consuming its body. Reject the duplicate before it can write a
    // distinct payload over the same deterministic destination.
    if (!canStage && claim.existing && claim.source.status === 'pending') {
      sendJson(response, config, 409, {
        error: 'upload_source_conflict',
        message: 'That upload is already being staged. Retry after it completes.',
      });
      return;
    }
    // Let another same-key request observe the committed pending claim and
    // return a conflict while this request consumes its body.
    releaseStagingLock();
    releaseStagingLock = null;
    try {
      await stageSourceBody(
        request,
        stagingDir,
        claimedSourcePath,
        config,
        photoType ? 10 * 1024 * 1024 : MAX_STAGED_SOURCE_BYTES,
      );
      const probed = photoType
        ? await probePhotoWithFfmpeg(config.ffmpegBin, claimedSourcePath, stagingDir)
        : await probeClipWithFfmpeg(config.ffmpegBin, claimedSourcePath, stagingDir);
      if (photoType && probed.mimeType !== contentType) {
        throw new Error('photo type does not match its verified bytes');
      }
      database.exec('BEGIN');
      try {
        if (!mediaIdentityIsCurrent(request, database, identity, now())) {
          database.exec('ROLLBACK');
          cleanupFailedStagedClaim(
            database,
            sourceUri,
            claimedSourcePath,
            claimGeneration,
            stagingDir,
          );
          return sendSessionRequired(response, config);
        }
        recordClipMediaMetadata(database, {
          sourceUri,
          mediaType: photoType ? 'photo' : 'video',
          ...probed,
          // FFprobe's stat is authoritative; the stream byte count is only a
          // transport guard and is never persisted as media truth.
          byteLength: probed.byteLength,
          verifiedAt: now().toISOString(),
        });
        if (
          !markStagedSourceReady(
            database,
            sourceUri,
            probed.byteLength,
            claimedSourcePath,
            claimGeneration,
          )
        ) {
          throw new Error('staged source claim was superseded');
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      sendJson(response, config, 201, {
        source: { id: sourceId, uri: sourceUri, byteLength: probed.byteLength },
      });
    } catch (error) {
      cleanupFailedStagedClaim(database, sourceUri, claimedSourcePath, claimGeneration, stagingDir);
      if (error instanceof RequestPolicyError) throw error;
      sendJson(response, config, 400, {
        error: 'upload_staging_failed',
        message: 'The clip source could not be staged. Try again.',
      });
    }
  } finally {
    releaseIntakeCapacity();
    releaseStagingLock?.();
    releaseStagingLock = null;
  }
}

async function handleCreateUpload(ctx: MediaRouteContext): Promise<void> {
  const { request, response, config, database, now, url } = ctx;
  const groupId = url.searchParams.get('groupId');
  const identity = requireAuthorisedMediaGroup(request, database, response, config, now(), groupId);
  if (!identity) return;
  const body = await requestBody(request, config);
  if (!mediaIdentityIsCurrent(request, database, identity, now())) {
    return sendSessionRequired(response, config);
  }
  if (
    body?.replacesContributionId !== undefined &&
    body.replacesContributionId !== null &&
    typeof body.replacesContributionId !== 'string'
  ) {
    sendJson(response, config, 400, {
      error: 'upload_invalid_replacement_target',
      message: 'Choose a contribution that can be replaced.',
    });
    return;
  }
  const input: ClipUploadInput = {
    mediaType: body?.mediaType === 'photo' ? 'photo' : 'video',
    idempotencyKey: typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : '',
    sourceUri: typeof body?.sourceUri === 'string' ? body.sourceUri : '',
    mimeType: typeof body?.mimeType === 'string' ? body.mimeType : '',
    byteLength: typeof body?.byteLength === 'number' ? body.byteLength : Number.NaN,
    durationSeconds: typeof body?.durationSeconds === 'number' ? body.durationSeconds : Number.NaN,
    width: typeof body?.width === 'number' ? body.width : Number.NaN,
    height: typeof body?.height === 'number' ? body.height : Number.NaN,
    hasAudio: body?.hasAudio === true,
    ...(typeof body?.mode === 'string' ? { mode: body.mode as ClipUploadInput['mode'] } : {}),
    ...(body?.clientProcessed !== undefined
      ? { clientProcessed: body.clientProcessed as boolean }
      : {}),
    ...(typeof body?.trimStartSeconds === 'number'
      ? { trimStartSeconds: body.trimStartSeconds }
      : typeof body?.startSeconds === 'number'
        ? { startSeconds: body.startSeconds }
        : {}),
    ...(typeof body?.trimEndSeconds === 'number'
      ? { trimEndSeconds: body.trimEndSeconds }
      : typeof body?.endSeconds === 'number'
        ? { endSeconds: body.endSeconds }
        : {}),
    ...(typeof body?.sourceDurationSeconds === 'number'
      ? { sourceDurationSeconds: body.sourceDurationSeconds }
      : {}),
    ...(typeof body?.replacesContributionId === 'string'
      ? { replacesContributionId: body.replacesContributionId }
      : {}),
  };
  const result = createClipUpload(database, identity.groupId, identity.memberId, input, now(), {
    stagingDir: mediaDir(config, 'staging'),
    requireVerifiedMetadata: true,
  });
  if (!result.ok) {
    if (result.reason === 'not_found') return sendNotFound(response, config);
    // Key validation happens before capability ownership is established. Do
    // not let an invalid-key request delete a URI supplied by another
    // capture (or an arbitrary caller-controlled URI).
    if (result.reason !== 'invalid_key') {
      cleanupStagedSource(database, input.sourceUri, mediaDir(config, 'staging'));
    }
    const conflict = result.reason === 'quota_exceeded' || result.reason === 'replacement_conflict';
    sendJson(response, config, conflict ? 409 : 400, {
      error: `upload_${result.reason}`,
      message:
        result.reason === 'quota_exceeded'
          ? 'This cycle has no remaining contribution allowance.'
          : result.reason === 'replacement_conflict'
            ? 'That contribution can no longer be replaced.'
            : result.reason === 'invalid_replacement_target'
              ? 'Choose a contribution that can be replaced.'
              : result.reason === 'invalid_key'
                ? 'Provide a retryable upload key.'
                : result.reason === 'invalid_mode'
                  ? 'Choose a supported original capture mode.'
                  : 'The clip must be an MP4 video with audio, within 15 seconds and 50 MB.',
    });
    return;
  }
  sendJson(response, config, result.upload.existing ? 200 : 201, {
    upload: result.upload,
  });
}

function handleCancelUpload(ctx: MediaRouteContext, match: RegExpMatchArray): void {
  const { request, response, config, database, now, url } = ctx;
  const jobId = decodePathSegment(match[1], response, config);
  if (jobId === null) return;
  const groupId = url.searchParams.get('groupId');
  const identity = requireAuthorisedMediaGroup(request, database, response, config, now(), groupId);
  if (!identity) return;
  const stagingDir = mediaDir(config, 'staging');
  const result = cancelClipUpload(database, identity.groupId, identity.memberId, jobId, {
    stagingDir,
  });
  if (!result.ok) return sendNotFound(response, config);
  sendJson(response, config, 200, { cancelled: true, ...result });
}

async function handleProcessJob(ctx: MediaRouteContext, match: RegExpMatchArray): Promise<void> {
  const { request, response, config, database, options, now, requestLimiters, url } = ctx;
  const jobId = decodePathSegment(match[1], response, config);
  if (jobId === null) return;
  const groupId = url.searchParams.get('groupId');
  const identity = requireAuthorisedMediaGroup(request, database, response, config, now(), groupId);
  if (!identity) return;
  const releaseProcessingCapacity = acquireRequestCapacity(
    requestLimiters.processing,
    request,
    response,
    config,
  );
  if (!releaseProcessingCapacity) return;
  let result: Awaited<ReturnType<typeof processClipJob>>;
  try {
    result = await processClipJob(database, {
      mediaStore: options.mediaStore,
      mediaEnvironment: options.mediaEnvironment,
      jobId,
      groupId: identity.groupId,
      ffmpegBin: config.ffmpegBin,
      stagingDir: mediaDir(config, 'staging'),
      outputDir: mediaDir(config, 'processed'),
      actorMemberId: identity.memberId,
    });
  } finally {
    releaseProcessingCapacity();
  }
  if (!result.ok && result.reason === 'not_found') return sendNotFound(response, config);
  if (!result.ok && result.reason === 'already_processing') {
    sendJson(response, config, 409, {
      error: 'media_processing',
      message: result.message,
    });
    return;
  }
  if (!result.ok) {
    sendJson(response, config, 503, {
      error: 'media_processing_failed',
      message: result.message,
    });
    return;
  }
  sendJson(response, config, 200, { job: { id: result.jobId, status: result.status } });
}

function handleClipStatus(ctx: MediaRouteContext, match: RegExpMatchArray): void {
  const { request, response, config, database, now, url } = ctx;
  const jobId = decodePathSegment(match[1], response, config);
  if (jobId === null) return;
  const identity = requireAuthorisedMediaGroup(
    request,
    database,
    response,
    config,
    now(),
    url.searchParams.get('groupId'),
  );
  if (!identity) return;
  const job = database
    .prepare(
      `SELECT j.id, j.status FROM media_jobs j
         JOIN contributions c ON c.id = j.contribution_id
         WHERE j.id = ? AND j.group_id = ? AND c.member_id = ? AND j.kind = 'clip'`,
    )
    .get(jobId, identity.groupId, identity.memberId) as { id: string; status: string } | undefined;
  if (!job) return sendNotFound(response, config);
  sendJson(response, config, 200, {
    clip: {
      id: job.id,
      status:
        job.status === 'processing' ||
        job.status === 'ready' ||
        job.status === 'failed' ||
        job.status === 'cancelled'
          ? job.status
          : 'pending',
    },
  });
}

function handleContributionLedger(ctx: MediaRouteContext): void {
  const { request, response, config, database, now, url } = ctx;
  const requestNow = now();
  const identity = requireAuthorisedMediaGroup(
    request,
    database,
    response,
    config,
    requestNow,
    url.searchParams.get('groupId'),
  );
  if (!identity) return;
  try {
    sendJson(
      response,
      config,
      200,
      listContributionLedger(database, {
        groupId: identity.groupId,
        memberId: identity.memberId,
        state: parseLedgerState(url.searchParams.get('state')),
        limit: parseLedgerLimit(url.searchParams.get('limit')),
        cursor: url.searchParams.get('cursor'),
        now: requestNow,
      }),
    );
  } catch (error) {
    if (!(error instanceof ContributionLedgerQueryError)) throw error;
    sendJson(response, config, 400, {
      error: 'invalid_ledger_request',
      message: error.message,
    });
  }
}

function handleContributionDetail(ctx: MediaRouteContext, match: RegExpMatchArray): void {
  const { request, response, config, database, now, url } = ctx;
  const contributionId = decodePathSegment(match[1], response, config);
  if (contributionId === null) return;
  const groupId = url.searchParams.get('groupId');
  const identity = requireAuthorisedMediaGroup(request, database, response, config, now(), groupId);
  if (!identity) return;
  if (request.method === 'DELETE') {
    const result = deleteContribution(
      database,
      identity.groupId,
      identity.memberId,
      contributionId,
      now(),
      {
        stagingDir: mediaDir(config, 'staging'),
        outputDir: mediaDir(config, 'processed'),
      },
    );
    if (!result.ok) {
      const status =
        result.reason === 'not_found' || result.reason === 'already_deleted' ? 404 : 409;
      const messages = {
        already_deleted: 'That contribution has already been deleted.',
        deletion_used: 'The weekly delete-and-replace allowance has already been used.',
        not_eligible: 'This contribution can no longer be deleted before reveal.',
        not_found: 'The contribution was not found.',
        processing: 'Wait for processing to finish before deleting this contribution.',
      } as const;
      sendJson(response, config, status, {
        error: `contribution_${result.reason}`,
        message: messages[result.reason],
      });
      return;
    }
    sendJson(response, config, 200, { deleted: true, ...result });
    return;
  }
  const contribution = getContribution(database, identity.groupId, contributionId);
  if (!contribution) return sendNotFound(response, config);
  sendJson(response, config, 200, { contribution });
}

export const contributionRoutes: readonly Route<MediaRouteContext>[] = [
  { methods: ['POST'], path: '/contributions/upload/source', handle: handleUploadSource },
  { methods: ['POST'], path: '/contributions/upload', handle: handleCreateUpload },
  { methods: ['DELETE'], path: /^\/contributions\/upload\/([^/]+)$/, handle: handleCancelUpload },
  {
    methods: ['POST'],
    path: /^\/contributions\/jobs\/([^/]+)\/process$/,
    handle: handleProcessJob,
  },
  { methods: ['GET'], path: /^\/clips\/([^/]+)$/, handle: handleClipStatus },
  { methods: ['GET'], path: '/contributions', handle: handleContributionLedger },
  { methods: '*', path: /^\/contributions\/([^/]+)$/, handle: handleContributionDetail },
];
