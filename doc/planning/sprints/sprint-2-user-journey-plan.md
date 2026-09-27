# Sprint 2: complete user journey and issue map

**Status:** Draft for Sprint Planning, 27 September 2026. This is the proposed
feature map, not a claim that the features are built or accepted. It assigns no
individual owners. Sprint 2 runs 27 September–10 October; Sprint 3 is reserved
for follow-up fixes, documentation, and release/submission work.

## Product target

A member opens a branded Rewind app, signs in using a real preset account,
creates or joins a private group, sees its prompt and contribution allowance,
captures a photo or at most 15-second video, submits it, sees truthful
processing/sealed status, chats with the group, receives the configured
reminder, and later watches and downloads the automatically released film.
The same service is reachable from an installable Android APK and a live web
PWA. Native iOS must work for testing but does not need an App Store release.
The one-day cycle remains a labelled demonstration setting; real groups use
the four-week cycle. Before real users are invited, non-member requests must
be denied for group data, chat, source/processed media, film, and downloads.

The initial accounts may be created in the chosen identity provider ahead of
time. Self-registration and MFA are not required for the first pilot. A
provider-hosted password reset or an explicit administrator reset path is
required so a forgotten password does not strand a member. Demo identities
remain visibly synthetic and separate from real accounts. The Demo identity
switch belongs in Settings, rather than Home. For planning, treat each photo
as one weekly contribution and a three-second film segment; count those three
seconds toward the existing 30-second weekly allowance. This is a proposed
rule to implement consistently on the client, server, and film worker.

## Normal screen flow

1. **Launch:** native splash and app loader show only the Rewind logo and name
   while restoring a session. On a fresh install, an expired session, or a
   signed-out device, go to the welcome screen. Never silently create Amber.
2. **Welcome and login:** explain the private-group product in one short view,
   offer a primary **Sign in** action and a clearly separate **Try Demo** route.
   The hosted provider accepts a pre-created email/password account. Show
   cancellation, wrong-password, offline, expired-session, and reset paths.
3. **Choose a group:** if the member has no group, offer **Create group** and
   **Join with invitation**. Make an incoming invitation survive the login
   redirect. Existing members choose their group and can switch it in Settings.
4. **Home:** show group identity, current prompt, four-week countdown, weekly
   contribution allowance, the member's real contribution history, and one
   clear capture action. Remove the Demo profile picker and hard-coded locked
   moment tiles from the normal member view. Explain empty and sealed states.
5. **Capture and review:** offer **Video** and **Photo**. Request permissions
   when used; record/trim/retake video, or take/review/retake a photo. Let the
   member choose a retro mode and submit, with a recoverable upload state.
6. **Participation:** keep the contribution visible as queued, processing,
   sealed, or failed. Chat has text, replies, reactions, empty and reconnecting
   states. Settings contains reminder consent and timing, invites, group
   switching, account sign-out, and clearly separated Demo controls.
7. **Reveal and return:** a time boundary queues the film automatically. A
   member sees locked, delayed, premiere, and released states; can play and
   download only authorized media, then enters the next cycle.

The shell already has Home, Camera, Chat, Archive, and Settings tabs. Group
creation and invitation controls currently sit under Settings. Issue #234
has moved the Demo profile picker from Home to Settings on `dev`; Home still
contains static locked placeholders. These routes are starting material,
not proof of the real-user flow.

## Journey checkpoints

