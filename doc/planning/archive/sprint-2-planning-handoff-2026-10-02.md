# Rewind Sprint 2 planning handoff

- **Research date:** 2 October 2026, Asia/Singapore
- **Status:** Evidence-gathering handoff for owner review and subsequent Sprint Planning
- **Planning horizon:** The remainder of Sprint 2, ending 10 October 2026
- **Next Sprint:** Sprint 3, 11–24 October 2026

This document consolidates the initial investigation into the submitted proposal, repository plans,
live GitHub backlog, integrated implementation, acceptance evidence, and development tooling. It is
not an agreed Sprint Backlog, an implementation authorization, or a completion report. The owner
will review it before a larger model uses it to plan the rest of the Sprint.

## 1. Objective and main conclusion

The owner's objective is to deliver the proposed Rewind product while working faster: identify the
right issues, avoid getting trapped in peripheral edge cases, finish useful increments, clean up
misleading planning state, and reduce unnecessary agent and verification overhead.

**Optimize for a usable, private capture-to-reveal journey, not the number of issues closed.**

Several features already have merged implementations but lack real-user acceptance. Important parts
of the submitted product are outside the current execution board. Therefore, treating all open
issues as equally valuable, or treating every open issue as unimplemented, would produce the wrong
execution strategy.

The investigation was read-only with respect to the project checkout, GitHub, and AWS. Existing
source and CI evidence were inspected; no new test suite, simulator session, deployment, or cloud
operation was run. Temporary research snapshots were written outside the project under
`/private/tmp/`.

## 2. Workspace and source map

### Authoritative project workspace

```text
/Users/speedpowermac/Documents/projects/CODE_MAIN/NUS/SWE5006/rewind-app
```

The authoritative repository is `Collaboration95/rewind-app`.

| Source                            | Location                                                                                                | Role and qualification                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Submitted documentation           | `/Users/speedpowermac/Downloads/rewind-project.docx`                                                    | Owner-provided submitted requirements, architecture diagram, quality targets, scope, and exclusions. Its text and embedded architecture diagram were inspected. This was a content review, not a rendered-page layout audit. |
| Planning index                    | `doc/README.md`                                                                                         | Entry point and canonical Sprint dates.                                                                                                                                                                                      |
| Repository proposal               | `doc/planning/proposals/proposal-rewind.md`                                                             | Earlier baseline with a later pilot-scope annotation. It is not identical to the submitted DOCX.                                                                                                                             |
| Complete product journey          | `doc/planning/sprints/sprint-2-user-journey-plan.md`                                                    | Intended journey, checkpoints, proposed issue map, and dependency discussion. Its recorded implementation baseline is not current acceptance evidence.                                                                       |
| Accepted technical direction      | `doc/planning/sprints/base-plan.md`                                                                     | Architecture choices recorded through #238 and #169. It is a plan, not authorization to provision.                                                                                                                           |
| Architecture decision summary     | `doc/planning/sprints/s2-architecture-001.md`                                                           | Additional architecture context; reconcile with the accepted base plan and issue decisions.                                                                                                                                  |
| Assessment context                | `doc/planning/context/project-brief.md`                                                                 | Working interpretation of course deliverables and design/use-case expectations, not a replacement for lecturer instructions.                                                                                                 |
| Product rationale                 | `doc/planning/ideation/rewind-product-discovery-handoff.md`                                             | Supporting product context and decisions.                                                                                                                                                                                    |
| Performance research              | `doc/planning/performance-profiling-research.md` and #267 discussion                                    | Integrated research recommendation plus later review findings. The later reviewed version in PR #325 was not merged.                                                                                                         |
| Local runtime guidance            | `docs/local-demo-runbook.md` and `README.md`                                                            | Local development and Demo guidance; distinguish Demo behavior from real-account acceptance.                                                                                                                                 |
| Deployment guidance               | `deploy/README.md` and `infra/terraform/README.md`                                                      | Operational and infrastructure context. These documents do not authorize an apply or deployment.                                                                                                                             |
| Domain and architecture contracts | `docs/domain/` and `docs/architecture/`                                                                 | Existing policy, lifecycle, media, identity, and implementation boundaries.                                                                                                                                                  |
| Agent working agreement           | `AGENTS.md`                                                                                             | Branch, review, completion, workspace, and verification rules.                                                                                                                                                               |
| Shared implementation workflow    | `skills/agent-solve-issue/SKILL.md`                                                                     | Issue inspection, material decisions, implementation comment, focused change, verification, and PR workflow.                                                                                                                 |
| Issue intake workflow             | `skills/verify-issue/SKILL.md`                                                                          | Intake and overlap checks, not implementation.                                                                                                                                                                               |
| Test and runner configuration     | `package.json`, `jest.config.cjs`, `playwright.config.ts`, `playwright.e2e.config.ts`, and `scripts/`   | Actual local verification behavior and potential tooling improvements.                                                                                                                                                       |
| CI                                | `.github/workflows/quality.yml`, `.github/workflows/codeql.yml`, and `.github/workflows/deploy-dev.yml` | Integrated quality, security, and dev deployment behavior.                                                                                                                                                                   |

