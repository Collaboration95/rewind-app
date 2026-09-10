import type {
  CapabilitySnapshot,
  DeviceCapability,
  ImageMetadata,
  PermissionSnapshot,
  PermissionState,
} from './contracts';

export type CaptureStatus =
  | 'checking'
  | 'capability-undecided'
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
  const capabilityStatus = firstCapabilityStatus(capabilities.camera, capabilities.microphone);
  if (capabilityStatus === 'unsupported') return 'unsupported';
  if (capabilityStatus === 'undecided') return 'capability-undecided';

  const permissionStatus = firstPermissionStatus(permissions.camera, permissions.microphone);
  if (permissionStatus === 'blocked') return 'permission-blocked';
  if (permissionStatus === 'denied') return 'permission-denied';
  if (permissionStatus === 'undetermined') return 'permission-undecided';

  return 'ready';
}

function firstCapabilityStatus(
  camera: DeviceCapability,
  microphone: DeviceCapability,
): 'supported' | 'unsupported' | 'undecided' {
  if (camera === 'unsupported' || microphone === 'unsupported') return 'unsupported';
  if (camera === 'undecided' || microphone === 'undecided') return 'undecided';
  return 'supported';
}

function firstPermissionStatus(
  camera: PermissionState,
  microphone: PermissionState,
): 'granted' | 'denied' | 'blocked' | 'undetermined' {
  if (camera === 'blocked' || microphone === 'blocked') return 'blocked';
  if (camera === 'denied' || microphone === 'denied') return 'denied';
  if (camera === 'undetermined' || microphone === 'undetermined') return 'undetermined';
  return 'granted';
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
