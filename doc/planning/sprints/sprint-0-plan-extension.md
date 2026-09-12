# Rewind Sprint 0 extension and two-week Sprint 1 plan

- **Status:** Applied backlog plan; no application code is part of this document
- **Date:** 2026-09-10
- **Planning repository:** `SWEE5006-Project-Planning-docs`
- **Delivery repository:** `Collaboration95/rewind-app`

## Purpose

Sprint 0 ends on **12 September 2026**. This extension records its review
close-out and the two-week Sprint 1 backlog, running **13–26 September 2026**,
that turns the current locally seeded interface into a complete, demonstrable
local group-capsule journey. The runtime foundation issues #28–#32 are moved
into Sprint 0 so Sprint 1 starts on a verified local boundary.

Issue #12 remains deliberately on hold. It is neither a Sprint 0 exit criterion
nor a dependency of this plan.

## Sprint 0 extension

Sprint 0 is extended with the local runtime foundation needed by the next
feature slice, alongside its review/retrospective close-out:

| Key | Outcome | Done check |
|---|---|---|
| `s0-review-001` | Rehearse the existing five-minute walkthrough | A non-author runs clean start and the full Sprint 0 demonstration without assistance. |
| `s0-review-002` | Reconcile closed-story acceptance checklists | Closed user stories accurately reflect accepted behaviour and automated checks. |
| `s0-retro-001` | Record the Sprint 1 working agreement | The team agrees the local-runtime decision, ownership, WIP limit, and fallback. |
| `s1-runtime-001` | Validate local LAN runtime, SQLite, and FFmpeg | A one-command preflight proves the runtime gate or activates the documented fallback. |
| `s1-runtime-002` | Bootstrap the typed local service and health endpoint | The service starts/stops predictably and exposes a safe health/version endpoint. |
| `s1-runtime-003` | Add SQLite schema, migrations, fixtures, and reset | A resettable local store persists the required synthetic records. |
| `s1-runtime-004` | Add the typed app API boundary and connection states | The app can call the local boundary and render actionable connection states. |
| `s1-runtime-005` | Centralise group and media membership policy | Authorised members can read only their group-scoped data. |

The moved runtime issues remain dependency-ordered: #28 first, #29 next, then
#30 and #31, followed by #32 after the schema is available. All other Sprint 1
issues remain in the Product Backlog until this foundation is complete.

## Sprint 1 goal

> A five-person group can locally sign in, create or join a group, capture and
> submit clips, chat, advance a one-day demonstration cycle, receive a compiled
> reveal, and replay or download it without any cloud service.

### Local-first delivery boundary

```text
Expo app(s) on the same LAN
        |
        v
Local Node service
  - mock sessions, groups, invitations, chat and cycle rules
  - SQLite metadata and persistent local job queue
  - ignored local media directory
  - FFmpeg processing and group-film compilation
```

The local service is demonstrable multi-device behaviour, not a production
deployment. Mock sessions are explicitly labelled demo access, not secure
authentication. Only synthetic or non-sensitive media may enter local storage;
temporary and processed media directories are ignored by Git. Real OIDC,
cloud deployment, real push delivery, and claims of production privacy remain
outside this Sprint.

## Operating rules

- Reuse GitHub Project #8 and add a `Sprint 1` iteration option; do not create
  a parallel board.
- Use a `Sprint 1` milestone for the two-week, 13–26 September slice.
- Every issue has a stable `agent-orchestration:issue-key` marker, a parent
  epic, dependencies, risk, verification, and stop condition.
- Sprint 0 owns runtime issues #28–#32. Only #28 enters `Ready` initially;
  #29–#32 remain `Product Backlog` until their dependencies are complete.
- Remaining feature work stays in the Sprint 1 `Product Backlog` until the
  runtime foundation is complete.
- The Sprint 1 runtime baseline is Node 22 LTS or newer, SQLite, a local LAN
  address, and a preflight-verified FFmpeg binary.

## Go/no-go and fallback

The first issue, `s1-runtime-001`, is the Day 1 gate. It must prove that the
local service starts, SQLite persists a record, and FFmpeg transforms a known
synthetic MP4. If LAN/CORS, native capture, or FFmpeg cannot be made reliable
by the Day 1 afternoon checkpoint, retain the same service and complete the
single-device demonstration using deterministic synthetic MP4 fixtures. The
team must not claim live multi-device capture in that fallback.

## Issue hierarchy and delivery order

### EPIC: Sprint 0 review close-out

`s0-review-001` -> `s0-review-002` -> `s0-retro-001`

### EPIC: Local runtime, persistence, and policy