The `.claude/skills`, `.codex/skills`, and `.opencode/skills` links point to the same canonical
`skills/` directory. Workflow improvements should not create three divergent copies.

### Historical material and workspace exclusions

- `sprint-0-plan.md` and `sprint-0-plan-extension.md` explain the earlier foundation and handoff.
- `sprint-1-plan.md` explicitly preserves superseded Sprint naming and a narrower hosted Demo scope.
- `aws-iac-scp-execution-plan.md` also explicitly preserves historical Sprint labels.
- Historical proposal wording and archived planning text are background, not today's execution queue.
- Do not inspect, extract, modify, or use `rewind-v1`, `rewind-v1-source.zip`, the retired top-level
  source workspace, or a separate retired planning repository.
- Current project planning belongs under `rewind-app/doc/planning/`.

### How to reconcile sources

Use the submitted document to identify the assessment/product baseline, issue comments to identify
explicitly accepted changes, current plans to understand intended delivery, and integrated code plus
verification evidence to establish actual completion. Do not silently treat an accepted team pilot
exception as proof of lecturer acceptance, or a planning document as proof of implementation.

## 3. Research baseline and live delivery state

The following is a dated snapshot, not a claim that remote state will remain unchanged.

| Evidence                         | Observed state on 2 October 2026                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Integrated `dev`                 | `450a7199767ecc4ea3e96f0f7503d0f2170d382c`, abbreviated `450a7199`                                                    |
| Latest integrated change         | PR #334, moving browser checks to the reviewed `main` path                                                            |
| Existing dev Quality run         | Run `36826478756`, succeeded for `450a7199`                                                                           |
| Existing dev CodeQL run          | Run `36826478793`, succeeded for `450a7199`                                                                           |
| Existing dev deployment run      | Run `36826478747`, succeeded for `450a7199`; the investigator did not independently exercise the deployed application |
| Release-branch baseline observed | `main` at `de9125d49a4601df87b55cbe80c061807e8b20d4`; do not assume the recent dev product changes are released       |
| Open repository issues           | 31                                                                                                                    |
| Open PRs                         | Four: #298, #333, #332, and #335                                                                                      |
| Sprint Project #11               | 33 cards: 21 Done and 12 In Progress; no cards with Status Ready                                                      |
| Delivery/backlog Project #8      | 174 cards; overlapping metadata does not consistently agree with Project #11                                          |
| Sprint 2                         | 27 September–10 October 2026                                                                                          |
| Sprint 3                         | 11–24 October 2026                                                                                                    |

### Checkout boundary

At the time of investigation, the working checkout was on `codex/s2-backend-namespaces`, not current
`dev`, with existing modifications to:

- `infra/terraform/bootstrap/access.tf`
- `infra/terraform/bootstrap/main.tf`
- `infra/terraform/bootstrap/variables.tf`
- Untracked `tests/infra/`

Those changes were left untouched. Code findings in this handoff refer to the separately obtained
integrated `dev` snapshot, not necessarily the files currently visible on this older branch.

The read-only bare snapshot used for the investigation is:

```text
/private/tmp/rewind-planning-dev-20261002.git
```

It is temporary evidence, not another application workspace or an alternative source of truth.
Refresh remote evidence before turning this handoff into an execution plan. Do not begin unrelated
Sprint work on the unfinished infrastructure checkout.

## 4. Submitted product and acceptance baseline

The submitted product is a private group time capsule, not a public social network or a camera-filter
catalogue. Its defining flow is:

