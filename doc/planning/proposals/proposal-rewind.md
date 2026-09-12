# Project proposal: Rewind — private group time capsules

**Status:** Draft for lecturer confirmation  
**Version:** 0.1  
**Last updated:** 2026-08-28  
**Team assumption:** Five members, approximately 80 implementation hours each

> **Effort boundary:** The 400-person-hour estimate covers implementation,
> integration, automated testing, cloud deployment, DevSecOps automation, and
> hardening. It excludes planning meetings, Agile ceremonies, reports, and
> presentation preparation.

## 1. Project title

**Rewind: Private group time capsules**

## 2. Sponsor and project members

| Role | Name/contact | Responsibility |
|---|---|---|
| Sponsor | To be confirmed / no company sponsor assumed | Target-user feedback, if available |
| Member A | To be confirmed | OIDC, groups, invitations, and access-policy design |
| Member B | To be confirmed | Camera capture, contribution lifecycle, and budget rules |
| Member C | To be confirmed | Media processing, compilation, archive, and job workflow |
| Member D | To be confirmed | Chat, prompts, reminders, and notification policy |
| Member E | To be confirmed | Mobile/PWA experience, archive states, and accessibility |

## 3. Overview

### 3.1 Background and problem

Mainstream social media encourages immediate, polished, highly curated posting.
After graduation, relocation, or other separation, close friend groups can slowly
lose the small everyday contact that sustained their connection. Individual video
diaries preserve memories, but do not create a private shared experience for a
friend group.

Younger users are also drawn to the imperfect look of disposable film, compact
digital cameras, and home camcorders. A short, dimly lit, unplanned recording
can become meaningful when rediscovered later; the value is the memory, not
photographic perfection.

### 3.2 Proposed outcome

Rewind will be an invite-only group memory application delivered initially as an
Android application and an installable web/PWA. The PWA will support modern
mobile browsers, including iOS Safari/Home Screen web apps. The architecture
will preserve a future path to a native iOS client without changing the backend
or user data model. Members capture short vertical clips using Rewind's in-app
camera. The temporary source is uploaded for asynchronous processing, after
which the application locks the processed clip until release.

Each group has a four-week cycle. Every seven days from the cycle start, a member
may submit up to five clips, totalling no more than 30 seconds; each clip is at
most 15 seconds. The member may delete and replace one clip each week. Before
release, they see only contribution metadata, not clips or thumbnails.

At the cycle boundary, Rewind automatically creates a chronological group film
using normalised source audio. It premieres for 24 hours, stays in the private
archive, and the next cycle starts immediately. Members can chat, react, reply,
and download the final group film or their own processed clips.

The same cycle engine will be configurable to one day for the classroom
demonstration. This demonstrates capture, processing, release, and a new cycle
without waiting four weeks.

Rewind will include a small set of original modes inspired by disposable flash,
compact digital/CCD, 8mm home-movie, and VHS/camcorder aesthetics. It will not
copy another application's branding, user interface, assets, camera names,
source code, or exact filter recipes.

### 3.3 Stakeholders

| Stakeholder | Need/interest | Involvement |
|---|---|---|
| Young adult friend group | Maintain low-pressure, genuine connection across distance | Primary user and pilot-test persona |
| Group owner | Create private group, invite users, name group, and choose prompts | Defines ownership/invitation scenarios |
| Group member | Capture a moment, receive a reminder, and view released group memories | Defines core acceptance flows |
| Platform operator | Deploy and recover service without viewing private media | Uses health checks, safe logs, and job metrics |
| Lecturer/reviewer | Assess scope, engineering design, implementation, and evidence | Reviews proposal, demo, report, and presentation |

### 3.4 Constraints and assumptions

- This is a proof of concept, not a public commercial social network.
- One TypeScript/React Native/Expo codebase targets an Android native app and an
  installable PWA. The PWA supports modern mobile browsers, including iOS
  Safari/Home Screen web apps; native iOS is a future extension that does not
  require changes to the backend or user data model.
- The installable PWA will be physically validated on at least one iPhone for
  camera and microphone permission, video recording, foreground upload,
  authentication, chat, and released-film playback.
- AWS deployment will use one region and cost-conscious services, subject to
  available credits and account access.
- A five-user group can complete a one-day-cycle pilot. Formal demonstration
  material will use synthetic or non-sensitive clips.
- Groups support 2–10 users; the demo uses five.
- Only processed media is retained after successful processing. The unfiltered
  temporary input is removed.
- A downloaded film can be re-shared by a user, so privacy is enforced in the
  application boundary rather than promised beyond it.