| Key | Issue outcome | Dependency |
|---|---|---|
| `s1-runtime-001` | Spike LAN runtime, SQLite and FFmpeg | — |
| `s1-runtime-002` | Bootstrap typed local service and health endpoint | 001 |
| `s1-runtime-003` | Schema, migrations, reset and deterministic fixtures | 002 |
| `s1-runtime-004` | Typed mobile API client and connection-state UX | 002 |
| `s1-runtime-005` | Central group/media membership policy | 003 |
| `s1-runtime-006` | Safe local audit event log | 003 |

### EPIC: Mock sign-in, groups, and invitations

| Key | Issue outcome | Dependency |
|---|---|---|
| `s1-identity-001` | Mock-session contract | runtime 003 |
| `s1-identity-002` | Demo sign-in and sign-out | identity 001 |
| `s1-identity-003` | Owner group creation and prompt selection | identity 002 |
| `s1-identity-004` | Expiring local invite code creation | identity 003 |
| `s1-identity-005` | Invitation acceptance and membership establishment | identity 004 |
| `s1-identity-006` | Account/group settings and confirmed demo reset | identity 002 |

### EPIC: Capture and locked contribution lifecycle

| Key | Issue outcome | Dependency |
|---|---|---|
| `s1-capture-001` | Device capability and camera-permission states | runtime 004 |
| `s1-capture-002` | Vertical, audio-enabled, 15-second recording | capture 001 |
| `s1-capture-003` | Review, trim, retake and original-mode selection | capture 002 |
| `s1-capture-004` | Local upload with validation and progress | capture 003 |
| `s1-capture-005` | Persistent quota and contribution state policy | runtime 003 |
| `s1-capture-006` | FFmpeg processing and temporary-source deletion | capture 004, runtime 001 |
| `s1-capture-007` | Processing, locked, and recoverable failure UI | capture 006 |
| `s1-capture-008` | One delete-and-recapture allowance each week | capture 005, 007 |

### EPIC: Group chat and local reminders

| Key | Issue outcome | Dependency |
|---|---|---|
| `s1-chat-001` | Authorised LAN real-time transport | runtime 003, 005 |
| `s1-chat-002` | Persistent timeline and text composer | chat 001 |
| `s1-chat-003` | Replies and reactions | chat 002 |
| `s1-chat-004` | Reconnect, error and access-denial behaviour | chat 001 |
| `s1-reminder-001` | Reminder preferences and local test reminder | identity 002 |

### EPIC: Cycle, reveal, archive, and downloads

| Key | Issue outcome | Dependency |
|---|---|---|
| `s1-cycle-001` | Deterministic cycle clock and owner demo controls | runtime 003 |
| `s1-cycle-002` | Idempotent lifecycle transition and next cycle | cycle 001 |
| `s1-film-001` | Persistent local compilation job | cycle 002, capture 006 |
| `s1-film-002` | Chronological FFmpeg film with normalised audio | film 001 |
| `s1-film-003` | Labelled archive-filler policy | film 002 |
| `s1-film-004` | Bounded retries and delayed-release state | film 001 |
| `s1-archive-001` | Authorised premiere playback | film 002 |
| `s1-archive-002` | Archive browsing and authorised downloads | archive 001 |

### EPIC: Integration, usability, and demo proof

| Key | Issue outcome | Dependency |
|---|---|---|
| `s1-quality-001` | Automated local happy-path test | P0 feature slice |
| `s1-quality-002` | Cross-group negative regression suite | runtime 005 |
| `s1-quality-003` | Job/media resilience tests | film 004 |
| `s1-quality-004` | Native and web usability validation | capture 002, archive 001 |
| `s1-quality-005` | Local demo runbook and reset procedure | quality 001 |

## Two-week delivery plan

| Day | Parallel focus | Exit criterion |
|---:|---|---|
| 1 | Mock sessions, sign-in/out, group creation, and prompts | An owner can enter Demo access and create a collecting group on the verified runtime. |
| 2 | Invitation generation and acceptance; account/group settings | A second demo actor can join only the intended group. |
| 3 | Device permission, vertical recording, review, trim, and retake | A bounded clip is captured and ready for submission. |
| 4 | Upload, quota policy, processing, locked state, and deletion allowance | A processed contribution is sealed without exposing media. |
| 5 | Real-time chat, timeline, replies, reactions, and local reminder preference | Two authorised local sessions can communicate and recover from disconnect. |
| 6 | Deterministic cycle controls and lifecycle transitions | A one-day cycle can enter a safe persistent compilation workflow. |
| 7 | Persistent compilation jobs, film compilation, retry/delay | A released film can be produced without partial output. |
| 8 | Premiere, archive, and authorised downloads | An authorised member can play and download a released local capsule. |
| 9 | End-to-end, negative-access, and resilience suites | The complete journey and denial boundaries run from reset. |
| 10 | Native/web usability, runbook, and non-author demo validation | The complete journey runs twice and the Sprint Review is ready. |