```text
Sign in → create/join private group → capture/trim → submit/process/seal
→ participate → server-driven cycle boundary → compile/retry/reveal
→ authorized playback/download/archive → continue capturing in the next cycle
```

### Core requirements

- Authenticated, invite-only groups of 2–10 members with expiring invitations and server-side
  membership checks across group data, chat, media, prompts, and downloads.
- In-app vertical 720p video with audio, at most 15 seconds per clip, and pre-submission trimming.
- A small set of original retro treatments; live GPU filter previews are not required.
- Per member, five clips and 30 seconds per seven-day window, with one deletion-and-replacement
  allowance.
- No replay or thumbnails after successful submission; only non-content contribution metadata.
- Four-week production cycles and a configurable one-day test/demo cycle.
- Server-driven closing and compilation, immediate next-cycle capture, and a 24-hour premiere
  followed by permanent private Archive access.
- Chronological film assembly, normalized source audio, bounded retry, safe delayed status, and
  labelled archive filler where applicable.
- Built-in/custom prompts and a weekly Sunday 7 p.m. reminder in the group's configured local time,
  with snooze/disable preferences and asynchronous delivery failure handling.
- Private chat with text, reactions, and replies.
- Authorized post-reveal download of the group film and the member's own processed clips.
- Removal of original unfiltered inputs after successful processing.
- Repeatable AWS delivery, automated tests, safe operations, and observable lifecycle/job outcomes.
- Android APK, installable PWA, and iOS build/preview subject to signing access. Public App Store
  approval is not an acceptance criterion.

### Measurable targets

| Target                  | Submitted acceptance boundary                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Interactive API latency | Non-media API operations within two seconds at p95 under the acceptance workload, excluding external identity-provider latency |
| Film compilation        | Within ten minutes for the synthetic five-member scenario, at most 25 new clips and 150 seconds of contributed video           |
| Media transfer          | Large media bytes do not pass through the application API; use narrowly scoped, short-lived direct upload/download access      |
| Lifecycle reliability   | Retry-safe scheduled transitions and persisted job states; no duplicate films or false successful reveal                       |
| Privacy                 | Cross-group denial, sealed pre-reveal media, private storage, HTTPS, and credentials outside source control                    |

These are bounded academic acceptance targets, not commercial-scale SLAs. Separate interactive
request timing from media-processing timing.

### Avoid scope expansion

Public discovery/feed/profiles, follower systems, licensed music, complex editing, chat attachments,
read receipts, typing indicators, message editing/deletion, extensive membership/account lifecycle
controls, commercial-scale availability, and App Store approval guarantees are not the first-delivery
goal.

The course brief also expects analysis/design traceability, meaningful use-case and design-pattern
ownership, Agile evidence, a working pipeline, a report, and a presentation. A large count of closed
engineering issues is not a substitute for those outcomes. The brief's presentation dates of
3–4 November and report date of 10 November are indicative and require confirmation, not newly
verified deadlines.

## 5. Requirements and planning differences to resolve

The following differences should be settled once during planning, not repeatedly during individual
implementation sessions.

| Subject         | Submitted baseline                                          | Recorded pilot/execution direction                                                                  | Planning implication                                                                                                      |
| --------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Identity        | Managed OIDC, preferably Cognito                            | Local password accounts and server-managed sessions recorded in #169                                | Explicit team exception exists; lecturer acceptance is not evidenced                                                      |
| Database        | PostgreSQL                                                  | SQLite remains; #261/#175 are conditional evaluation, not approved migration                        | Do not start a database rewrite merely because a proposal is open                                                         |
| Backups         | Relational data backup and selected media recovery settings | #238/base plan explicitly accepts no application backups                                            | Assessment/recovery exception needs reconciliation; #230's backup-gated criteria are also stale relative to this decision |
| Media transfer  | Direct private-storage upload/download                      | Base plan selects private S3 and presigned PUT/GET, but the runtime adapter is not implemented      | This is an agreed delivery dependency, not automatically optional infrastructure polish                                   |
| S3 scheduling   | Required by selected direct-upload design                   | Journey plan suggests deferring migration; #165 is in Sprint 3                                      | Reconcile dependency and Sprint placement before hosted capture acceptance                                                |
| Retro treatment | Submitted wording places treatment before final upload      | Repository proposal describes worker-side treatment after upload                                    | Clarify the required boundary rather than silently choosing conflicting wording                                           |
| Client delivery | Android APK, PWA, iOS build/preview subject to signing      | Repository proposal originally treated native iOS as future scope; Sprint 2 requires native testing | Define what counts as the agreed iOS preview/build acceptance                                                             |
| Registration    | Pilot plan says pre-created accounts, no self-registration  | Later signup work in #307/#308 is integrated                                                        | Update stale descriptions; do not remove accepted behavior solely to match an older plan                                  |
| Photos          | Submitted MVP centers on video                              | Sprint 2 adds full sealed photo contributions using one slot and a three-second segment             | Treat this as a later product addition and retain its shared contribution policy                                          |