| Step           | What the person must be able to do                                                                         | Present baseline                                                                                         | Completion evidence                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1. Open        | See only the Rewind mark/name while the session restores, then a welcome and sign-in route                 | Demo session currently restores or auto-creates the synthetic Amber actor; no configured native splash   | Fresh install, returning signed-in, expired-session and offline states on web/native                       |
| 2. Sign in     | Use a preset real account, remain signed in, sign out, recover from an expired session                     | Synthetic Demo session only                                                                              | Real identity claim verified server-side; no account selection grants authority; password reset path works |
| 3. Join        | Create a private group or accept an expiring invitation                                                    | Group/invite paths exist for synthetic members                                                           | Two real accounts join; invalid and cross-group attempts fail safely                                       |
| 4. Orient      | Read group prompt, cycle countdown, quota and contribution history                                         | Demo Home and ledger exist; #234 moved the picker to Settings on `dev`, while static moment tiles remain | Correct real-group state after restart, on each platform                                                   |
| 5. Capture     | Record/trim a 15-second video or take a photo, with clear permission and retake states                     | Native video path exists in code; still photo is local-only; web recording uses a file picker            | Physical Android/iPhone video and photo capture; installed PWA camera/mic path                             |
| 6. Submit      | Upload, retry if interrupted, see queued/processing/sealed or failed state, delete/recapture within limits | MP4 byte upload, processing and ledger exist for Demo                                                    | Server stores the real authorized contribution; media stays sealed before release                          |
| 7. Participate | Read/send group chat, choose prompts and reminder preferences                                              | Chat exists; reminders are device-local                                                                  | Real-group chat denial and remote Android/PWA reminder delivery                                            |
| 8. Reveal      | Cycle end automatically compiles, publishes once and starts the next cycle; delayed failures stay private  | Demo owner advance and worker/film code exist                                                            | Timed one-day and four-week transitions, retry, 24-hour premiere and next cycle                            |
| 9. Return      | Play/download released film and own processed contributions, switch group or sign out                      | Demo Archive and downloads exist                                                                         | Authorized web/APK/native playback; another group cannot fetch media                                       |
| 10. Operate    | Open a live dev app for team testing and release a reviewed main build                                     | `dev` and `main` branches exist; one live Demo host exists                                               | Distinct preview/release data boundary if both are live; versioned web/APK builds and repeatable smoke     |

## Issue map

The keys below are proposed issue identities. Reuse or rewrite the linked
existing issue where possible. Every implementation issue should describe a
user-visible result, include its negative/error states, and be small enough
for a focused PR. The parent story remains open until the entire checkpoint
works on the relevant physical device or hosted app.

### A. Enter Rewind and own a private group