- AI assistance, if used, will be disclosed in the course-required format.

## 4. General architecture

Rewind will use a modular monolith with an asynchronous media worker. The API,
domain rules, chat, and operations endpoint remain in one application boundary;
the worker handles slow or failure-prone media and scheduling work.

    Android native app and installable web/PWA
      -> PWA surfaces: iPhone/Home Screen, Android, and desktop
      -> OIDC sign-in, camera, contribution progress, chat, archive
      -> HTTPS / WebSocket / short-lived upload URL
    Cloud modular monolith
      -> group, invitation, cycle/budget, chat, prompt, archive policy
      -> PostgreSQL: metadata, membership, messages, jobs, audit events
      -> notification policy -> notification adapters
         -> Expo/FCM provider -> Android native app
         -> Web Push provider -> installed PWA
    Temporary private object storage
      -> SQS -> asynchronous FFmpeg worker
      -> validate, canonical transcode, apply retro treatment, normalise audio
      -> delete temporary source after successful processing
      -> processed private object storage
      -> cycle-end compilation job: order clips, add labelled archive filler,
         normalise audio, compile/publish film, or report safe delayed status

| Area | Candidate | Rationale |
|---|---|---|
| Client | React Native, Expo, TypeScript | One codebase for the Android native app and installable web/PWA; future native iOS path |
| API and worker | TypeScript service with FFmpeg media worker | Shared types and explicit control of domain/media rules |
| Identity | Amazon Cognito User Pools through OIDC | Managed standard identity without building password storage |
| Database | PostgreSQL | Groups, memberships, clips, jobs, prompts, chat, and audit metadata |
| Media | Private Amazon S3 object storage | Controlled temporary uploads and private processed clips/films |
| Scheduler/queue | Amazon EventBridge Scheduler and Amazon SQS | Isolates retries, reminders, and media jobs |
| Notifications | Expo/FCM for Android; standards-based Web Push for installed PWA | Provider adapters keep platform-specific delivery behind a common notification policy |
| Delivery | Docker, Terraform, Git-based CI/CD | Repeatable infrastructure and delivery evidence |

Clips are vertical 720p, up to 15 seconds, and may be trimmed before submission.
The client uploads a temporary source after capture; the FFmpeg worker applies
retro processing and removes the unfiltered source after successful processing.
Live filter previews are stretch scope.

## 5. Scope of work

### 5.1 Finished core scope

| ID | Requirement | Demonstrable acceptance outcome |
|---|---|---|
| FR-01 | Identity and private groups | A user signs in through OIDC and cannot access another group's data, chat, media, or downloads. |
| FR-02 | Create group and invite | The creator is one owner, can name the group/select prompts, and issues an expiring invitation link. |
| FR-03 | In-app capture | A member selects an original retro mode, records and trims a vertical clip, and uploads the temporary source using a short-lived upload URL. The asynchronous media worker applies the selected retro treatment, validates/transcodes the result, retains the processed clip, and removes the temporary unfiltered source after successful processing. Gallery import is fixture support only. |
| FR-04 | Contribution lifecycle | The system enforces weekly clip/time limits, permits one delete-and-recapture, and locks media before release. |
| FR-05 | Prompts and reminders | Owner selects a library or short custom prompt; members receive a Sunday 7pm local-time reminder and can snooze/disable it. Android app notifications use the native provider; installed PWA clients use standards-based Web Push where supported. On iOS, Web Push requires Rewind to be installed as a Home Screen web app. |
| FR-06 | Group chat | Authorised members exchange text messages, reactions, and replies. |
| FR-07 | Automatic film | At cycle end, the worker orders clips, normalises audio, compiles/releases the group film, and starts the next cycle. |
| FR-08 | Recovery and filler | Compilation jobs retry; bounded failures show a delayed-release status. Short films may use clearly labelled From the archive clips. |
| FR-09 | Archive and download | Members view released films and download the group film or their own processed clips. |
| FR-10 | Safe operations | Operators inspect health, jobs, latency, and notification outcomes without viewing private media or secrets. |

### 5.2 Primary use cases and ownership

| Use case | Primary actor | Main flow | Owner |
|---|---|---|---|
| UC-01 Sign in, create group, invite member | Group owner | Authenticate, create private group, issue and accept valid invite | Member A |
| UC-02 Capture and lock contribution | Member | Select mode, record/trim/upload/process, enforce budget, show locked metadata | Member B |
| UC-03 Compile and publish time capsule | Worker/operator | Validate inputs, process/retry compilation, publish or safely delay film | Member C |
| UC-04 Choose prompt and deliver reminder | Owner/member | Select prompt, schedule/send/retry notification, respect settings | Member D |
| UC-05 Chat and view/download archive | Member | Send/reply/react, render archive state, obtain authorised download | Member E |

