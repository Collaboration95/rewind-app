# Rewind client artifacts

Inventory checked 15 October 2026 against dev
`40ebeb5673d103b4b6950d095192aae744980769`, the published release below and
closed #528. This records existing artifacts and evidence; no APK, deployment
or physical-device check was performed for this documentation update.

| Client           | Delivery and boundary                                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web / iPhone PWA | Website at the operator-supplied environment URL; install from Safari on iPhone. Cognito when configured; developer form only on local/dev. Current deployment status must be verified separately. |
| Android test APK | Existing hosted-dev binary below. Developer sign-in only, debug test identity; not a Play Store or release-auth client.                                                                            |
| Expo Go          | Local/dev preview route; not a signed distribution artifact. Native push disabled.                                                                                                                 |
| Compiled iOS     | Out of scope; iOS delivery is the PWA. Existing build profiles do not imply a shipped app.                                                                                                         |

## Published Android artifact

Use [apk-dev-7105328](https://github.com/Collaboration95/rewind-app/releases/tag/apk-dev-7105328),
asset `rewind-0.1.0-dev-7105328.apk` (105,688,697 bytes). GitHub repository
access may be required. Download using authenticated `gh release download
apk-dev-7105328 --repo Collaboration95/rewind-app --pattern '*.apk'` when
working in this project. Allow installation from that source on your test
Android device; do not distribute it as a production-signed app.

- Source: `7105328054437a4d27cc94d025811cffcff74e51`, based on dev `c9e31d8`
  plus the versionCode bump and native-build test correction. The release
  receipt labels it **unmerged-preview** at build time. Subsequent integration
  does not make this embedded binary identical to today's dev.
- Package `com.anonymous.rewindapp`; versionName `0.1.0`, versionCode **2**;
  minSdk 24, targetSdk 36. Previous `apk-dev-e39f707` has versionCode 1.
- API: `https://d2m6kz76y4kuvm.cloudfront.net/api`.
  Website/invite origin: `https://d2m6kz76y4kuvm.cloudfront.net`.
  These are historical hosted-dev origins, not a statement of present uptime.
- SHA-256: `36f189190c87dcef2526406dde58b61ce19348a87c7ce1066d7ff4004ea00d1a`.
- Signer SHA-256: `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`.
  The standard React Native/Expo **debug key** matches the previous APK.
  It is a test identity, not a production/store key.
- OTA updates disabled. Native code/config/origin changes require a new binary;
  updating the website cannot update the embedded client. No new source/origin
  requirement was identified for this documentation-only slice.

## Recorded smoke, not fresh acceptance

The release records Android 16 / API 36 emulator checks on 12 October 2026:

| Check                         | Recorded outcome                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| In-place upgrade              | Passed `adb install -r` from versionCode 1 to 2 without uninstall/data clearing; firstInstallTime, session and selected group retained.                                                          |
| Separate clean install        | Passed launch and developer sign-in after uninstall/reinstall.                                                                                                                                   |
| Account/group/chat            | Passed account creation, sign-in, group creation, text, reply and sparkle reaction.                                                                                                              |
| Cold restart / sign-out       | Session, group and chat restored; sign-out followed by restart stayed on welcome.                                                                                                                |
| Camera / photo / video        | **Unverified**: emulator reported camera capture unsupported; no physical-device pass.                                                                                                           |
| Released-film playback        | **Unverified**: 28-day hosted cycle had no film; shared clocks were not changed.                                                                                                                 |
| Film / own-clip export (#525) | **Unverified on device**: no reachable media. Bundle contained folder-picker code; focused tests covered cancellation, failure, repeated taps and cleanup. That is not an export/open-file pass. |
| Invite handling               | **Not exercised** in the single-member test group.                                                                                                                                               |

The release records native-build and test:fast passing for its build source.
Those historical results do not establish current-dev Quality, deployed state,
or completion of the unexercised journeys. Closed #528 identifies the refreshed
artifact; retain the gaps above rather than reopening a build solely to relabel
its evidence.

See [product walkthrough](product-walkthrough.md) for installation, account,
permission and demonstration instructions, and [native client builds](native-client-builds.md)
for the existing preparation/reproduction route.