## Ownership and WIP

| Area | Primary owner |
|---|---|
| Sessions, groups, invites and policy | A |
| Camera and contribution lifecycle | B |
| Local runtime, jobs and FFmpeg | C |
| Chat and reminders | D |
| Archive, accessibility and demo proof | E |

Limit concurrent implementation to five active child issues, with the runtime
spike receiving immediate review. A dependent issue is not `Ready` merely
because an agent can start writing code around an unresolved boundary.

## Definition of done for this extension

An issue is Done only when its observable acceptance criteria pass, its
relevant automated/manual verification is recorded, a peer has reviewed it,
the app honestly describes local limitations, and no private media, secrets,
or generated local data enter version control.

## Applied GitHub backlog

- Reused GitHub Project #8, **Rewind — Sprint 0**, and added its `Sprint 1`
  option rather than creating a parallel Project.
- Created the **Sprint 1** milestone, due 2026-09-26, and assigned the
  remaining Sprint 1 feature backlog to it; runtime foundation issues #28–#32
  now belong to Sprint 0.
- Created seven parent epics and 41 canonical child issues: three Sprint 0
  review tasks and 38 Sprint 1 delivery tasks.
- Sprint 0 review children are complete. The initial runtime Ready queue is
  `s1-runtime-001` (#28); #29–#32 are now Sprint 0 Product Backlog items and
  all remaining canonical Sprint 1 tasks stay Product Backlog until their
  explicit blockers are complete.
- Each canonical child is linked to its epic and to its listed GitHub blocking
  dependencies. Project metadata includes Sprint, Status, Priority, Risk, Work
  Type, and Area.

| Epic | Canonical GitHub tracking |
|---|---|
| Sprint 0 review close-out | [#18](https://github.com/Collaboration95/rewind-app/issues/18), children [#25](https://github.com/Collaboration95/rewind-app/issues/25)–[#27](https://github.com/Collaboration95/rewind-app/issues/27) |
| Local runtime, persistence, and policy | [#19](https://github.com/Collaboration95/rewind-app/issues/19), children [#28](https://github.com/Collaboration95/rewind-app/issues/28)–[#33](https://github.com/Collaboration95/rewind-app/issues/33) |
| Mock sign-in, groups, and invitations | [#20](https://github.com/Collaboration95/rewind-app/issues/20), children [#34](https://github.com/Collaboration95/rewind-app/issues/34)–[#39](https://github.com/Collaboration95/rewind-app/issues/39) |
| Capture and locked contribution lifecycle | [#21](https://github.com/Collaboration95/rewind-app/issues/21), children [#40](https://github.com/Collaboration95/rewind-app/issues/40)–[#47](https://github.com/Collaboration95/rewind-app/issues/47) |
| Group chat and local reminders | [#22](https://github.com/Collaboration95/rewind-app/issues/22), children [#48](https://github.com/Collaboration95/rewind-app/issues/48)–[#52](https://github.com/Collaboration95/rewind-app/issues/52) |
| Cycle, reveal, archive, and downloads | [#23](https://github.com/Collaboration95/rewind-app/issues/23), children [#53](https://github.com/Collaboration95/rewind-app/issues/53), [#54](https://github.com/Collaboration95/rewind-app/issues/54), [#55](https://github.com/Collaboration95/rewind-app/issues/55), [#57](https://github.com/Collaboration95/rewind-app/issues/57), [#59](https://github.com/Collaboration95/rewind-app/issues/59), [#61](https://github.com/Collaboration95/rewind-app/issues/61), [#63](https://github.com/Collaboration95/rewind-app/issues/63), [#65](https://github.com/Collaboration95/rewind-app/issues/65) |
| Integration, usability, and demo proof | [#24](https://github.com/Collaboration95/rewind-app/issues/24), children [#67](https://github.com/Collaboration95/rewind-app/issues/67), [#69](https://github.com/Collaboration95/rewind-app/issues/69), [#71](https://github.com/Collaboration95/rewind-app/issues/71), [#73](https://github.com/Collaboration95/rewind-app/issues/73), [#75](https://github.com/Collaboration95/rewind-app/issues/75) |

### Backlog integrity note

An overlapping GitHub CLI operation created duplicate copies of eleven late
Sprint 1 film/archive/quality tasks. The canonical lower-numbered copies are
the only planned work. Each duplicate is labelled `duplicate`, contains a link
to its canonical issue, and is `Blocked` in the Project; it must not be
implemented. No issue has been closed or deleted as part of backlog creation.