Important exceptional flows include invalid/cross-group invites, cross-group access,
oversize or interrupted upload, exceeded budget, second deletion, no archive
filler, invalid notification token, processing timeout/retry exhaustion, expired
download URL, and delayed release.

### 5.3 Explicit exclusions

- Public profiles, discovery, follower graphs, hashtags, advertising, or public
  feed.
- The image-only social-post feature.
- Normal gallery import, long-form video, live streaming, or public sharing.
- Exact imitation of Dazz Cam or any other product.
- Live filter previews, many camera modes, licensed music, complex video editing,
  captions, or AI-generated edits.
- Chat attachments, read receipts, typing indicators, message edit/delete, and
  separate direct-message infrastructure.
- Owner transfer, member removal, leave/rejoin, account deletion, reporting, or
  commercial-scale moderation.
- Multi-region reliability, subscriptions, billing, large-scale throughput,
  native iOS development, public app-store submission, and app-store approval
  guarantees.

### 5.4 Core versus stretch

**Core:** private OIDC groups and invitations; post-capture retro video;
contribution rules; prompts/reminders; text/reaction/reply chat; asynchronous
film creation; archive/download; Android native and installable PWA delivery,
including physical iPhone PWA validation; native iOS is a future extension; and
cloud deployment, testing, and DevSecOps evidence.

**Stretch:** image-only private posts; live camera previews and additional modes;
shared group camera style; account/group-membership controls; richer chat;
direct provider integrations; and other richer client capabilities.

### 5.5 Definition of done

Using a five-user synthetic/non-sensitive group and one-day test-cycle setting,
a clean cloud deployment can demonstrate:

1. OIDC sign-in and cross-group access denial.
2. Valid invitation acceptance and invalid-invitation rejection.
3. Capture, trim, upload, process, lock, delete, and recapture while enforcing
   weekly rules.
4. Prompt/reminder delivery with disabled-setting and retry paths.
5. Authorised text, reaction, and reply chat.
6. Chronological film compilation with normalised audio and labelled archive
   filler when applicable.
7. Media-job retry and safe delayed-release behaviour.
8. Authorised archive viewing/download.
9. Automated deployment and authenticated smoke tests.
10. Complete the capture → upload → process → lock → reveal → playback workflow
    from an iPhone using the installed PWA.

## 6. Quality attributes and acceptance targets

| Quality attribute | Target/test |
|---|---|
| Privacy and access control | Automated negative tests prove non-members cannot access another group's chat, clip, signed URL, archive, or download. |
| Reliability | Contribution/compilation work is idempotent and retryable; no failed or partial result is released. |
| Performance | On five-user fixtures, metadata/chat APIs target p95 below 2 seconds; the one-day test-cycle film completes in a documented bounded window. |
| Cross-platform compatibility | The complete capture → upload → lock → reveal → playback flow passes on the Android APK and an installed iPhone PWA using physical devices. Platform-specific capabilities such as notifications are exercised through their corresponding adapters. |
| Usability | Pilot users can join, capture, understand locked status, and find a released film without command-line help. |
| Maintainability | Typed contracts, modular boundaries, tests for each use case, at least 70% application-code coverage, and stronger coverage for state/policy/worker logic. |
| Observability | Correlation IDs, safe logs, health, job state, processing duration, notification receipts, and actionable safe errors. |
| Repeatable delivery | Versioned infrastructure deploys a tested artifact and runs authenticated synthetic smoke tests. |

## 7. Course alignment and evidence

| Course area | Planned evidence |
|---|---|
| Agile Practices | Backlog, user stories/acceptance criteria, short sprints, estimates, burndown, reviews, retrospectives, working increments, CI history, TDD/pair-review/refactoring evidence. |
| Software Analysis and Design | Stakeholders, use-case diagram/descriptions, domain/database model, architecture, transition strategies, and analysis/design class/sequence diagrams for every owned use case. |
| Software Design Patterns | Five design problems with alternatives, rationale, before/after diagrams, and running implementation. |
| DevSecOps | Git/PR strategy, tests, lint/type checks, SCA, secret scanning, SAST, image scan, SBOM, Terraform, cloud deployment, smoke tests, rollback notes, and safe monitoring. |
| AI disclosure | Clear course-required declaration of assistance and human review/testing responsibility. |

## 8. Design problems and patterns

