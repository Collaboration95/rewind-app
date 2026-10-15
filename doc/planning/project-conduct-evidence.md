# Project-conduct evidence index

Snapshot: **15 October 2026**. Repository source: `Collaboration95/rewind-app`
`dev` at `40ebeb5673d103b4b6950d095192aae744980769`, confirmed using authenticated
`gh` on this date. This index records historical facts, their limits and missing
information. It does not certify a release or supply missing meeting records.

## Source register and interpretation

| Key | Source and dated scope                                                                                                                                                                                                                                                                                                                                                       | What it establishes                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0  | [Sprint 0 plan](sprints/sprint-0-plan.md), 1–12 September; [extension](sprints/sprint-0-plan-extension.md), dated 10 September                                                                                                                                                                                                                                               | Original goals, budgets, story points, runtime extension and proposed working practices. Plans are not actual time records.                                                                                                     |
| H0  | [Historical progress evidence](sprint-1-progress-report-evidence-archived.txt), snapshot 12 September; GitHub [#18](https://github.com/Collaboration95/rewind-app/issues/18), [#25](https://github.com/Collaboration95/rewind-app/issues/25), [#26](https://github.com/Collaboration95/rewind-app/issues/26), [#27](https://github.com/Collaboration95/rewind-app/issues/27) | Dated Sprint 0 close-out and recorded verification. The text preserves older Sprint numbering and stale paths; those do not define current scope.                                                                               |
| R0  | Retained Sprint 0 progress-report extraction `previous-report.txt` in the evidence store below                                                                                                                                                                                                                                                                               | Team-reported outcomes, contribution descriptions and rough early effort; not an audited timesheet. Original source hash: `276d4822eb4e58cf4c8c6e0776ff8b24e581882de6b048fd9fd1a009b8c0beb4`.                                   |
| R1  | Retained 26 September progress-report extraction `sprint-1-revised.txt` in the evidence store                                                                                                                                                                                                                                                                                | Review-ready code snapshot, explicitly unclosed Sprint and incomplete hosted acceptance. Original source hash: `1f4e9c4b71dbecf844c8e8f92607b241bb1e6f22ea65dc3e28add7892d7a2882`.                                              |
| R2  | [Sprint 2 progress report](sprints/sprint-2-report/rewind-sprint-2-progress-report.docx), 27 September–10 October; saved `report-facts.json`, `metrics.json`, `parity-analysis.txt`, `quality-analysis.txt`, `git-analysis.txt`                                                                                                                                              | Dated team account and computed activity/verification evidence. GitHub census: **10 October, 20:44:32 SGT**; source `7bab4027bd4b19425fd4bfbe8e9a0d99d2f2a913`; release source then `bac471c749b93651d4081d231b5c9b67753b6fdb`. |
| P1  | [Proposal](proposals/proposal-rewind.md), especially §§5.2, 8 and 10; [Sprint 1 plan](sprints/sprint-1-plan.md); [Sprint 2 journey plan](sprints/sprint-2-user-journey-plan.md)                                                                                                                                                                                              | Recorded work breakdown, use-case/design-problem allocations and changing delivery plan.                                                                                                                                        |
| G3  | Issue/PR records linked below, read with `gh` on 15 October                                                                                                                                                                                                                                                                                                                  | Current metadata and dated integration/closure events through the source revision. Labels and milestone assignments can change.                                                                                                 |

The retained local evidence store is
`.local-data/sprint-prep-20261011/sprint-2-working-files/evidence/` in the primary
workspace. It is not committed and may be absent in a fresh checkout. Its
`README.txt` describes the datasets and `source-manifest.json` records original
progress-document hashes. Repository and GitHub links provide durable sources;
local extracts remain provenance for facts not otherwise preserved there.

Use zero-based Sprint names throughout. An older record calling the foundation
“Sprint 1”, or the hosted-Demo work “Sprint 2”, is historical terminology, not an
additional Sprint. Archived issue closures represent scope decisions. Issue
counts, PR counts and tests do not establish a completion percentage, personal
hours or equal workload. A merged PR establishes integration; deployment and
physical-device acceptance need their own dated evidence.

## Chronological milestones: plan versus recorded outcome

| Sprint / dates                                       | Recorded plan                                                                                                                                                                                          | Recorded outcome and qualification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint 0: 1–12 September**                         | Local walking skeleton: launch/navigation (US-01), synthetic member selection (US-02), group prompt/countdown/quota (US-03); 16 planned story points, 70 team-hours plus 30-hour reserve (P0).         | R0 reports all three stories, four enablers and five pulled-forward runtime tasks completed by 10 September. [#26](https://github.com/Collaboration95/rewind-app/issues/26) reconciles stories #5–#7; [#25](https://github.com/Collaboration95/rewind-app/issues/25) records a fresh-checkout walkthrough, 29 passing tests, disclosure/member switching and locked-state navigation. [#18](https://github.com/Collaboration95/rewind-app/issues/18) closed 10 September. [PR #77](https://github.com/Collaboration95/rewind-app/pull/77) records close-out and [#78](https://github.com/Collaboration95/rewind-app/pull/78) the local runtime foundation. These prove a local prototype, not real authentication/cloud privacy. Early next-Sprint work is excluded from the three-story commitment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Sprint 1: 13–26 September**                        | Expand the local runtime into groups/invites, capture and sealed contributions, chat/reminders, cycle/reveal/archive; progress toward a hosted synthetic Demo (P0 extension, P1, R1).                  | R1 describes integrated synthetic-Demo behavior and four audit PRs merged to `main` on 26 September: [#205](https://github.com/Collaboration95/rewind-app/pull/205) release provenance, [#206](https://github.com/Collaboration95/rewind-app/pull/206) chat/reveal/fixtures, [#204](https://github.com/Collaboration95/rewind-app/pull/204) quality/security gates and [#207](https://github.com/Collaboration95/rewind-app/pull/207) bounded history delivery. It explicitly says **review ready, Sprint not closed**, with hosted acceptance outstanding. Its hosting statements are a 26 September account, not today's infrastructure inventory. No verified Sprint-length burndown or member-hours ledger was supplied.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Sprint 2: 27 September–10 October**                | A working product meeting agreed user stories, with Android APK and live web release; real-account journey, media, reminders, reveal/archive and hardening (P1; milestone description retained in R2). | Private real groups integrated in [#280](https://github.com/Collaboration95/rewind-app/pull/280), S3/reminders in [#416](https://github.com/Collaboration95/rewind-app/pull/416), synthetic Demo removal on 6 October in [#473](https://github.com/Collaboration95/rewind-app/pull/473), web push in [#487](https://github.com/Collaboration95/rewind-app/pull/487). PostgreSQL and hosted-dev cutover integrated in [#506](https://github.com/Collaboration95/rewind-app/pull/506)/[#507](https://github.com/Collaboration95/rewind-app/pull/507); Cognito implementation in [#510](https://github.com/Collaboration95/rewind-app/pull/510), followed by runtime packaging fix [#511](https://github.com/Collaboration95/rewind-app/pull/511). R2 records an integrated real-account increment but incomplete release parity and target-device proof. Do not turn this into a claim that all original targets were accepted by 10 October.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Sprint 3: 11–24 October; in progress at snapshot** | Follow-up fixes, hardening, release and submission work after the Sprint 2 target; current Sprint milestone is [Sprint 3](https://github.com/Collaboration95/rewind-app/milestone/4).                  | [#529](https://github.com/Collaboration95/rewind-app/pull/529) merged 12 October: live cycle/quota refresh, own-clip downloads, chat reactions, reminder failure feedback, benchmark repair and PostgreSQL export. Issues [#505](https://github.com/Collaboration95/rewind-app/issues/505), [#521](https://github.com/Collaboration95/rewind-app/issues/521), [#522](https://github.com/Collaboration95/rewind-app/issues/522), [#523](https://github.com/Collaboration95/rewind-app/issues/523), [#524](https://github.com/Collaboration95/rewind-app/issues/524), [#526](https://github.com/Collaboration95/rewind-app/issues/526) closed that day. [#525](https://github.com/Collaboration95/rewind-app/issues/525) and [#528](https://github.com/Collaboration95/rewind-app/issues/528) also closed; [#530](https://github.com/Collaboration95/rewind-app/pull/530) versions the refreshed Android test APK. [#532](https://github.com/Collaboration95/rewind-app/pull/532) fixes idle event-stream proxy behavior. Release isolation [#230](https://github.com/Collaboration95/rewind-app/issues/230), release PostgreSQL/backups [#504](https://github.com/Collaboration95/rewind-app/issues/504), release Cognito [#515](https://github.com/Collaboration95/rewind-app/issues/515) and hosted Safari/Home Screen integration verification [#527](https://github.com/Collaboration95/rewind-app/issues/527) were open when read. Sprint 3 is not closed by this index. |

### Dated Sprint 2 activity and outcome measurements

R2's multi-query census stopped before the reporting day ended. Its figures
must remain attached to that cutoff, not be recomputed from today's labels and
presented as an original commitment:

- **132 PR merges:** 128 targeting `dev`, three `main`, one another branch.
  Promotions and nested integrations are not 132 unique product features.
- **145 unique issues with latest `closedAt` in the interval:** 123 non-archived,
  22 archived. The 158 closure events include repeat closures; use unique issue
  count when describing issues. 143 issues were created during the interval.
- **135 issues assigned to Sprint 2 at collection:** 42 active `mvp` excluding
  archived (40 closed, two open), 15 archived, 78 other (71 closed, seven open).
  This is mutable milestone membership, not a preserved opening commitment.
- [Quality run 37887860231](https://github.com/Collaboration95/rewind-app/actions/runs/37887860231)
  at `7bab4027…` succeeded on 9 October. Saved counts: root 167 passed/one
  skipped, SQLite server 469 passed/eight skipped, PostgreSQL server 443
  passed/34 skipped, frontend 568 passed in 53 suites, Python IaC gate six
  passed. The two database runs overlap; do not sum them as unique tests.
  The web-export/browser/accessibility job was skipped by the dev condition.
- R2 records 71 successful and 13 failed dev-push deployment attempts (84 total),
  and [#508](https://github.com/Collaboration95/rewind-app/pull/508) reports an
  isolated database restore: 38 tables, 889 matching rows, RPO 334 seconds and
  RTO 1,022 seconds. These are historical workflow/PR records, not a fresh cloud
  check or a general recovery guarantee.

No product tests, AWS inspection or device run was performed to prepare this
index. Current batch baseline checks are recorded separately by the integrator.

## Available ceremonies, decisions and process learning

| Date / period                            | Available record                                                                                                                                                                                                                                                               | Supported interpretation and limit                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sprint 0 planning                        | P0 describes a 90-minute Planning, weekday/asynchronous updates, refinement, Review and Retrospective timeboxes.                                                                                                                                                               | A planned cadence; no attendance or actual meeting duration can be inferred. R0 reports use of Scrum, Review and Retrospective, without dated attendance records.                                                                                                                                                      |
| 10 September close-out                   | [#25](https://github.com/Collaboration95/rewind-app/issues/25) walkthrough; [#26](https://github.com/Collaboration95/rewind-app/issues/26) acceptance reconciliation; [#27](https://github.com/Collaboration95/rewind-app/issues/27) retrospective working-agreement decision. | Concrete recorded review outputs: local-only boundary, LAN/SQLite/FFmpeg gate, single-device fallback and a five-issue WIP limit for the next Sprint. Issue completion is not a meeting transcript.                                                                                                                    |
| Sprint 0 retrospective account           | R0 records late concentration of work, incomplete effort tracking and a proposed earlier checkpoint.                                                                                                                                                                           | Recorded team reflection. Its statement that a second-member-machine rehearsal remained outstanding is narrower than #25's clean-checkout claim; do not assert a verified second physical machine.                                                                                                                     |
| 23 September operating decisions         | [#142](https://github.com/Collaboration95/rewind-app/issues/142), accepted decision comment; later correction acknowledges it.                                                                                                                                                 | Guruprasath recorded as apply/break-glass/budget owner; Andrew as plan reviewer and non-author acceptance owner. This is historical responsibility evidence, not proof of who performed every subsequent action. No recipient addresses are reproduced.                                                                |
| 26 September retrospective text          | R1 identifies native transport/method binding, inconsistent seeded media, integration gaps and stale infrastructure plans.                                                                                                                                                     | The source explicitly calls these evidence-based reflections and proposed agreements, **not retrospective meeting minutes**. It also states attendance/story-point records were unavailable.                                                                                                                           |
| 4–8 October scope decisions              | [#473](https://github.com/Collaboration95/rewind-app/pull/473), [#487](https://github.com/Collaboration95/rewind-app/pull/487), [Cognito decisions](sprints/sprint-3-cognito/design-decisions.md).                                                                             | Real accounts replace synthetic Demo; web push is the active reminder path; Cognito Managed Login uses authorization code + PKCE and server exchange. Current working agreement retains photo/video, disk locally/S3 hosted, and iPhone PWA delivery. Native push and compiled iOS are outside current delivery scope. |
| Sprint 2 reflection / Sprint 3 follow-up | R2 describes milestone churn, release lag, incomplete device evidence and effort records; #529/#530/#532 record subsequent fixes.                                                                                                                                              | Actionable process/outcome evidence; not proof that a formal Review, Daily Scrum or Retrospective occurred on a particular date.                                                                                                                                                                                       |

Historical board references explain past records only. Current tracking uses
milestone, `mvp`/`archived`, `doing` and issue state; this index does not maintain
a Project board or reinstate older operator/independent-acceptance roles as gates.

## Recorded WBS and effort sources

These are existing planning estimates, reproduced for historical comparison.
They are **not new allocations, actual hours or individual contribution shares**.

| Proposal §10 work package (P1)                                 | Recorded lead identifier | Planned hours |
| -------------------------------------------------------------- | ------------------------ | ------------: |
| Identity, groups, invitations and authorization                | A                        |            58 |
| Camera, trim, upload and contribution lifecycle                | B                        |            68 |
| Media worker, audio, compilation, archive and retries          | C                        |            74 |
| Chat, prompts, reminders and notification adapter              | D                        |            58 |
| Android/PWA UX, validation, archive/download and accessibility | E                        |            52 |
| Automated tests, fixtures, resilience and pilot fixes          | All                      |            44 |
| CI/CD, Terraform, security, observability and smoke checks     | A/D/E                    |            32 |
| Integration hardening and rehearsal                            | All                      |            14 |
| **Total**                                                      |                          |       **400** |

P0's capacity model is five members × ten person-days × eight hours = 400
project hours, with a theoretical 100-hour Sprint ceiling. Sprint 0's recorded
70-hour commitment comprises 46 story hours (10/16/20) and 24 enabler hours
(4/6/8/6), with 30 hours reserve. Its effort-area split is requirements 11,
design 10, repository/CI 16, seeded slice 20, quality/evidence 13 hours.
These are overlapping views of one planning budget; do not add them together
or add the later proposal's 400 hours to the original capacity model.

R0 supplies the only rough actual-effort statement found here: each member
spent **about one hour per day during the first few days of Sprint 0**. It does
not specify how many days or give a complete per-member total. It explicitly
says actual hours were not recorded daily. R1 provides no verified individual
hours; R2 states individual effort hours were not recorded. No conversion from
commits, closed issues, story points or the theoretical capacity to actual
person-hours is justified.

## Member activity and use-case/design-problem evidence

The names below come from progress records, not GitHub identity matching.
R0 reports Sprint 0 contributions as completed. R2 carries forward qualitative
workstreams and supplies a Sprint 2 team account; it does not assign individual
PRs or hours. The different dated records must not be flattened into one
project-wide claim.

| Member            | Sprint 0 reported activity (R0)                 | Sprint 2 recorded workstream (R2)                                                                                                                    |
| ----------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nguyen Kim Long   | Backlog and local demo profile                  | Backlog refinement, real-account/private-group requirements, invitations and access-rule review.                                                     |
| Gopal Guruprasath | Group capsule summary and pair programming      | Coordination/pair programming, capture/contribution integration, infrastructure and release work.                                                    |
| Jiang Jiayu       | Technical integration and local foundation      | Runtime/server/media integration, persistence, jobs, compilation and recovery.                                                                       |
| Phan Mai Tan Loi  | App shell, UX, accessibility and evidence       | Mobile layouts, capture/chat/archive interactions, accessibility and journey evidence.                                                               |
| Sang Haoxiang     | Scrum facilitation, quality and report evidence | R2 records no completed work during Sprint 2, as a team-supplied account. This is limited to that period and is not inferred from GitHub inactivity. |

The R2 account's private escalation details are unnecessary to this technical
index and are not repeated. Sprint 1's revised report explicitly leaves its
individual attribution unconfirmed; Sprint 3 member totals are also absent.

| Proposal identifier | Recorded use-case allocation (§5.2)         | Recorded design problem (§8)                                                     |
| ------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| A                   | UC-01: sign in, create group, invite member | Apply group/media policy consistently across API, chat, storage URLs and jobs.   |
| B                   | UC-02: capture and lock contribution        | Model recording, processing, locked, deleted, failed and released clip behavior. |
| C                   | UC-03: compile and publish capsule          | Run validation, processing, retry, filler and publish steps safely.              |
| D                   | UC-04: choose prompt and deliver reminder   | Keep schedule/provider/retry policy replaceable.                                 |
| E                   | UC-05: chat and view/download archive       | Render capture, locked, pending, delayed, premiere and archive UI states.        |

These are proposal allocations. No confirmed A–E-to-name mapping was found in
the inspected evidence. Similarity to a named workstream does not establish
ownership. The proposal lists candidate patterns; this index makes no claim
that a named pattern was implemented or personally designed by a member.

## Facts still missing

- Complete rough actual effort by named member and Sprint, including analysis,
  design, implementation, testing and integration; only the bounded Sprint 0
  early-effort statement above is available.
- Confirmed mapping of proposal A–E allocations to real members, and evidence
  of each member's implemented use-case/design-problem contribution.
- Dated Planning/Review/Retrospective attendance and decisions beyond the
  recorded outputs above; Daily Scrum logs and actual ceremony durations.
- A preserved original Sprint 2 commitment and consistent daily remaining-work
  series. The saved reverse-event reconstruction is explicitly inferred and
  cannot substitute for the original agreement or an effort burndown.
- Confirmed Sprint 1 individual attribution and Sprint 3 contributions/effort
  through completion; a Sprint 3 close-out cannot precede its recorded outcome.
- Current release integration and hosted/device results for the open work in
  the chronology. Those records may advance after this snapshot; their absence
  does not invalidate the completed historical evidence index.
