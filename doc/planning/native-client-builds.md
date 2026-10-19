# Native client builds

Current guidance checked against dev `40ebeb5673d103b4b6950d095192aae744980769`
on 15 October 2026. Android refresh #528 is closed; use the existing published
[client artifact](client-artifacts.md), versionCode **2**, source `7105328`,
with its debug-key limitation and recorded smoke gaps. No rebuild is required
for this documentation update. The older preparation rehearsal below is
historical compile evidence, not the current installation status.

## Identity, environment and version policy

- Keep the existing `rewind` callback scheme and iOS bundle identifier
  `com.anonymous.rewind-app`. Android uses `com.anonymous.rewindapp`; review this
  pilot identifier and signing identity before distributing or replacing an app.
- Version `0.1.0`, Android `versionCode: 2`, iOS `buildNumber: "1"` are explicit.
  EAS uses local version numbers and does not increment them automatically.
  Increment the relevant build number in reviewed source for each distribution.
- OTA updates are disabled. There is no update URL, project ID, update channel,
  store submission profile, credential, or automatic remote build in this slice.
  Native/config/API-origin changes require a new binary; installing a website
  update does not update an existing APK or iOS application.
- Supply `EXPO_PUBLIC_LOCAL_BASE_URL` as an absolute HTTPS API base URL, including
  `/api` only when the approved proxy serves that prefix. Supply
  `EXPO_PUBLIC_INVITE_WEB_ORIGIN` as the public HTTPS website origin, without a
  path, query, fragment or credentials. These values are embedded in the client
  bundle and must never contain a secret. They are intentionally not defaulted
  to a hosted member dataset in `eas.json`.
- Preview builds disable Demo access. The build staging script ignores local
  `.env` files, rejects tracked signing credentials, and copies only source
  files. EAS profiles select the `preview` environment; before any separately
  authorized EAS run, review its public variables and signing/account access.
  Do not let a preview point at release member data.

## Profiles and prerequisites

| Profile                 | Output                        | Signing/access boundary                                                |
| ----------------------- | ----------------------------- | ---------------------------------------------------------------------- |
| `preview-apk`           | Android APK, Release task     | Existing local credentials for EAS; no credential generation           |
| `preview-ios-simulator` | Release simulator application | No device provisioning or signing credentials required by profile      |
| `preview-ios-device`    | Internal iOS device build     | Existing local certificate/provisioning and registered device required |

`expo-dev-client` is not installed. These are embedded preview builds, not final
managed OIDC or completed reminder/push acceptance builds. EAS CLI is not a
project dependency and was not installed or invoked. A local Expo session was observed without inspecting
or printing its tokens; project ownership, usable EAS permissions and signing
credentials remain unverified. Do not run `eas build:configure`, login, credential
creation, remote builds or submissions as part of this preparation.

Installed tooling inspected on 3 October 2026: Expo 57.0.21, React Native 0.86.3,
Node 26.3.1, npm 11.16.0, Java 17.0.20.1, Gradle 9.3.1, Android API/build-tools 36,
NDK 27.1.12297006, CMake 3.22.1, Xcode 27.0 and CocoaPods 1.17.0. The installed
React Native Gradle versions agree with API/build-tools 36 and that NDK. EAS
profiles pin Node 26.3.1; local EAS ignores its tool-version fields, so record the
actual local toolchain and obtain its existing access separately.

## Reproduce and pin a disposable build

Run `npm ci` from the locked reviewed source for an independent reproduction;
this rehearsal reused an existing installed dependency tree. Do not change
packages/lockfiles to fix a native toolchain problem without coordination.

1. Run `npm run check` before native review. Record website behavior first.
2. Select the exact reviewed commit and approved preview API/website origins.
   `BASE_SHA` below must be a full commit SHA. The operator supplies an unused
   directory outside the repository and confirms the device/data boundary.
3. Prepare source without changing the working tree:

   ```sh
   npm run client:prepare -- /private/tmp/rewind-native-preview BASE_SHA android HTTPS_API_URL HTTPS_WEBSITE_ORIGIN
   ```

   Use `ios` for the simulator profile. To rehearse an unmerged configuration
   change, pass explicit `app.json eas.json package.json scripts/native-build.mjs`
   overlays. Accepted source needs no overlays. Package overlays may change scripts only. Other dirty tracked
   source is refused. Any unmerged overlay or source commit different from the
   accepted base is labelled `unmerged-preview`.

   `provenance.json` records accepted base, source commit and file digest,
   app/EAS config digest, origin digest, identifiers/versions, actual JS tool
   versions and the installed-dependency limitation. Preparation generates
   `rewind-native-entry.js` and changes `main` only in the disposable package
   copy. The entry imports that snapshot's `App`, avoiding Expo AppEntry's
   `../../App` resolution through a shared dependency symlink. The original
   source digest and effective build-input digest are both recorded, together
   with the generated entry and package-main transformation. `public-env.json` contains
   only the three approved public values. Keep these with the build logs and
   eventual APK checksum; a prepared manifest does not prove a binary exists.