| Key    | Proposed issue-sized result                               | Existing link / prerequisite                                                                                                              | Acceptance                                                                                                                                                                           |
| ------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S2-A01 | Decide the pilot identity, data and release boundary      | Rewrite [#169](https://github.com/Collaboration95/rewind-app/issues/169); remove its dependency on synthetic #145                         | Record provider, preset-account creation, domains, single/dual-host choice, data isolation, retention, rollback and cost limit in the issue                                          |
| S2-A02 | See a branded loading screen and welcome/login route      | New; independent of provider                                                                                                              | Native splash and app loader show logo/name only; fresh/returning/offline/expired routes work; no automatic synthetic sign-in                                                        |
| S2-A03 | Sign in on web/native with a preset account               | Split [#168](https://github.com/Collaboration95/rewind-app/issues/168); after A01                                                         | Provider redirect/callback works on web and native development builds, using code + PKCE; stored session restores; logout, reset and error recovery work; no MFA in the pilot        |
| S2-A04 | Bind a verified provider subject to a real member         | Split #168; parallel server slice after A01                                                                                               | Server validates issuer/audience/expiry, maps subject to member, refuses forged/expired tokens, and distinguishes real from Demo principals                                          |
| S2-A05 | Create a real private group and accept an invitation      | Split #168; after A03/A04                                                                                                                 | First-run create/join screen; an invitation survives login; two preset accounts create/invite/join; membership and owner rules apply to every route, including media and chat        |
| S2-A06 | Keep Demo mode separate and move its controls to Settings | [#234](https://github.com/Collaboration95/rewind-app/issues/234) picker change merged to `dev`; remaining shell work can start before A03 | Home has no synthetic profile picker or fake locked moment tiles in the member view; Demo entry/switch/reset are labelled in Settings; real sessions cannot gain Demo data authority |
| S2-A07 | Show real group Home and first-run empty states           | New; after A05                                                                                                                            | Home shows correct group, prompt, allowance, time, capture action and empty contribution state; restart preserves group choice                                                       |

### B. Contribute a moment

| Key    | Proposed issue-sized result                                       | Existing link / prerequisite                                                                                                                                                                                   | Acceptance                                                                                                                                                         |
| ------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S2-B01 | Make native video capture run from phone to backend               | New implementation issue; [#232](https://github.com/Collaboration95/rewind-app/issues/232) and [#228](https://github.com/Collaboration95/rewind-app/issues/228) provide device feedback; can start immediately | Android/iPhone record with audio, review/trim/retake, upload to reachable backend, processing and sealed state; fix the failures found on device                   |
| S2-B02 | Record video directly in the installed web PWA                    | New; can start immediately                                                                                                                                                                                     | iPhone Home Screen and Android browser request camera/mic, record at most 15 seconds, review and foreground-upload over HTTPS; unsupported states are honest       |
| S2-B03 | Submit a photo as an authorized group contribution                | New; can prototype in Demo, then integrate A05                                                                                                                                                                 | Keep image bytes until confirmed upload; validate type/size/orientation; create idempotent group ledger entry with retry/cancel and sealed status                  |
| S2-B04 | Turn a photo into a film-compatible processed segment             | New; after B03                                                                                                                                                                                                 | Worker emits a fixed-duration portrait MP4 with silent audio; stage/source retention, integrity, retry and failed states match video; film ordering includes photo |
| S2-B05 | Apply quota, delete-and-recapture and sealing to both media types | New; after B03/B04 and A05                                                                                                                                                                                     | Each photo counts one slot and three seconds; both types obey weekly limits and one replacement; no source, preview or thumbnail leaks before release              |
| S2-B06 | Prove retro treatment and real-media processing                   | Existing video code; after B01                                                                                                                                                                                 | Each promised original mode has a real processed output; interrupted/oversize upload and failed processing produce recoverable states                              |

### C. Participate, reveal and return

| Key    | Proposed issue-sized result                           | Existing link / prerequisite                | Acceptance                                                                                                                                          |
| ------ | ----------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| S2-C01 | Chat as real group members                            | New integration slice; after A05            | Text/reply/reaction/reconnect work; non-member read/write denied; unread and empty/error states render on native and web                            |
| S2-C02 | Set the group prompt and local reminder preference    | New integration slice; after A05            | Owner selects library/custom prompt; member sets Sunday 7pm local time, snooze/disable, and sees truthful permission/error state                    |
| S2-C03 | Deliver remote reminders to Android and installed PWA | New; after C02 and live HTTPS               | Provider tokens/subscriptions are scoped to member/device; scheduled send, invalid token, permission denied, disable and retry outcomes are visible |
| S2-C04 | Automatically end a cycle and queue one film          | New; after A05/B05                          | Four-week production and one-day demo clock paths trigger once without an owner tap; duplicate ticks/restarts do not duplicate a film               |
| S2-C05 | Publish a safe premiere and begin the next cycle      | New; after C04                              | Ordered clips/photos, normalized audio, labelled filler, delayed failure, atomic release, 24-hour premiere and next-cycle creation work             |
| S2-C06 | Play and download authorized archive content          | Existing Archive integration; after C05/A05 | Member sees released film and own processed media; non-member/other group denied; loading, empty, delayed and download-failure states work          |

### D. Install, host and prove the whole journey

| Key    | Proposed issue-sized result                                         | Existing link / prerequisite                                                                                                                                       | Acceptance                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S2-D01 | Give dev and release separate infrastructure state and private data | Split [#230](https://github.com/Collaboration95/rewind-app/issues/230); after A01                                                                                  | Separate Terraform state, names, backup targets, IAM scope, domains and cost estimates; no cross-environment private data path                                                               |
| S2-D02 | Publish `dev` and `main` at stable HTTPS URLs                       | Split #230; after D01                                                                                                                                              | Two independently reachable app/API origins; each reports deployed commit and has a basic health smoke; changes to `dev` cannot mutate release data                                          |
| S2-D03 | Promote a reviewed `main` build to release                          | [#229](https://github.com/Collaboration95/rewind-app/issues/229) plus deployment slice; after D02                                                                  | Immutable tested commit, reviewed promotion, deploy version/health check and rollback; no daily reviewer schedule                                                                            |
| S2-D04 | Build and install an Android APK and iOS development build          | New; can start alongside A03                                                                                                                                       | Package IDs, signing/build profiles and HTTPS API URL configured; install on physical Android and iOS test device; real OIDC redirect and camera permissions work                            |
| S2-D05 | Export and install the web PWA                                      | New release slice; after B02/A03                                                                                                                                   | Public HTTPS, correct login callback/API origin, installability and browser engine checks; iPhone Home Screen journey passes                                                                 |
| S2-D06 | Fix only release-blocking host backup/deploy defects                | Narrow [#190](https://github.com/Collaboration95/rewind-app/issues/190)                                                                                            | Reviewed backup/restore and release scripts work without manual architecture/image-ID workarounds; full automatic OFF orchestration is separate                                              |
| S2-D07 | Run a real-user end-to-end acceptance script                        | Extend [#145](https://github.com/Collaboration95/rewind-app/issues/145); [#203](https://github.com/Collaboration95/rewind-app/issues/203) remains evidence tracker | Non-author with preset accounts completes sign-in → invite → video/photo → sealed → chat/reminder → automatic release → playback/download on live web and APK; repeat and cross-group denial |

## Shared foundations and dependency order

The same verified principal/group authorization is needed by invites, uploads,
chat, Archive and downloads. Photo and video should share contribution states,
quota, media integrity and film output rather than create two unrelated
journeys. One cycle engine must drive the one-day Demo and four-week real group.
Web/native clients should share the API contract while preserving their
different camera and notification adapters.

### Usable increments and sequence

| Order | Increment that a member or teammate can actually use                                                                    | Parallel work that does not block it                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| First | Branded launch → welcome → preset real sign-in → create/join group → truthful Home, on web and an iOS development build | Native camera/backend repair; photo pipeline; separate environment plan |
| Next  | From that Home, capture and submit either a 15-second video or photo; return to Home with processing/sealed state       | Android APK packaging; installed PWA camera; chat authorization         |
| Next  | Group chat, prompts and reminder choices work in that same authenticated group                                          | Live dev deployment and remote reminder delivery                        |
| Next  | The group automatically reaches a safe film premiere, can play/download it, and starts a new four-week cycle            | Release deployment, physical device regression and recovery smoke       |

Start A01, A02, B01, and B03 immediately. A03/A04 unlock A05, then A07 and
real-group integration across B, C and D. B03/B04 and C04/C05 can proceed
against labelled Demo fixtures before A05 completes, then must be accepted
again with real members. D04 and the web build can proceed early; D07 closes
only after every underlying story passes. Aim to have the whole journey
feature-complete by the end of week one so week two can absorb device and
integration failures; this is an execution target, not a claim that the
current critical path is proven. A live dev URL enables remote team testing,
but is not a prerequisite to physical LAN camera work.

## Identity and environment choice for the pilot

Use an Amazon Cognito Lite user pool with direct email/password accounts,
administrator-created users, self-sign-up disabled, and MFA off initially.
The client uses authorization code with PKCE; the server verifies the token
and applies Rewind's own group membership rules. Cognito's published direct
user free allowance is 10,000 monthly active users on Lite/Essentials; email
delivery and some extras are billed separately. WorkOS AuthKit publishes a
larger free user allowance and an official Expo example, but production
requires billing details and its optional enterprise SSO and custom domain
have separate prices. The sponsor page is an endorsement, not a plan or price.
This recommendation can be changed in A01 before identity implementation.

Native OAuth/OIDC redirects require an Expo **development build** with a
custom scheme; Expo Go cannot test this login path. Keep `make run`/Expo Go
for camera and unauthenticated shell iteration, then install the development
build for the real end-to-end native flow. Register distinct web HTTPS and
native redirect URIs. The two live environments need separate Cognito app
clients and callback allowlists; use separate user pools if the pilot requires
strict identity isolation as well as data isolation.

The iteration loop is: run `make run` against a local/LAN backend for camera
and shell work, run `npm run test:fast` for code feedback, install a native
development build when validating login, and push reviewed `dev` changes to
the isolated live dev URL for colleagues. Promote a reviewed commit to `main`
only when a release update is wanted. The live dev environment must report
its deployed commit so a tester knows exactly which issue change they saw.

Use two simultaneously live Lightsail environments, each with its own app/API,
web URL and private data. This lets colleagues test the current `dev` build
while `main` remains a stable release. Existing Terraform uses fixed names
and one state key, so #230 must first split state, resource names, backups
and deploy scripts by environment. Review the concrete plan and cost before
provisioning; the second environment is an ongoing expense. See
[Lightsail pricing](https://aws.amazon.com/lightsail/pricing/).

Provider sources: [Cognito pricing](https://aws.amazon.com/cognito/pricing/),
[Cognito MFA configuration](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa.html),
[WorkOS pricing](https://workos.com/pricing),
[WorkOS production environments](https://workos.com/docs/authkit/environments),
and [Expo authentication guidance](https://docs.expo.dev/guides/authentication/).

## Existing issues outside the first product path

- [#164](https://github.com/Collaboration95/rewind-app/issues/164) SQS,
  [#165](https://github.com/Collaboration95/rewind-app/issues/165) and
  [#170](https://github.com/Collaboration95/rewind-app/issues/170) S3 migration,
  and [#175](https://github.com/Collaboration95/rewind-app/issues/175) RDS are
  implementation migrations. Keep the local durable worker and existing media
  storage until a measured user-story or recovery constraint requires a move.
- [#167](https://github.com/Collaboration95/rewind-app/issues/167) organization
  guardrails and [#174](https://github.com/Collaboration95/rewind-app/issues/174)
  GitHub-to-AWS OIDC applies are separate from **end-user** OIDC in A03/A04.
  Their current dependency on #168 should be removed during backlog sync.
- [#166](https://github.com/Collaboration95/rewind-app/issues/166) broad alarms
  and [#172](https://github.com/Collaboration95/rewind-app/issues/172) measured
  RTO/RPO can follow the minimum safe release diagnostics and backup proof.
- [#189](https://github.com/Collaboration95/rewind-app/issues/189) and
  [#208](https://github.com/Collaboration95/rewind-app/issues/208) are design
  inputs. Select one usable direction quickly and integrate it through A02,
  A07 and the story screens; the three-concept process is not a release gate.
- [#228](https://github.com/Collaboration95/rewind-app/issues/228) and
  [#229](https://github.com/Collaboration95/rewind-app/issues/229) already have
  implementation merged to `dev`; preserve their outstanding device/main
  acceptance instead of treating them as fresh feature work.

## Working decisions to record when applying the backlog

1. Cognito Lite owns pre-created email/password accounts; self-sign-up and
   MFA are off for the pilot. The exact callback domains and account reset
   process must be recorded before A03 is integrated.
2. Photos are full sealed group contributions in the released film, using the
   proposed three-second/one-slot policy above. A different product choice
   would change B03–B05, not the need for photo capture.
3. Run separate live dev and release hosts once D01 isolation is reviewed;
   preserve #230's cost and data boundary checks.
4. Evolve the existing shared five-tab UI now. Treat #189/#208 concepts as
   inputs to individual story screens instead of a blocking redesign.
5. Record any accepted implementation-stack differences from the original
   proposal (SQLite/local worker/media versus PostgreSQL/SQS/S3) in #169.

Do not mark a story complete because its unit tests pass or because a fixture
looks correct. The named person must be able to complete its action on the
specified device or live URL, and the relevant denial/failure state must be
observed.