**Direction-critical question:** Do the documented pilot substitutions satisfy the submitted
assessment commitments, or must particular original requirements be delivered literally?

The handoff does not answer that question on the lecturer's behalf. It also does not authorize a
Cognito migration, PostgreSQL migration, removal of backups, or new cloud provisioning.

The accepted architecture records a US$100/month total AWS planning ceiling during coexistence,
including Demo overlap. This is not a hard spending cap or a fresh cost estimate. Dated costs,
alert ownership, origin trust, human plan review, and live isolation verification remain gates.

## 6. Implementation versus acceptance

| Area                                              | Existing evidence                                                               | What remains                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry, credentials, sessions, groups, invitations | Substantial work integrated through #240–#246 and subsequent entry/signup fixes | Verify the agreed real-user flow without restarting the whole implementation                                                                |
| Native video #247                                 | PR #285 merged                                                                  | Physical Android/iPhone recording, audio, review/trim/retake, authorized upload, processing, retry, and privacy acceptance                  |
| Photo #248                                        | PR #287 merged                                                                  | Physical capture and real-account hosted upload/processing/ledger acceptance; simulator Demo save was explicitly local-only                 |
| Web recording #249                                | PR #286 merged                                                                  | Installed iPhone PWA and Android browser acceptance; latest recorded simulator attempt failed before review                                 |
| Contribution ledger #250                          | PR #289 merged; issue closed                                                    | Preserve integrated policy/status behavior and verify it in the complete real-member journey                                                |
| Members/context #251                              | PR #284 merged                                                                  | Two-real-account membership, group switching, and cross-group denial acceptance                                                             |
| Private chat #252                                 | PR #288 merged                                                                  | Two-real-account conversation, restart/reconnect persistence, correct context, and cross-group denial                                       |
| Automatic real-member reveal                      | Lifecycle and worker foundations exist                                          | Wire server-driven real-group transitions, publication, and next-cycle behavior; do not equate Demo trigger tests with automatic acceptance |
| Real-account Archive/download                     | Demo Archive and download paths exist                                           | Connect authorized real-member playback/download and released-state UI                                                                      |
| Reminders                                         | Device-local reminder code exists                                               | Agreed real-group preference, scheduling/provider delivery, and truthful platform failure behavior                                          |
| Android/PWA/iOS delivery                          | Export/native foundations exist                                                 | Explicit package/build/install and relevant client acceptance                                                                               |

### Concrete core blockers

**#328 — recording preview:** In integrated `dev`, `VideoCaptureScreen.tsx` renders `CameraView`
under `access === 'ready' && !clip && !recording`. Recording removes the native preview, preventing
the user from framing the clip. This is a core capture defect, not cosmetic polish.

**#329 — captured-video review:** The review state contains metadata, trim fields, and actions but
no captured-video player. The issue also includes a separate browser portrait-validation recovery
problem. Keep the missing-player defect distinct from any device/browser-specific orientation
diagnosis; reproduce the relevant path rather than assuming one fix resolves both.

**Automatic lifecycle gap:** Lifecycle advancement is currently invoked through the Demo
`/demo/reveal` route. The existing worker processes queued work; that is not evidence that a
server-side scheduler automatically closes real groups and publishes their films.

**Next-cycle gap:** The boundary transition returns no next cycle; successor creation happens during
archival. That differs from the submitted requirement to allow the next capture cycle to start
immediately at the closing boundary.

**Real-account navigation gap:** `SessionGate` sends an active real account into
`RealAccountGroupExperience`, whose screen set contains loading, choices, create, home, capture,
chat, and error, but no Archive screen. The Demo five-tab experience is not proof of a usable
real-account return/reveal journey.