4. In the disposable `source/` directory, generate Android without installing
   dependencies or querying Expo:

   ```sh
   CI=1 EXPO_OFFLINE=1 EXPO_NO_DOTENV=1 node node_modules/expo/bin/cli prebuild --platform android --no-install --template /private/tmp/rewind-native-preview/source/node_modules/expo/template.tgz
   ```

   Substitute the actual disposable directory in the absolute template path.
   Expo 57 interprets bare `node_modules/expo/template.tgz` as GitHub shorthand;
   an existing file at that relative path does not prevent this interpretation.
   The absolute-path form was checked with the installed CLI's option parser
   and succeeded in the corrected preview below.

   Use only existing installed SDK/Gradle tools. Set the three public values
   exactly as recorded in `public-env.json`, clear any additional
   `EXPO_PUBLIC_*` overrides, and run in `source/android/`:

   ```sh
   CI=1 EXPO_OFFLINE=1 EXPO_NO_DOTENV=1 ./gradlew --offline --no-daemon :app:assembleRelease
   ```

   The Expo template supplies its standard **debug test key**, including for
   this local Release rehearsal. No signing key was created. This would be an
   embedded, internally installable test APK, not a production-signed release.
   The published hosted-dev test APK uses this debug test identity. Production
   or store distribution requires an appropriate signing identity; the EAS
   APK profile deliberately requires existing local credentials instead.

5. Only after successful compilation, inspect package ID/version and callback
   intent filter with the installed Android build tools and verify the APK with
   `apksigner verify --verbose --print-certs`. Preserve its signing fingerprint.
   Record checksum/provenance with:

   ```sh
   node scripts/native-build.mjs record /private/tmp/rewind-native-preview /private/tmp/rewind-native-preview/source/android/app/build/outputs/apk/release/app-release.apk
   ```

   This receipt still says `compiled-unverified-preview`: signing, installed
   behavior and member acceptance require independent verification. A source,
   config or origin change after staging is rejected. Android recording also
   reconciles application source text in the packager sourcemap with the
   disposable snapshot and rejects application paths outside that snapshot.
   Retain the generated packager sourcemap with the build output. Do not overwrite an
   existing installed application without explicit device-owner authorization.

Stop after the first diagnosed native toolchain retry unless the user grants
new bounded scope. The 3 October follow-ups authorized dependency resolution and
corrected-source validation, including routine invocation corrections. Stop on
an unavailable toolchain/access or a new material code problem needing review.
Do not download large SDKs, create signing credentials, dispatch
paid/remote builds, delete caches, or remove checks to make the build pass. A
missing toolchain or unresolved source provenance leaves the APK deliverable open.

## Current client scope

Website/PWA delivery stays first. iOS is delivered as the PWA; compiled iOS,
TestFlight and App Store delivery are out of scope. Existing simulator/device
profiles are retained configuration, not an obligation to build or distribute.
For an optional local Expo Go preview, use iPhone 14+ and LAN:

```sh
npm start -- --ios --lan --clear
```

Web/PWA authentication uses Cognito Managed Login when configured. Local and
hosted dev retain Developer sign-in; native Expo/Android clients use that form
against local/dev only. Preserving the `rewind://` scheme does not implement
native Cognito. Native push remains disabled; reminders use web push. Native
retro processing remains server-side (#367). Do not extend native push or
release-native authentication to satisfy these historical build notes.

For actual Android installation/upgrade and journey results, use the
[artifact inventory](client-artifacts.md). Its camera, film, export and invite
gaps remain explicit; an Expo Go preview or compile receipt does not fill them.

## Historical 3 October compilation rehearsal

A disposable Android Release rehearsal compiled offline on 3 October 2026
using the existing SDK/Gradle cache. It used unmerged source commit
`d77ecc2af5a5a77f192efa265495ae8d7cadb032` based on accepted dev
`b43b8982a3668cc1ef6e5295bfdbde7f2cd588c9` and reserved `.invalid` origins.
Its snapshot-local entrypoint bundled 63 application source files matching
the staged tree. Package/version, `rewind` scheme, APK v2 debug signature and
embedded bundle were inspected successfully. This proves the local compile
route; it does not satisfy accepted-source or installed journey acceptance.

The APK checksum was
`cae5479f3c73b1637014a48fd373be493f72bf553a463fb28c6c2f534cddd3d6`.
The standard Expo-template Android Debug signing certificate checksum was
`fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`;
this is a test identity. Build receipts and attempt logs remain in the
disposable `/private/tmp/rewind-351-android-entry-fixed-preview-20261003`
and `/private/tmp/rewind-351-logs-20261003` directories. They are temporary
local artifacts and are not reproducible repository inputs.

An earlier shared-node_modules AppEntry rehearsal bundled foreign application
source and is quarantined. The recorder rejects that provenance. The local
entrypoint and application-source checks address the diagnosed cause.

The published #351 artifact was subsequently refreshed by closed #528.
Neither this rehearsal nor that closure establishes a new physical-device pass.
Use the release-specific results in [client artifacts](client-artifacts.md)
instead of treating the old pre-closure checklist as outstanding build work.

## Official references

- [EAS profile fields, environment, APK tasks and signing](https://docs.expo.dev/eas/json/)
- [Android APK configuration and installation](https://docs.expo.dev/build-reference/apk/)
- [Simulator builds](https://docs.expo.dev/build-reference/simulators/)
- [Local EAS requirements and ignored tool-version fields](https://docs.expo.dev/build-reference/local-builds/)
- [Local production signing](https://docs.expo.dev/guides/local-app-production/)
- [OAuth/OIDC native authentication](https://docs.expo.dev/guides/authentication/)
- [Native notification limitations](https://docs.expo.dev/versions/latest/sdk/notifications/)
- [Disable Android SDK auto-downloads](https://developer.android.com/studio/intro/update)
- [Disable Gradle JDK auto-provisioning](https://docs.gradle.org/current/userguide/toolchains.html)
