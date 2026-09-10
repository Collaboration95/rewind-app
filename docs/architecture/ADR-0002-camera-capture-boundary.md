# ADR-0002: Local still-image capture boundary

- Status: Accepted for the camera workstream
- Date: 2026-09-10
- Scope: device capability/permission checks and local still-image preview

## Decision

Use Expo SDK 57's `expo-camera` for the native camera surface and
`expo-file-system/legacy` for the SDK 57-compatible cache-copy API. Expo
`expo-device` distinguishes a real device from an iOS/Android simulator during
the capability probe. The app config supplies explicit camera and microphone
usage strings through the `expo-camera` config plugin.

The capture UI depends on the framework-independent ports in
`src/capture/contracts.ts`. `ExpoCameraPlatform` is the production adapter;
`DemoCameraPlatform` is an explicit fixture adapter for simulator review and
deterministic tests. The fixture is always labelled as a simulator demo and
never claims that hardware captured an image.

## Capability and permission boundary

Camera and microphone are both required before the still-image control is
enabled. Each capability can be `supported`, `unsupported`, or `undecided`.
Each permission can be `granted`, `undetermined`, `denied`, or `blocked`.
The route keeps these states distinct and provides retry guidance for
undecided/denied access and Settings guidance for blocked access. The local
client does not treat a demo actor or a granted device permission as account
authentication.

Expo does not provide a separate microphone hardware-capability probe. On
native, a real device is therefore the supported recording target; simulators
are reported as unsupported by the native adapter and can be reviewed only
through the explicit fixture adapter. On web, `navigator.mediaDevices` is the
capability signal and browser permission controls remain in the address bar.

## File and metadata lifecycle

`CameraView.takePictureAsync` writes a temporary native file. The capture
session copies that file into an app-managed cache directory and verifies that
the destination exists and has non-zero size before exposing the active
preview as accepted. Durable AsyncStorage contains metadata only (dimensions,
format, capture time, byte length, source); it never stores a URI or thumbnail.

Retake, discard, reset, and failed metadata writes remove the active managed
file and its metadata record. This makes the preview URI an in-memory session
value rather than a durable path that could outlive the capture flow.

## Follow-up

This spike intentionally excludes video recording, gallery import, upload,
reveal, sharing, and cloud storage. A future upload adapter can consume an
accepted capture session while preserving the metadata/URI separation.
