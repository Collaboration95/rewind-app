// Barrel: media intake API, split into clip-policy, staged-source and clip-upload.
export {
  DEFAULT_CAPTURE_MODE,
  SUPPORTED_CAPTURE_MODES,
  type CaptureMode,
  type ProcessingMode,
} from '../ffmpeg';
export {
  MAX_CLIP_BYTES,
  MAX_CLIP_DURATION_SECONDS,
  recordClipMediaMetadata,
  type ServerClipMetadata,
} from './clip-policy';
export {
  acquireStagedSourceLock,
  claimStagedSource,
  cleanupStagedSource,
  cleanupStagedSourcePath,
  cleanupUnclaimedStagedPath,
  findStagedSource,
  markStagedSourceReady,
  reclaimStagedSource,
  removeStagedSource,
  resetStagedSourceClaim,
  stagedSourceId,
  stagedSourcePath,
  type StagedSource,
  type StagedSourceCleanupOptions,
} from './staged-source';
export {
  cancelClipUpload,
  createClipUpload,
  getClipProcessingMetadata,
  validateClipUpload,
  type CancelClipUploadOptions,
  type CancelClipUploadResult,
  type ClipProcessingMetadata,
  type ClipUploadInput,
  type ClipUploadOptions,
  type ClipUploadResult,
  type PendingClipUpload,
} from './clip-upload';