| Member | Design problem | Candidate patterns | Implementation evidence |
|---|---|---|---|
| A | Apply group/media policy consistently across API, chat, storage URLs, and jobs | Policy/Strategy, Chain of Responsibility, Decorator | Central policy decision and negative authorisation tests |
| B | Model recording, processing, locked, deleted, failed, and released clip behaviour | State, Specification | Clip state machine and reusable budget checks |
| C | Run validation, processing, retry, filler, and publish steps safely | Command, Chain of Responsibility, Template Method | Ordered idempotent compilation workflow |
| D | Keep schedule/provider/retry policy replaceable | Strategy, Adapter, Observer | Notification policy and provider adapter |
| E | Render capture, locked, pending, delayed, premiere, and archive UI states | State, Factory, Strategy | Typed view-model/renderer registry and UI tests |

## 9. DevSecOps and lifecycle plan

- **Source control:** Protected main branch, short-lived feature branches, pull
  requests/review, focused conventional commits, and no secrets or private media
  in Git.
- **CI:** Build, type/lint/format, unit/integration/API/worker tests, coverage,
  synthetic media fixtures, SCA, secret scanning, SAST, container scanning, and
  SBOM generation.
- **CD:** Terraform provisions one cloud environment; versioned API/worker
  containers are deployed, then OIDC/group/capture/job/archive smoke tests run.
- **Security/operations:** Least-privilege runtime roles, private media storage,
  short-lived URLs, safe structured logs, health/job metrics, test-media cleanup,
  retained previous artifact, and documented migration/job-safe rollback.

## 10. Implementation effort estimate — 400 person-hours

| Work package | Lead | Hours |
|---|---|---:|
| OIDC, groups, invitations, and authorisation | Member A | 58 |
| Camera capture, trim, upload, and clip lifecycle | Member B | 68 |
| Retro media processing, FFmpeg worker, audio normalisation, compilation, archive, and retries | Member C | 74 |
| Chat, prompts, reminders, and notification adapter | Member D | 58 |
| Android/PWA user experience, cross-platform validation, archive/download, and accessibility | Member E | 52 |
| Automated tests, fixtures, resilience evidence, and pilot fixes | All | 44 |
| CI/CD, Terraform, security checks, observability, and smoke verification | A/D/E | 32 |
| Integration hardening and release rehearsal | All | 14 |
| **Total implementation effort** |  | **400** |

## 11. Risks, assumptions, and mitigations

| Risk/assumption | Impact | Mitigation |
|---|---|---|
| Camera effects take longer than expected | Core scope can slip | Start with four bounded post-capture presets; make live preview stretch. |
| Media format/cost/failure variability | Delayed films or excess spend | Enforce 720p/duration/upload limits, use fixtures, lifecycle cleanup, retries, and cost monitoring. |
| One-day demo masks four-week scheduling faults | False confidence | Use one cycle-state engine with automated tests for both durations. |
| Push notifications are not guaranteed | Reminder missed | Platform provider adapters, preferences, receipts, invalid-token removal, retry, and visible in-app cycle status. |
| Mobile PWA platform differences | Camera, notification, or upload behaviour may differ on iOS/WebKit | Physically test the complete PWA workflow on iPhone early; require HTTPS; use capability detection; keep uploads foreground-visible; provide safe in-app status when push is unavailable. |
| Scope expands into full social network/chat | Core may not finish | Enforce exclusions and start stretch only after definition of done passes. |
| Private media appears in URL/log | Privacy failure | Private bucket, short-lived URLs, central policy, safe logs, secret scanning, negative tests. |

## 12. Open decisions for lecturer/team confirmation

- Final member names, contacts, and sponsor information.
- AWS region, exact hosting services, cloud credit budget, and access method for
  the demonstration.
- Exact upload-size limit, group time-zone/DST rule, and archive-filler reuse
  policy.
- Minimum supported mobile-browser/PWA versions and physical-device acceptance
  matrix: Android native device, Chrome on Android, Safari/iPhone Home Screen,
  and desktop Chrome/Safari.
- Required UML notation, AI-use declaration, and security/pipeline tooling.

## 13. Approval checklist

- [x] Specific user problem and target user are clear.
- [x] Core scope, stretch scope, and exclusions are bounded.
- [x] Architecture is credible for a five-person proof of concept.
- [x] Every member owns a use case and a design-pattern problem.
- [x] Agile, analysis/design, DevSecOps, testing, and security evidence are planned.
- [x] Implementation estimate totals 400 hours.
- [ ] Team, sponsor, cloud, and lecturer-specific requirements are confirmed.