**Direct-media gap:** No S3/presigning runtime adapter was found. Current nginx already sets a
50 MiB body limit and disables proxy request buffering; do not repeat the base plan's old 1 MiB
default diagnosis as a current verified defect. The direct-transfer requirement nevertheless remains
unimplemented.

### Acceptance limitations already recorded

- #247's simulator checks proved a labelled synthetic fallback, not real recording.
- #248's installed-PWA simulator check proved permission/review/local Demo save, not hosted
  real-member processing.
- #249's simulator recording attempt failed; it is not successful recording evidence.
- #251 was reopened because real-account member acceptance was not established.
- #252's latest simulator evidence is single-account Demo chat, not real-member privacy acceptance.
- #145 remains an acceptance task, not proof that two full hosted journeys have passed. Its latest
  comment records an owner-authorized agent-review substitution for non-author human review; resolve
  that against the issue contract without claiming a peer run occurred.
- #203 is a synthetic Demo audit tracker, not an umbrella proof that the submitted real product is
  complete.

Unit tests, merged PRs, simulator fixtures, successful deployment workflows, and closed issue states
must each be described for what they actually establish.

## 7. Suggested execution direction

This is a recommendation for the planning session, not an assigned or committed sequence.

1. **Reconcile requirement exceptions and issue contracts.** Establish which submitted requirements
   remain literal, which pilot substitutions are accepted, and which stale planning statements should
   be corrected. Do not make every historical architecture issue a prerequisite.
2. **Repair #328/#329 and deliver the agreed hosted-media path.** Capture UI repair can progress
   alongside direct private-storage work; private-media and infrastructure changes retain review gates.
3. **Finish acceptance of already integrated features.** Use #247/#248/#249/#251/#252 to close the
   actual physical-device, real-account, hosted, and privacy gaps, not to reimplement merged work.
4. **Complete the defining lifecycle.** Automatic closing, deterministic compilation/retry,
   publication/premiere, authorized Archive/download, and immediate next-cycle capture must work for
   the same real group.
5. **Finish reminders and client delivery.** Add the agreed participation/reminder behavior and
   installable client acceptance, then run the full real-account journey.

If capacity is insufficient, make the trade-off explicit against user outcomes and assessment
requirements. Do not call a partial Demo the full product, or promise all remaining work by
10 October without an owner/capacity assessment.

### Work not automatically on the critical path

- PostgreSQL/RDS evaluation and migration: #175/#261.
- SQS-backed worker separation: #164, unless a measured lifecycle constraint requires it.
- Organization/OUs/SCP guardrails: #167, given the recorded single-account exception.
- Broad metrics/alarms beyond the minimum necessary operational evidence: #166.
- Three complete competing UI concepts and broader redesign: #189/#253/#294.
- Conditional instrumentation: #321.
- Additional scanner/source-discovery tooling in review-only PRs #332/#335.
- Tiny or unverified behavioral edge cases that do not block the agreed journey or violate privacy.

Do not place private S3/direct uploads in this deferred category indiscriminately: they are selected
by the accepted architecture and required by the submitted direct-transfer boundary.

Safety exceptions remain important. Cross-group access, credential leakage, sealed-media exposure,
duplicate acceptance, and destructive deployment are not expendable edge cases merely because the
owner wants faster delivery.

## 8. Backlog and documentation cleanup

| Finding                                                                | Recommended planning action                                                                                      |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| #328/#329 are absent from Project #11                                  | Place the confirmed capture blockers visibly in the execution queue                                              |
| #327/#261/#203 are also open Sprint 2 issues absent from Project #11   | Decide intentional placement rather than assuming the Sprint board contains every commitment                     |
| Done cards still have Queue Blocked                                    | Reconcile stale readiness fields using actual dependencies and acceptance evidence                               |
| #145 has conflicting board statuses                                    | Choose an honest status reflecting its current acceptance blocker                                                |
| Project #8 introduction prioritizes closed #101/#106/#97/#100          | Replace stale queue guidance rather than letting agents follow it                                                |
| Twelve cards are In Progress                                           | Distinguish coding, acceptance, review, and blocked work; establish a realistic WIP limit and owners             |
| #230 still requires backup-gated recovery                              | Reconcile its contract with the accepted no-backups/stop-start decision before implementation                    |
| #165 remains in Sprint 3 despite the selected direct-upload dependency | Reconcile timing and decompose the smallest necessary media delivery slice                                       |
| #327 requests portrait locking                                         | Settings already exist in `app.json`; investigate actual supported-client behavior before adding another setting |
| #336 concerns signup validation                                        | Its body explicitly requires waiting until after the UI revamp; do not implement against the current UI          |
| Profiling review #325 is closed unmerged                               | Use #267 comments/#325 as review evidence, but do not claim the reviewed document is integrated                  |
| Old journey/README baselines describe earlier Demo behavior            | Correct only materially misleading current guidance; avoid a broad documentation rewrite                         |

