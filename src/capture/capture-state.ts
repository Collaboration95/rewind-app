import type { CapabilitySnapshot, ImageMetadata, PermissionSnapshot } from './contracts';

export type CaptureStatus =
  | 'checking'
  | 'temporarily-unavailable'
  | 'unsupported'
  | 'permission-undecided'
  | 'permission-denied'
  | 'permission-blocked'
  | 'ready'
  | 'capturing'
  | 'preview'
  | 'saving'
  | 'saved'
  | 'capture-failed'
  | 'write-failed';

export interface CaptureState {
  status: CaptureStatus;
  capabilities: CapabilitySnapshot | null;
  permissions: PermissionSnapshot | null;
  activePreview: {
    uri: string;
    metadata: ImageMetadata;
  } | null;
  errorMessage: string | null;
}

export const initialCaptureState: CaptureState = {
  status: 'checking',
  capabilities: null,
  permissions: null,
  activePreview: null,
  errorMessage: null,
};

export function cameraAccessStatus(
  capabilities: CapabilitySnapshot,
  permissions: PermissionSnapshot,
): Exclude<
  CaptureStatus,
  'checking' | 'capturing' | 'preview' | 'saving' | 'saved' | 'capture-failed' | 'write-failed'
> {
  const capabilityStatus = capabilities.camera;
  if (capabilityStatus === 'unsupported') return 'unsupported';
  if (capabilityStatus === 'undecided') return 'temporarily-unavailable';

  const permissionStatus = permissions.camera;
  if (permissionStatus === 'blocked') return 'permission-blocked';
  if (permissionStatus === 'denied') return 'permission-denied';
  if (permissionStatus === 'undetermined') return 'permission-undecided';

  return 'ready';
}

export function isCaptureReady(state: CaptureState): boolean {
  return state.status === 'ready';
}

export function accessState(
  capabilities: CapabilitySnapshot,
  permissions: PermissionSnapshot,
): Pick<CaptureState, 'status' | 'capabilities' | 'permissions' | 'errorMessage'> {
  return {
    status: cameraAccessStatus(capabilities, permissions),
    capabilities,
    permissions,
    errorMessage: null,
  };
}
