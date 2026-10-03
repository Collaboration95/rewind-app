# Native client builds — #351

Website delivery stays first. Android APK delivery is still required; build
preparation and an Expo Go preview do not discharge the APK/install obligation.
Run from a clean reviewed `dev` commit after website checks. This configuration
is initially an unmerged preview and is not native acceptance evidence.

## Identity, environment and version policy

- Keep the existing `rewind` callback scheme and iOS bundle identifier
  `com.anonymous.rewind-app`. Android uses `com.anonymous.rewindapp`; review this
  pilot identifier and signing identity before distributing or replacing an app.
- Version `0.1.0`, Android `versionCode: 1`, iOS `buildNumber: "1"` are explicit.
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
OIDC/remote-push development builds. EAS CLI is not a project dependency and was
not installed or invoked. A local Expo session was observed without inspecting
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

   Use `ios` for the simulator profile. To rehearse this unmerged #351 slice,
   pass explicit `app.json eas.json package.json scripts/native-build.mjs`
   overlays. Package overlays may change scripts only. Other dirty tracked
   source is refused. Any unmerged overlay or source commit different from the
   accepted base is labelled `unmerged-preview`.

   `provenance.json` records accepted base, source commit and file digest,
   app/EAS config digest, origin digest, identifiers/versions, actual JS tool
   versions and the installed-dependency limitation. `public-env.json` contains
   only the three approved public values. Keep these with the build logs and
   eventual APK checksum; a prepared manifest does not prove a binary exists.

4. In the disposable `source/` directory, generate Android without installing
   dependencies or querying Expo:

   ```sh
   CI=1 EXPO_OFFLINE=1 EXPO_NO_DOTENV=1 node node_modules/expo/bin/cli prebuild --platform android --no-install --template node_modules/expo/template.tgz
   ```

   Use only existing installed SDK/Gradle tools. Set the three public values
   exactly as recorded in `public-env.json`, clear any additional
   `EXPO_PUBLIC_*` overrides, and run in `source/android/`:

   ```sh
   CI=1 EXPO_OFFLINE=1 EXPO_NO_DOTENV=1 ./gradlew --offline --no-daemon :app:assembleRelease
   ```

   The Expo template supplies its standard **debug test key**, including for
   this local Release rehearsal. No signing key was created. This would be an
   embedded, internally installable test APK, not a production-signed release.
   Before distribution, use the separately approved signing identity; the EAS
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
   config or origin change after staging is rejected. Do not overwrite an
   existing installed application without explicit device-owner authorization.

Stop after the first diagnosed native toolchain retry. Do not download large
SDKs, create signing credentials, dispatch paid/remote builds, or remove checks
to make the build pass. An unavailable toolchain leaves the APK deliverable open.

## iOS and lead-owned native acceptance

An iPhone 17 Pro simulator on iOS 26.5 was available during read-only inspection;
no Android device was connected. No app was installed, overwritten, launched,
or smoke-tested by this preparation. The lead owns those steps after precheck.

For the pilot API baseline, use iPhone 14+ (prefer a notch/Dynamic Island) with
Expo Go and the exact approved source/config/origins:

```sh
npm start -- --ios --lan --clear
```

Use LAN, not localhost. This baseline is not a separately signed iOS binary.
The simulator profile prepares a native build route; compiling it additionally
requires the existing CocoaPods/native dependencies. Device builds require an
existing Apple signing identity, provisioning profile, matching bundle ID and
registered device. Apple/EAS signing access has not been verified here.

The lead must verify sign-in/session restore/logout, invite callbacks and native
sharing, video/photo capture permissions and upload, sealed contribution state,
chat, reveal and archive playback/download on Android and supported iOS. Check
`rewind://` routing after cold launch; preserving a scheme does not implement or
prove OIDC. Record actual device/runtime/build IDs and limits, without member
secrets or media. The shared app code was not changed in this task.

Sprint 3 OIDC, remote push and client-retro/native changes require a rebuild and
renewed native acceptance. Expo Go is insufficient for final OAuth/OIDC redirect
behavior and Android remote push. Review the future development-build dependency
and configuration changes then; no final OIDC/push acceptance is claimed now.

## Current compile disposition

The local Android template prebuild succeeded. The first offline Gradle attempt
was blocked by the sandbox's lock-file permission. Its single diagnosed retry
used existing host caches and reached native configuration, then stopped because
AsyncStorage needs an uncached
`com.google.devtools.ksp:symbol-processing-gradle-plugin:1.9.24-1.0.20`.
No APK was produced and no further native compile retry or dependency download
was attempted. Resolve the missing native dependency cache in separately
approved scope, then build from accepted code/config/real preview origins and
perform Android/iOS acceptance. The reserved `.invalid` origins used for this
compile rehearsal cannot support live sign-in or invite smoke.

## Official references

- [EAS profile fields, environment, APK tasks and signing](https://docs.expo.dev/eas/json/)
- [Android APK configuration and installation](https://docs.expo.dev/build-reference/apk/)
- [Simulator builds](https://docs.expo.dev/build-reference/simulators/)
- [Local EAS requirements and ignored tool-version fields](https://docs.expo.dev/build-reference/local-builds/)
- [Local production signing](https://docs.expo.dev/guides/local-app-production/)
- [OAuth/OIDC native authentication](https://docs.expo.dev/guides/authentication/)
- [Native notification limitations](https://docs.expo.dev/versions/latest/sdk/notifications/)