Cleanup recommendations are not permission to change board fields, close issues, delete artifacts,
or rewrite accepted decisions automatically. The planning/execution session should authorize the
specific changes it chooses.

### Open PR dispositions

| PR   | Observed state                                           | Boundary                                                                                                                                      |
| ---- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| #298 | Behind `dev`; earlier checks green                       | Reserves dev/prod state keys and adds an offline namespace guard. It does not create isolated environments; refresh/review before integration |
| #333 | Checks green; browser lane skipped by current dev policy | Canonical hosted URL and retired distribution cleanup; infrastructure/deployment review remains necessary                                     |
| #332 | Security trial, review only                              | Explicit instruction to leave unmerged; do not integrate to increase issue throughput                                                         |
| #335 | Stacked on #332, review only                             | Local agentic coverage preparation; explicitly leave both PRs unmerged                                                                        |

PR #325 was closed without merging at the owner's request. Do not reopen or merge it merely to make
the research document match the later discussion.

## 9. Faster agent and verification workflow

### GitHub access and authentication

- Use the already-authenticated `gh` CLI directly for all GitHub access.
- Do not perform routine `gh auth status`, login, account switching, or Git credential setup before
  ordinary reads/writes.
- Diagnose authentication only after an actual authentication failure. A connectivity failure is not
  evidence that account switching is required.
- Do not use GitHub connectors, direct API access, or browser access as alternatives.
- Record this operational rule clearly in shared guidance rather than relying on repeated reminders.

### Select verification by the behavior changed

| Change or acceptance boundary                            | Default verification                                                                                   | What it cannot replace                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Copy, buttons, navigation, ordinary UI states            | Focused tests and the web instance, preferably reusing the existing service                            | Relevant platform-specific behavior if the issue requires it          |
| iOS keyboard, safe areas, rotation, native-only behavior | Supported iPhone 14-or-newer simulator / Expo Go using LAN                                             | Physical camera/microphone acceptance                                 |
| Camera, microphone, actual recording or capture          | Physical-device acceptance for the named client, with focused automated tests                          | Simulator synthetic media is not real capture                         |
| Installed PWA recording                                  | Actual installed-PWA/browser permission, capture, review, and upload journey                           | Native Expo verification does not prove browser recording             |
| Real accounts, membership, private media                 | Relevant API/integration tests and two-real-account/outsider scenarios over the correct HTTPS boundary | A Demo profile switch is not authentication or authorization evidence |
| Deployment/environment changes                           | Reviewed plan, relevant fixtures, correct version/health and live isolation checks                     | A mocked plan or green unit suite is not deployed acceptance          |

Do not launch an iOS simulator merely to determine whether an ordinary button works. Conversely,
do not substitute browser viewport emulation for an iOS-specific fix.

For required native verification, preserve the documented LAN launch:

```sh
npm start -- --ios --lan --clear
```

`make run` builds/starts the local runtime and launches Expo in LAN mode; it can serve both browser
and phone feedback. Local plain HTTP Demo access is not proof of real-login HTTPS acceptance.

Until guidance is deliberately changed, keep its existing required pre-native and PR checks.
Faster feedback is an additional inner loop, not permission to bypass the Definition of Done.

### Specific tooling opportunities

1. **Add a genuinely focused local loop.** `test:fast` currently aliases `npm test`, which runs root
   tests, the server build/test suite, and Jest. Run relevant tests during iteration and retain the
   agreed broader gate before acceptance/PR completion.
