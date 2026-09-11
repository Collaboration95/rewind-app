# iOS integration evidence

Captured from the booted **iPhone 15 Pro — iOS 17.5** simulator (`E04733A2-E8FD-4C1D-81B5-5E7F927E2637`) on 2026-09-10 with Expo Go and the LAN Metro command:

```sh
EXPO_PUBLIC_CAMERA_MODE=demo npm start -- --ios --lan --clear
```

The permission-state capture was run with `EXPO_PUBLIC_CAMERA_MODE=demo-denied`; the Demo access chooser was run with `EXPO_PUBLIC_DEMO_ACCESS=entry`. Screenshots were taken with `xcrun simctl io <device> screenshot`.

| Evidence                                                    | Screenshot                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Demo access chooser (synthetic sign-in)                     | [ios-demo-entry-chooser.png](ios-demo-entry-chooser.png)                           |
| Owner actor and current group in Settings                   | [ios-settings-owner-group.png](ios-settings-owner-group.png)                       |
| Local group name and built-in prompt choices                | [ios-create-group-prompt-selection.png](ios-create-group-prompt-selection.png)     |
| Confirmed reset dialog                                      | [ios-reset-confirmation.png](ios-reset-confirmation.png)                           |
| Camera denied state with retry and Settings actions         | [ios-camera-permission-denied-retry.png](ios-camera-permission-denied-retry.png)   |
| Explicit simulator fixture ready state                      | [ios-camera-simulated-ready.png](ios-camera-simulated-ready.png)                   |
| Fixture still review with retake/discard/accept             | [ios-camera-simulated-preview-retake.png](ios-camera-simulated-preview-retake.png) |
| Locked cycle with sealed placeholders and no media controls | [ios-locked-state-no-media-ui.png](ios-locked-state-no-media-ui.png)               |

The simulator does not expose a physical camera. The camera screenshots therefore intentionally use `DemoCameraPlatform`, which labels the fixture and says that no physical image was captured. The native `ExpoCameraPlatform` path, permission strings, capability probe, local file store, and metadata lifecycle are covered by the focused tests and are intended for a physical device.

Cycle owner control is a local runtime/service boundary rather than a media UI action. Owner success, non-owner denial, deterministic clock advancement, and event recording are covered by `server/tests/cycles.test.mjs`, `server/tests/cross-group-access.test.mjs`, and the runtime-client tests.
