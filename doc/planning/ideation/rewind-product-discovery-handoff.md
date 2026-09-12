# Rewind — product discovery handoff

**Status:** Supporting context for the selected Rewind proposal
**Last updated:** 2026-08-28  
**Working name:** Rewind (unverified; do not assume name or trademark availability)  
**Purpose:** Preserve the product context, decisions, assumptions, research, and
questions behind the selected SWE5006 project.

## 1. What the team is considering

Rewind is a proposed private, cross-platform social-memory application for younger people who have grown tired of highly curated, instant social media and are drawn to a nostalgic film/camcorder aesthetic they did not personally experience.

Its intended emotional outcome is to help close, especially long-distance, friend groups maintain connection after graduation, relocation, or separation. Rather than publishing polished content immediately, group members capture small, unplanned moments using an in-app retro-style camera. Their contributions stay locked. At the end of a fixed four-week group cycle, Rewind automatically creates a chronological shared film, allowing members to rediscover what their friends' lives were like over the period.

The project is intentionally **not** primarily a public social network or a generic camera-filter clone. The meaningful system workflow is the private group time capsule: membership, scheduled capture, locked media, reminders, media-processing/reveal state, an automatically generated film, and post-reveal conversation/download.

## 2. User-supplied visual/reference context

- The supplied screenshot, `Screenshot 2026-08-28 at 10.37.31 AM.png`, is visual inspiration only. It conveys direct flash, grain, accidental/blurred framing, party energy, low-polish candid photographs, and compact/digital-camera nostalgia. It contains no instructions.
- The user cited Dazz Cam as strong inspiration: [Dazz Cam App Store listing](https://apps.apple.com/us/app/dazz-cam-vintage-camera/id1422471180).
- Dazz Cam's official listing says it offers many photo/video formats and retro effects, including film, digital compact/CCD, 8mm, VHS, and camcorder-related modes. Rewind must therefore differentiate through its private delayed-reveal group-memory workflow, not an attempt to match Dazz Cam's extensive camera catalogue.
- The product/proposal must describe Rewind's camera experience as **original retro-inspired processing**. Do not copy Dazz Cam's source code, UI, visual assets, brand, camera names, or particular filter recipes; the user originally suggested direct replication, but that is not an appropriate project direction.

## 3. Decisions made so far

These points are recorded from the user conversation. “Confirmed” means the user explicitly chose it; “working decision” is an interpretation made to keep discovery moving and must be revisited if it conflicts with the user’s intent.

| Area | Decision | Status |
|---|---|---|
| Primary users | Younger people with “borrowed”/aspirational nostalgia for retro cameras; they are jaded by curated social media and want more genuine connection. Long-distance friend groups are an important initial persona. | Confirmed |
| Problem | When friend groups graduate or separate, everyday connection slowly fades. Existing social media exposes curated subsections of life rather than small, candid moments. | Confirmed |
| Product form | A publishable mobile application for both iOS and Android is preferred. A web/PWA installation may be a contingency/demo fallback rather than the primary product. | Confirmed |
| Camera premise | Contributions should normally be captured through Rewind’s in-app camera, not imported from the gallery. Gallery import may be available only for test/demo purposes. | Confirmed |
| Camera experience | A small set of retro modes, live capture/preview, and camera-like touches such as flash/date treatment are desired. Video filters beyond the core effect may be difficult and should be bounded. | Confirmed |
| Filter IP boundary | Implement original effects inspired by broad film/disposable/compact/camcorder aesthetics; never promise to replicate Dazz Cam exactly. | Working constraint |
| Group privacy | The MVP is invite-only private groups, with no public feed, discovery, followers, hashtags, or public profiles. | Confirmed |
| Default rhythm | One group cycle is four weeks, measured from the group’s start date rather than calendar months. | Confirmed |
| Reveal and archive | At the four-week boundary, the group film premieres for 24 hours and the next capture cycle starts immediately. The revealed film then remains permanently accessible in the group archive. | Confirmed |
| Demonstration cycle | The normal product configuration is four weeks, but the cycle duration is configurable. The test/demo environment will use one-day cycles to demonstrate capture, processing, reveal, and a new cycle without a month-long wait. | Confirmed |
| Group size | Support groups of 2–10 members; use a five-person group for acceptance testing/demonstration. | Confirmed |
| Weekly contribution budget | Each member may create up to five clips per week. Each clip is at most 15 seconds. The combined weekly duration is at most 30 seconds. | Confirmed |
| Weekly reset | The weekly capture allowance resets every seven days from the group’s cycle start date. | Confirmed |
| Submission medium | Submissions are video by default. Static-image contribution is not in the confirmed MVP; the earlier idea of turning photos into short video segments is superseded unless revisited. | Confirmed, wording needs UX clarification |
| Locked media | Before reveal, a contributor cannot replay their clip and sees no thumbnail. They can see only capture metadata, for example number of submissions and used seconds. | Confirmed |
| Correction allowance | A contributor may delete one clip per week before the relevant weekly/cycle cutoff. Exact replacement rules still need definition. | Confirmed |
| Correction outcome | Deleting the single allowed weekly clip restores the corresponding clip-count and duration allowance so the member can retake it. | Confirmed |
| Compilation | At the four-week boundary, the system automatically compiles a chronological group film. The edit can be visually organised day by day inside the output video; the app does not need a separate browsable day-by-day feed. | Confirmed |
| Low-contribution filler | If a group film does not meet its baseline duration, use a prior memory from the relevant member; if no such memory is available, use a randomly selected past memory. Consent/control for resurfacing old media remains unresolved. | Confirmed, policy incomplete |
| Group camera style | Members choose their own camera style in the MVP. A shared group style is stretch scope. | Confirmed |
| Candidate camera modes | The user delegated the initial selection. A sensible four-mode MVP candidate is: disposable flash, compact digital/CCD, 8mm home-movie, and VHS/camcorder. | Working recommendation |
| Capture experience | The app opens directly to its video camera. The member chooses a retro mode, records, then submits. Ordinary photo mode is not part of the finished core product. | Confirmed |
| Processing approach | Apply the original retro treatment after capture before upload. Live effect preview is a future extension, not part of the finished core. | Confirmed |
| Video limits | Capture vertical video only, at 720p, up to 15 seconds per clip, and permit trimming before the member submits. | Confirmed |
| Chat | Normal real-time group chat includes text messages, reactions, and replies. Read receipts, typing indicators, general attachment uploads, edits, and deletion are deferred. Two-person groups cover the direct-message use case without a separate DM product. | Confirmed |
| Membership changes | Leave/remove/history handling is stretch scope for now. | Confirmed |
| Authentication | Use standards-based OpenID Connect (OIDC). The initial preferred implementation is Amazon Cognito User Pools as the managed OIDC provider, rather than building credential handling ourselves. | Confirmed direction |
| Invitation | Use expiring deep links that open the native app when installed and use the PWA/web flow otherwise. | Confirmed |
| Account deletion and leaving groups | Account deletion, leaving a group, and removal workflows are stretch scope, not basic MVP workflow. This needs an explicit privacy/retention limitation in the proposal. | Confirmed |
| Retention | Retain only processed, retro-styled media in the cloud; do not retain the original unfiltered upload after processing succeeds. | Confirmed |
| Audio | Preserve source audio in the compiled film and normalise its volume. Do not add licensed background music in the MVP. | Confirmed |
| Download | After reveal, members may download both the combined group film and their own processed clips. | Confirmed |
| Prompts | Group owners can choose prompts, while ordinary/default prompts must also be available. | Confirmed |
| Prompt authoring | Group owners may select a built-in prompt or write a short custom prompt. | Confirmed |
| Reminder | Default to one weekly reminder on Sunday at 7pm in the group’s local time; members can snooze or disable reminders. | Confirmed |
| Group ownership | The group creator is the one owner and may rename the group and choose prompts. Owner transfer, removal, and departure workflows are out of scope for the first delivery. | Confirmed |
| Archive filler | The system can reuse old clips without a per-member opt-in. Reused segments must be visibly labelled “From the archive”. | Confirmed |
| Processing failure | Compilation jobs retry automatically; after bounded retries, Rewind informs the group that the film is delayed and exposes a safe status. | Confirmed |
| Image-only social posting | A filtered-image social-post feature is stretch scope, not part of MVP. | Confirmed |
| Team | Five members. Use placeholder roles/names for now; later proposal assigns each a use case and design-pattern problem. | Confirmed |
| Deployment and cost | Cloud deployment is expected. AWS is the initial preference, with the lowest feasible cost while still demonstrating DevSecOps. | Confirmed |
| AWS access | The team has access to an AWS account and can use a payment card/credits for a small deployment. | Confirmed |
| AWS Device Farm | It is not required for course fit. It is an optional later validation tool, not an MVP dependency. | Working recommendation |
| Release fallback | The team is considering an Expo web/PWA deployment if native APK/iOS delivery cannot be achieved. This is technically viable from the same codebase, but native mobile remains the primary product target. | Confirmed direction; acceptance target unresolved |
| Release target | Deliver both native mobile builds (Android APK and iOS build/preview, subject to developer-account access) and an installable PWA from the same codebase. | Confirmed |
| Usability evidence | Five people are available to participate in a one-day-cycle pilot and provide brief usability feedback. Use synthetic/non-sensitive clips for formal demonstration material. | Confirmed |
| Name | Use Rewind as the working proposal/product name. | Confirmed |

## 4. Important unresolved questions

These questions may affect implementation details, requirements, architecture,
privacy, and future scope. The selected proposal records the current scope;
resolve these items through implementation decisions unless they materially
change that scope.

The core scope is now sufficiently resolved to draft the proposal. Remaining details should be handled during implementation unless they change the scope materially:

1. Exact group time-zone and daylight-saving policy.
2. Final maximum upload size and the detailed recording/trim UX.
3. Whether an old filler clip may be reused more than once.
4. Developer-account availability and store-submission prerequisites for public release.
5. Final team names, sponsor details, and cloud region/credit budget.

## 5. Comparable-product and technical research

### 5.1 Comparable-product implications

| Reference | Relevant observed pattern | Rewind’s differentiation / design implication |
|---|---|---|
| [1 Second Everyday help centre](https://help.1se.co/en/articles/966670-what-is-1se) | Individual video diary: users capture snippets and create a chronological timeline/movie, with reminders and multi-period compilations. | Rewind borrows the lightweight recurring-capture and automatic compilation idea, but makes the unit a private friend group with locked contributions and a shared scheduled reveal. |
| [1SE Android quick start](https://help.1se.co/en/articles/10290888-quick-start-guide-for-1-second-everyday-on-android) | Supports in-app capture or gallery import, clip trimming, automatic calendar arrangement, reminders, and mashup export. | Rewind deliberately requires in-app capture for authentic/consistent participation (gallery input is test-only) and removes pre-reveal browsing/editing. |
| [Lapse official FAQ](https://www.lapse.com/) | Presents itself as a disposable-camera-inspired, friends-only private journal opposed to follower/like-driven curation; its documented controls include unfriend, block, report, and account deletion. | Rewind should not pitch private retro photography alone as novel. Its central distinction is the multi-member, audio-preserving, four-week locked time capsule and auto-generated group film. Lapse also demonstrates that basic account/privacy controls are reasonable, not excessive, even for a private product. |

### 5.2 Practical mobile and cloud direction

**Recommended provisional architecture:** a cross-platform React Native application built with Expo development builds; a modular cloud backend on AWS; asynchronous media compilation; and a conventional relational database.

```text
iOS / Android React Native app
  ├─ device camera + original retro effects
  ├─ device notification token + local UI state
  └─ HTTPS / short-lived upload URL
       │
       ▼
AWS API (modular monolith)
  ├─ identity, groups, invites, membership, chat, prompts
  ├─ contribution rules, cycle state, reveal policy, download audit
  ├─ signed upload issuance and media metadata
  ├─ schedule/retry/orchestration and notification jobs
  └─ PostgreSQL
       │                         │
       ├─ private S3 media bucket │
       ▼                         ▼
asynchronous media worker / MediaConvert   Expo push service → APNs / FCM
  ├─ validate/transcode processed clip
  ├─ delete original upload after success
  ├─ normalise audio and concatenate chronological clips
  └─ write processed clip + final group film to private S3
```

- Expo’s SDK provides camera access; its Camera documentation includes video recording and Android audio-permission requirements. This makes Expo/React Native credible for basic cross-platform video capture, but fully custom real-time GPU filter previews may require a native library/module or a more limited first release. See [Expo Camera documentation](https://docs.expo.dev/versions/v54.0.0/sdk/camera/).
- Expo can export the same codebase to a website and add a web manifest/service worker to make it installable as a PWA. However, Expo itself recommends native apps for the best offline mobile experience, and web permissions/camera features need HTTPS. Treat the PWA as a viable contingency/demo path, not an equivalent substitute for native capture and push. See [Expo PWA guidance](https://docs.expo.dev/guides/progressive-web-apps/) and [Expo web publishing](https://docs.expo.dev/guides/publishing-websites/).
- Expo Push Notifications provides one interface over Apple Push Notification service and Firebase Cloud Messaging. Push delivery needs token cleanup, retry, and receipt checking; it is not a guaranteed clock. See [Expo push-notification overview](https://docs.expo.dev/push-notifications/overview/) and [delivery guidance](https://docs.expo.dev/push-notifications/sending-notifications/).
- Amazon Cognito User Pools can act as the project’s OIDC provider, issue JWTs, provide a managed sign-in UI, and federate future Google/Apple login if needed. The lowest-cost model is to use Cognito itself as Rewind’s OIDC issuer with direct local users, not federate through another OIDC provider: AWS currently publishes a 10,000-MAU free tier for direct/social User Pool sign-in, while users federated through an external OIDC/SAML provider have only a 50-MAU free tier. Do not enable paid advanced-security features for this five-person prototype. See [Cognito managed login](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-managed-login.html) and [Cognito pricing](https://aws.amazon.com/cognito/pricing/).
- A private S3 bucket with short-lived, narrowly scoped upload URLs lets the app upload media without giving devices general AWS credentials. The relevant AWS guidance is [Uploading objects with presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html). Never make the media bucket public; issue authenticated short-lived download URLs instead.
- AWS Elemental MediaConvert can create a job with multiple ordered inputs and produces concatenated output, and is a viable managed option for the four-week compilation. It reads/writes S3 and needs its own restricted IAM role. See [AWS MediaConvert job configuration](https://docs.aws.amazon.com/mediaconvert/latest/ug/setting-up-a-job.html). A containerised FFmpeg worker is a valid alternative if MediaConvert cost/complexity is unsuitable; compare them before proposal finalisation.
- AWS Device Farm can run an uploaded Android APK or iOS IPA against real hosted devices, but it is available only in `us-west-2` and should not dictate the application region or MVP. See [AWS Device Farm getting started](https://docs.aws.amazon.com/devicefarm/latest/developerguide/getting-started.html). Emulator/physical-device testing plus automated backend tests is enough for the base evidence plan.

### 5.3 Cost and scope guidance

- Treat app-store publication as a possible post-project outcome, not a required academic acceptance criterion; it introduces account, signing, review, and compliance dependencies.
- Keep the demonstration group to five and clips very short. A worst-case cycle has 25 clips and at most 150 seconds of new contributed video before filler. This bounded media volume keeps end-to-end compilation demonstrable.
- Do not promise 24/7 production availability, massive storage, public discovery, commercial-scale moderation, licensed music, or App Store acceptance in the proposal.
- The project can convincingly demonstrate DevSecOps with containerised services, infrastructure as code, CI quality/security checks, staged cloud deployment, synthetic media fixtures, and smoke tests. It does not need a costly full device-farm program.

## 6. Course-fit implications

The project is a good candidate for SWE5006 because it has meaningful end-to-end behaviours beyond CRUD:

1. invite-only identity and group access control;
2. weekly capture budget and locked-contribution lifecycle;
3. four-week scheduling, state transitions, retries, and reveal orchestration;
4. deterministic chronological media assembly with validation/audio normalisation/failure handling;
5. notifications with delivery receipts/retries and user settings;
6. private real-time chat; and
7. cloud deployment, media storage, security controls, test automation, CI/CD, and operations evidence.

The supplied report template requires each team member to own at least one use case and at least one design-problem/pattern discussion, including analysis and design models. A likely five-person split (not yet final) is:

| Placeholder owner | Candidate owned use case | Candidate design problem |
|---|---|---|
| A | Sign in, invite, and manage private group membership | Apply authorisation/retention policies consistently across API, storage, chat, and worker paths (Policy/Strategy or Chain of Responsibility) |
| B | Capture, validate, upload, lock, and delete weekly contributions | Represent contribution/cycle state transitions and enforce time/clip budgets (State + Specification) |
| C | Create/retry/monitor compilation and publish an ordered group film | Route media-processing job stages/failures without hard-coded workflow branches (Command/Chain of Responsibility) |
| D | Configure prompts/reminders and deliver reliable notifications | Choose notification schedule/channel/retry behaviour without coupling domain rules to a provider (Strategy + Adapter) |
| E | Join group chat, view final films, react, and download | Render timeline/reveal/media states without a large conditional UI component (State/Strategy/Factory) |

This allocation is deliberately provisional. It will be adjusted after chat, archive, and group-membership rules are frozen.

## 7. Active planning files

The following retained files are the current working set. This is a record of
how the documents fit together, not an instruction to duplicate their content.

| File | Why it matters to Rewind |
|---|---|
| `planning/context/project-brief.md` | Derived but source-backed summary of project requirements and quality bar. |
| `planning/proposals/proposal-rewind.md` | Full Rewind project scope, acceptance plan, architecture, course evidence, effort, and risks. |
| `planning/sprints/sprint-0-plan.md` | First implementation slice, capacity, user stories, workflow, and demonstration plan. |
| `README.md` | Entry point for the active five-file planning set. |

## 8. External sources reviewed so far

1. [Dazz Cam — App Store](https://apps.apple.com/us/app/dazz-cam-vintage-camera/id1422471180) — current reference-product capabilities and stated camera categories.
2. [1 Second Everyday — What is 1SE?](https://help.1se.co/en/articles/966670-what-is-1se) — daily snippets, reminders, automated timeline/movie.
3. [1SE — Android quick start](https://help.1se.co/en/articles/10290888-quick-start-guide-for-1-second-everyday-on-android) — capture/import, trim, auto arrangement, export, reminders.
4. [Lapse — official site/FAQ](https://www.lapse.com/) — friends-only/disposable-camera positioning and published account-safety controls.
5. [Expo Camera](https://docs.expo.dev/versions/v54.0.0/sdk/camera/) — video capture feasibility and Android audio permissions.
6. [Expo PWA guidance](https://docs.expo.dev/guides/progressive-web-apps/) and [web publishing](https://docs.expo.dev/guides/publishing-websites/) — PWA configuration and web deployment caveats.
7. [Expo Push Notifications overview](https://docs.expo.dev/push-notifications/overview/) and [delivery guidance](https://docs.expo.dev/push-notifications/sending-notifications/) — cross-platform push workflow and reliability behaviour.
8. [Amazon Cognito managed login](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-managed-login.html) and [pricing](https://aws.amazon.com/cognito/pricing/) — managed OIDC and low-volume pricing direction.
9. [Amazon S3 presigned upload URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html) — secure client upload pattern.
10. [AWS MediaConvert job configuration](https://docs.aws.amazon.com/mediaconvert/latest/ug/setting-up-a-job.html) — ordered multi-input media jobs and S3 output.
11. [AWS Device Farm getting started](https://docs.aws.amazon.com/devicefarm/latest/developerguide/getting-started.html) — hosted-device test capabilities and region limitation.

## 9. Recommended next steps

1. Resolve the 13 open questions in Section 4, prioritising reveal/archive semantics, chat boundary, authentication/invites, and membership/account controls.
2. Record final scope choices in the proposal or sprint plan as they are agreed.
3. Refine `planning/proposals/proposal-rewind.md` only when an agreed scope change requires it.
4. Keep the MVP bounded with explicit exclusions and a clear definition of done using a synthetic five-member group.
5. Choose the actual stack after confirming available AWS credits and app-store/developer-account constraints; do not promise real-time shader filters until a prototype proves them.
6. Create a backlog and accept/reject stretch work only after the complete capture-to-reveal vertical slice is working.