2. **Reuse the correct web build across clean-data journeys.** `test:slow` exports once, then the
   production-shaped runner executes twice; each run builds the server and exports again. Reuse one
   appropriately configured export/build while retaining two independent clean-data runs. Do not
   blindly reuse an artifact built with different public environment configuration.
3. **Do not redo the CI split.** PR #334 already removes browser checks from dev CI and retains them
   for `main` pushes/PRs. Its aggregate gate succeeded with the browser lane intentionally skipped.
4. **Handle #254 carefully.** Documentation-only CI savings remain an open request. Preserve the
   protected aggregate Quality contract; workflow/configuration and mixed runnable changes must still
   receive their required checks.
5. **Measure bottlenecks rather than adding tools by default.** One observed post-#334 Quality run
   spent 124 seconds in server tests/coverage and 118 seconds in frontend tests/coverage; FFmpeg
   installation took 41 seconds in that server job. These are individual observations, not a stable
   benchmark or proof of a specific speedup.
6. **Gate instrumentation.** #321 proceeds only after #267's recommendation is accepted, a required
   boundary cannot be observed reliably with external tools, and fields/redaction are agreed. It
   permits a no-implementation outcome if existing tools suffice.
7. **Use profiling evidence honestly.** #267 comments report an iOS navigation lead in
   `cycle-time.ts`, alongside DevTools/Instruments/Maestro findings and a blocked release-build
   attempt. Those were not independently reproduced during this investigation. They are leads for a
   bounded measurement/optimization issue, not reasons to start a broad profiling campaign now.

## 10. Instructions for the subsequent planning session

The next model's task is to plan the remainder of Sprint 2 using this handoff, the submitted document,
fresh repository/GitHub evidence, and the owner's decisions. It should not immediately implement the
entire open backlog.

Produce:

1. A proposal-to-delivery matrix: requirement, accepted exception if any, integrated implementation,
   remaining gap, acceptance evidence, and responsible issue.
2. One concrete Sprint Goal for the remaining period through 10 October, with explicit exclusions.
3. A dependency-ready execution queue distinguishing new implementation, defect repair, review,
   verification-only work, and blocked work.
4. Owners/capacity and a realistic WIP limit, based on actual availability rather than the count of
   In Progress cards or nominal five-person team size.
5. A small tooling/cleanup slice with direct payback during this Sprint, not an open-ended platform
   project.
6. Per-issue verification selection using the matrix above.
7. Explicit carryover into Sprint 3 where the complete product cannot fit, without hiding unmet
   submitted requirements.

Before implementing an issue, inspect its full contract and relevant comments/code, resolve only
material choices, and record one concise implementation-approach comment as the shared workflow
requires. Start from current `dev`, target `dev`, link with `Refs #...`, and preserve unrelated work.

Request human review for authentication, private-media access, migrations, deployment, and
infrastructure. Do not bypass those gates because routine dev PRs require no human approval.

Close an issue or move it to Done only after its acceptance criteria are verified, relevant checks
pass, the change is reviewed, and the accepted change is integrated into `dev`. A merge to `main`
does not independently prove deployment or user acceptance.

## 11. Evidence refresh and limitations

Refresh live state with `gh` before committing the Sprint plan. For example:

```sh
gh issue list --repo Collaboration95/rewind-app --state open --limit 100
gh pr list --repo Collaboration95/rewind-app --state open --limit 100
gh project item-list 11 --owner Collaboration95 --limit 100 --format json
gh project item-list 8 --owner Collaboration95 --limit 250 --format json
gh run list --repo Collaboration95/rewind-app --branch dev --limit 10
```

Use targeted issue/PR reads after that inventory. Do not add an authentication preflight.

Limitations of this handoff:

- No fresh hosted journey, physical-device acceptance, simulator check, or local test suite ran.
- No AWS state, price, account inventory, or cloud configuration was freshly inspected in this pass.
- Successful existing CI/deployment runs were read, not re-executed or treated as full user acceptance.
- Remote board and PR state can change after the snapshot.
- Actual remaining team capacity and lecturer acceptance of pilot exceptions are unresolved.
- Historical documents contain stale baseline statements; current integrated code was checked where
  a material planning conclusion depended on it.

The planning session should spend its effort turning these known gaps into the smallest usable
increment and an honest execution queue, not restarting evidence gathering from zero or speed-running
every open issue indiscriminately.
