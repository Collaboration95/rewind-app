# Rewind Sprint 0 plan — foundation and first working slice

- **Status:** Proposed for team planning
- **Sprint length:** 2 weeks / 10 weekdays
- **Team:** 5 students
- **Planned dates:** 1–12 September 2026; subject to confirmation against member availability
- **Capacity assumption:** 1 person-day = 8 hours

## Product Goal

Enable a private group to collect short shared moments over a cycle and
experience them together through a delayed reveal.

## 1. Sprint goal

By the Sprint Review, the team can clone the repository, follow one documented
setup path, run an original Rewind mobile/web prototype, switch among five
seeded demo members, view a seeded private group with its prompt, countdown and
contribution quota, and navigate the four main tabs. Every merged change passes
the first automated quality checks.

This is a **walking skeleton**: a thin, working path through the intended
architecture. It is not a claim that authentication, privacy, video processing,
multi-device synchronisation, or the finished product exists.

### Success in one sentence

“A reviewer can start Rewind, see a clearly labelled local demo group, switch
the acting demo member, inspect the cycle/quota state, navigate the app, and see
the repository checks pass.”

## 2. Why this is the right first slice

The proposal contains ten core feature groups and a future cloud architecture.
The intended implementation order is:

1. repository and quality foundation;
2. pure domain contracts;
3. resettable local data and seeded members;
4. profile/group home;
5. device permissions and capture;
6. contribution lifecycle;
7. reminders and chat;
8. simulation, reveal, archive and sharing;
9. hardening and cloud-transition work.

Sprint 0 intentionally completes steps 1–4 at a shallow depth and now also
pulls the local runtime foundation into scope: the LAN/SQLite/FFmpeg gate,
typed local service, schema/reset, app API boundary, and membership policy
(issues #28–#32). This de-risks the next product slice without claiming that
OIDC, AWS, real video processing, chat, reminders, or multi-device capture are
complete.

## 3. Capacity and percentages

The course expectation is approximately 10 person-days for each of five
members over the complete project:

| Calculation | Amount |
|---|---:|
| 5 members × 10 days | 50 person-days |
| 50 days × 8 hours | 400 total project hours |
| Four 2-week sprints, if distributed evenly | 100 hours per sprint |
| Average per member per sprint | 20 hours / 2.5 days |

The 400 hours must include planning, analysis/design, implementation, tests,
DevSecOps, reviews, evidence, reports and presentation work. It should not be
treated as 400 coding hours with documentation added later.

### Sprint 0 commitment

The theoretical two-week capacity ceiling is 100 hours; the Sprint 0 commitment
is limited to 70 hours. The remaining 30 hours provide contingency for setup
problems, learning, integration and unexpected college workload. Stretch work
is not selected to fill spare capacity.

| Sprint 0 effort area | Hours | % of committed 70 h | % of 100 h ceiling |
|---|---:|---:|---:|
| Requirements, backlog and Agile setup | 11 | 15.7% | 11% |
| Analysis, architecture and design decisions | 10 | 14.3% | 10% |
| Repository, app scaffold and CI foundation | 16 | 22.9% | 16% |
| Working seeded group/home slice | 20 | 28.6% | 20% |
| Tests, accessibility, evidence, review and report | 13 | 18.5% | 13% |
| **Committed work** | **70** | **100%** | **70%** |
| Contingency / learning reserve | 30 | — | 30% |

### Two-week loading

Week 1 is deliberately light and decision-oriented:

| Period | Planned committed effort | Purpose |
|---|---:|---|
| Week 1 | 20 team-hours (28.6%) | Story agreement, architecture recording and the first runnable navigation slice; about 4 h per member |
| Week 2 | 50 team-hours (71.4%) | Integrate the working slice, test it, fix it and demonstrate it; about 10 h per member |

These figures represent team effort rather than elapsed office time. Capacity
is adjusted for declared absences during Sprint Planning.

## 4. Product user-story map

The product backlog follows the user's journey rather than a list of
technologies. The broad story groups derive from FR-01–FR-10 and UC-01–UC-05
in the approved proposal:

| Journey step | User outcome | Proposal trace | Planned order |
|---:|---|---|---|
| 1 | Enter Rewind and join the correct private group | FR-01, FR-02 / UC-01 | Start locally in S0; real OIDC/invites later |
| 2 | Understand the current prompt, cycle, quota and locked state | FR-04, FR-05 / UC-02, UC-04 | S0 foundation |
| 3 | Capture, review and submit a short retro-treated clip | FR-03 / UC-02 | S1 |
| 4 | See the contribution process and remain locked until reveal | FR-04 / UC-02 | S1 |
| 5 | Receive and control reminders | FR-05 / UC-04 | S2 |
| 6 | Exchange group messages, replies and reactions | FR-06 / UC-05 | S2 |
| 7 | Reveal a chronological capsule or see a safe delay | FR-07, FR-08 / UC-03 | S2–S3 |
| 8 | View and download authorised archive items | FR-09 / UC-05 | S3 |
| 9 | Operate and deliver the system safely | FR-10 | Built into every sprint |

The first thin part of this map plus the local runtime foundation is selected
for Sprint 0. Capture, chat, reveal, archive, and cloud rows remain in the
Product Backlog and are not implicitly committed.

## 5. Sprint 0 user stories

Sprint 0 commits to **three user stories**. Hours support capacity planning;
story points express relative size, complexity and uncertainty and are not
converted into hours. As the first sprint has no established velocity, completed
points provide the initial observation for Sprint 1 planning.

### US-01 — Launch and navigate the Rewind skeleton

> As a prospective Rewind member, I want to open the application and move
> between its main areas so that I can understand where group memories are
> captured, discussed and revisited.

- **Value:** Produces the first runnable and demonstrable product increment.
- **Estimate:** 3 points / 10 team-hours planning budget
- **Lead:** E
- **Reviewer:** B
- **Target:** Week 1

#### Acceptance scenarios

1. **Given** a supported development machine with the documented prerequisites,
   **when** a team member follows the clean-start instructions, **then** Rewind
   starts without requiring AWS credentials, an account or private media.
2. **Given** the application has started, **when** the member uses the main
   navigation, **then** Home, Camera, Chat and Archive are each reachable.
3. **Given** Camera, Chat or Archive is not implemented yet, **when** the member
   opens it, **then** the screen honestly describes the future capability and
   does not simulate a successful feature.
4. **Given** a member uses assistive labels or keyboard/focus navigation where
   supported, **when** they inspect the tabs, **then** each interactive control
   has a clear accessible name and visible selected state.

#### Not included

- Camera permission or recording.
- Messages, reminders, archive media or cloud connections.
- Final visual polish.

#### Implementation sequence

US-01 is implemented as three small, user-visible slices:

1. A simple Rewind Home/start screen establishes the application entry point,
   basic original visual direction and a clear accessible screen title.
2. The main navigation makes Home, Camera, Chat and Archive reachable.
3. Camera, Chat and Archive receive honest unavailable-feature states and
   accessible tab semantics.

The first slice establishes a minimum visual UI foundation; it does not commit
the sprint to final visual polish or design work for later feature screens.

### US-02 — Select a local demo profile

> As a Rewind demo participant, I want to choose one of the five sample member
> profiles so that I can experience group behaviour from that member's point of
> view before real sign-in is implemented.

- **Value:** Establishes the actor used by group, contribution and later chat
  stories without misrepresenting local data as authentication.
- **Estimate:** 5 points / 16 team-hours planning budget
- **Lead:** A
- **Reviewer:** C
- **Target:** Week 2

#### Acceptance scenarios

1. **Given** a clean local reset, **when** Rewind starts, **then** exactly five
   synthetic member profiles and one synthetic group are available.
2. **Given** the profile switcher is open, **when** the participant selects a
   different member, **then** the visible current actor changes immediately.
3. **Given** a member was selected, **when** the application is relaunched,
   **then** the agreed default or last selection is restored consistently.
4. **Given** any profile-selection screen is visible, **then** it is labelled
   `Local demo` or equivalent and never uses language such as secure login,
   authenticated user or private account.
5. **Given** a synthetic actor who is not a group member, **when** group data is
   requested, **then** the membership guard refuses access in an automated
   negative test.

#### Not included

- OIDC, Cognito, passwords or real identity.
- Creating/editing user profiles, avatars or account deletion.
- Real invitation acceptance or multi-device membership.

### US-03 — Understand the current group capsule

> As a Rewind group member, I want to see the current prompt, time remaining and
> my contribution allowance so that I know what kind of moment to capture and
> how much I may still contribute without seeing locked media.

- **Value:** Demonstrates the defining delayed-reveal group experience rather
  than only a generic navigation shell.
- **Estimate:** 8 points / 20 team-hours planning budget
- **Lead:** B
- **Reviewer:** E
- **Target:** Week 2

#### Acceptance scenarios

1. **Given** a selected synthetic group member, **when** Home loads, **then** it
   shows the group name, current prompt and cycle time remaining.
2. **Given** the member has no contributions, **when** Home loads, **then** it
   shows `0 of 5 contributions` and `0 of 30 seconds` remaining/used in clear
   wording agreed by the team.
3. **Given** seeded contribution metadata changes, **when** Home reloads, **then**
   quota values come from the shared domain/repository boundary rather than
   separately hard-coded UI values.
4. **Given** the cycle is collecting and contributions are locked, **when** Home
   renders, **then** no unrevealed media URI, thumbnail, image, video player or
   share action is present.
5. **Given** data is loading, missing or recoverably fails, **when** Home renders,
   **then** the member sees an understandable loading, empty or retry state.
6. **Given** a screen reader or larger text setting, **when** the member reads
   the countdown and quota, **then** equivalent text is available and state is
   not communicated by colour alone.

#### Not included

- Recording or submitting a contribution.
- Enforcing delete/recapture and processing/retry rules.
- A real four-week scheduler or server-generated countdown.
- Revealing or playing media.

### Story commitment summary

| Story | Points | Team-hours budget | Lead | Reviewer | Dependency |
|---|---:|---:|---|---|---|
| US-01 Launch and navigate | 3 | 10 h | E | B | Foundation enablers |
| US-02 Select demo profile | 5 | 16 h | A | C | US-01, local data contract |
| US-03 Understand group capsule | 8 | 20 h | B | E | US-01, US-02 |
| **User-story total** | **16** | **46 h** |  |  |  |

### Supporting enablers

Enablers are necessary work but are not presented as user value. They exist to
make the three stories testable, maintainable and repeatable.

| Enabler | Outcome | Budget | Lead | Supports |
|---|---|---:|---|---|
| EN-01 Agile/Kanban setup | Working agreement, story board, availability and evidence location | 4 h | D | All stories |
| EN-02 Architecture/data baseline | Local-first ADR, context, glossary and minimal profile/group/cycle contracts | 6 h | C | US-02, US-03 |
| EN-03 Delivery foundation | Repository/app scaffold, clean-start instructions and baseline CI checks | 8 h | C/D | US-01–US-03 |
| EN-04 Quality and review evidence | Focused tests, accessibility check, demo script, review, retrospective and fortnightly report | 6 h | D/E | US-01–US-03 |
| **Enabler total** |  | **24 h** |  |  |
| **Sprint commitment** | 16 story points | **70 h** |  |  |

Enablers do not earn story points. Sprint velocity is measured from Done user
stories rather than setup activity.

### Stretch story — not committed

**Admission condition:** US-01–US-03 are Done and at least eight reserve hours
remain.

> **US-X1:** As a Rewind member, I want the Camera screen to explain and request
> the required device permission so that I understand how to enable capture.

This is permission-state UI only. Recording, upload, filters and cloud work
remain out of scope.

## 6. Kanban workflow for the stories

The board visualises flow and prevents excessive concurrent work:

```text
Product Backlog → Ready → In progress → Review/Test → Done
                              │
                              └── Blocked (flag + reason, not a hiding place)
```

| Column | Meaning | Entry/exit rule | WIP limit |
|---|---|---|---:|
| Product Backlog | Valuable future stories not selected now | Ordered by value/risk | No limit |
| Ready | Refined and small enough to start | Meets Definition of Ready | 3 Sprint 0 stories |
| In progress | Team is actively implementing and testing the story | Named lead; next action visible | **2 stories** |
| Review/Test | Acceptance scenarios are being checked by another member | PR/change available; evidence draft exists | **2 stories** |
| Done | All acceptance scenarios and Definition of Done pass | Merged, demonstrated and documented | No limit |

US-01 starts first. US-02 enters implementation once the navigation skeleton
is usable. US-03 enters implementation only when US-01 is in Review/Test or
Done and the local-profile contract is stable. A full In-progress limit directs
available capacity to completion or review of current stories.

### Story-card template

Kanban cards use the following structure before implementation-ticket creation:

```text
US-__ — Short outcome
As a <user/actor>, I want <capability>, so that <value>.

Acceptance scenarios:
- Given ... when ... then ...

Not included:
- ...

Estimate: <story points>
Lead: <name>
Reviewer: <name>
Dependencies: <story/decision>
Evidence: <test, screenshot, demo step>
Blocker/decision needed: <none or explicit question>
```

Following story acceptance, each story is decomposed into small implementation
tickets or checklist items. Tickets are organised around observable behaviour,
not isolated technical layers; each completed story crosses the necessary UI,
domain, data and test boundaries.

### Sprint-level acceptance and evidence

- US-01, US-02 and US-03 are all Done; partial stories earn no velocity.
- All checks pass from a clean checkout on a second member's machine.
- The five-minute demo works without command-line rescue.
- Evidence includes a passing CI result, synthetic screenshot, focused test
  output, limitations and relevant commit/PR links once implementation begins.
- The fortnightly report records planned versus completed stories and points,
  member effort, problems/action plan, burndown, review and retrospective.
- Review feedback returns to the Product Backlog and does not rewrite the
  completed sprint history.

## 7. Five-person responsibilities

These are primary responsibilities rather than silos. Every lead has an assigned
reviewer, and Sprint Goal completion takes priority over optional work.

| Member | Full-project use-case ownership | Sprint 0 role | Committed hours | Secondary responsibility |
|---|---|---|---:|---|
| A | UC-01 identity, groups and invitations | Product Owner proxy; backlog and seeded membership lead | 15 h | Review architecture and keep scope/exclusions clear |
| B | UC-02 capture and contribution lifecycle | User-story/acceptance lead; home/quota slice lead | 15 h | Review UX and prepare later camera stories |
| C | UC-03 compile and publish capsule | Technical/integration lead; architecture and scaffold | 15 h | Keep cycle/worker seams replaceable and pair on setup |
| D | UC-04 prompts and reminders | Scrum facilitator; CI/quality and reporting lead | 13 h | Maintain board/burndown and unblock reviews |
| E | UC-05 chat and archive/download | UX/accessibility and evidence lead; app shell | 12 h | Own demo flow and cross-screen consistency |
| **Total** |  |  | **70 h** |  |

The uncommitted reserve is A: 5 h, B: 5 h, C: 5 h, D: 7 h and E: 8 h, for a
30-hour team reserve. It is used for integration, review or blockers; it is not
pre-assigned feature scope.

### Pairing/review map

- A ↔ C: group/domain boundary and seeded repository.
- B ↔ E: home state, wording and acceptance behaviour.
- C ↔ D: build scripts and CI.
- D ↔ E: accessibility, evidence and report completeness.
- No one approves their own pull request.

The Scrum facilitator is not the team manager, and the Product Owner proxy is
not the sole requirements author. Both roles rotate in Sprint 1.

## 8. Day-by-day plan

| Day | Team outcome | Main activities | Exit check |
|---:|---|---|---|
| 1 | Shared goal and capacity | 90-minute planning; availability; roles; working agreement; agree US-01–US-03 | Everyone can explain the Sprint Goal and exclusions |
| 2 | Ready backlog | Refine stories/criteria; map FRs/UCs; identify decisions and risks | US-01–US-03 meet Definition of Ready |
| 3 | Agreed skeleton | Architecture workshop; glossary; ADR; repository boundary | Team accepts one thin architecture, with open questions logged |
| 4 | Runnable scaffold and start UI | Pair on setup; README; Home/start screen begins | Two different machines can run the app and open Rewind's start screen |
| 5 | Navigation checkpoint | CI baseline; main-navigation review; backlog refinement | First small PRs merged; CI is green; all four areas are reachable |
| 6 | Seeded state works | Local fixtures/repository/profile session integrated | Five synthetic members and group reset reliably |
| 7 | Home slice works | Prompt/countdown/quota view; negative membership test | Main happy path is demonstrable |
| 8 | Quality pass | Error/empty states; accessibility; tests; cross-machine setup | Must acceptance gaps are listed and owned |
| 9 | Release candidate | Fix only goal-threatening defects; clean-run rehearsal; evidence/report draft | Demo script passes twice from a clean state |
| 10 | Inspect and adapt | Sprint Review, retrospective, report completion, re-order Sprint 1 backlog | Done work accepted; incomplete work returned to backlog |

Large Day 9 merges are avoided. Integration begins on Day 4 and continues daily.

## 9. Future branch and pull-request workflow

Implementation tickets are created after story and acceptance-scenario
acceptance. The implementation workflow is trunk-based:

```text
main
 ├─ feat/us-01-navigation ──── PR/review/checks ──> main
 ├─ feat/us-02-demo-profile ── PR/review/checks ──> main
 └─ feat/us-03-group-home ───── PR/review/checks ──> main
```

- Branches originate from an up-to-date `main`.
- Branch names use `feat/us-<story>-<short-name>`, `test/...`, or `docs/...`.
- One small implementation ticket produces one coherent PR; a story may contain
  several small tickets while remaining one Kanban story card.
- Branches remain under two working days where practical.
- Every PR requires one peer approval and green checks.
- Commits are small and use conventional prefixes such as `feat:`, `test:`,
  `docs:`, `fix:`, and `chore:`.
- One branch per team member and long-lived `develop` branches are excluded to
  prevent late integration.
- Ownership overlap is resolved in planning before concurrent edits begin.

## 10. Agile practices for a newcomer team

### Lightweight events

| Event | Timebox | Purpose/output |
|---|---:|---|
| Sprint Planning | 90 min on Day 1 | Goal, capacity, committed backlog, owners and risks |
| Stand-up | 10 min each weekday, or asynchronous if schedules conflict | Progress toward goal, next action, blocker; not a manager status report |
| Backlog refinement | 30 min on Day 5 | Readies the next stories without expanding current scope |
| Pair/mob session | Two 45–60 min sessions | Shares setup/domain knowledge on risky work |
| Sprint Review | 45 min on Day 10 | Demonstrate Done software and capture stakeholder feedback |
| Retrospective | 45 min after Review | Choose one concrete process experiment for Sprint 1 |

When daily live attendance is impractical, updates use the fixed asynchronous
format `Goal progress / next action / blocker or decision needed`; three
15-minute live synchronisations occur each week. This is a deliberate
student-team adaptation of the textbook Daily Scrum cadence.

### Work rules

- Work is swarmed around the Sprint Goal rather than divided into equal task counts.
- The `In progress` Kanban limit is two stories.
- New work is pulled only when a current item is Done or genuinely blocked.
- Testing occurs within each story; a final testing week is not part of the plan.
- High-risk setup/domain work is paired and all work receives cross-review.
- Decisions are recorded on story cards or ADRs for continuity.
- Media and identities remain synthetic.
- Evidence is captured during story completion rather than at the report deadline.
- Actual member effort is recorded for the fortnightly report; value and outcomes
  are assessed rather than hours alone.

## 11. Definition of Ready

A story may enter `Ready` only when:

- its user/system value is stated;
- observable acceptance criteria and at least one relevant failure path exist;
- dependencies and open decisions are resolved;
- lead and reviewer are named;
- verification/evidence method is stated;
- scope is small enough to finish in roughly one day of focused team effort;
- no security, privacy or device question could invalidate the approach.

Items exceeding this scope are split by observable behaviour rather than by
technical layer alone.

## 12. Definition of Done

An item is `Done` only when:

- acceptance criteria are demonstrated;
- implementation and tests are committed on a reviewed PR;
- formatting/lint, type checking and relevant tests pass locally and in CI;
- another member reviewed it; the author did not self-approve;
- required accessibility labels/test identifiers are present;
- documentation and architecture decisions are updated where behaviour changed;
- evidence uses synthetic/non-sensitive data and records known limitations;
- the change is merged into `main` and the board/report is updated;
- no secret, personal media or generated build output was committed.

“Code complete,” “works on my laptop,” “PR open,” and “90% done” are not Done.
An incomplete item returns to the Product Backlog and is re-estimated; it earns
no completed story points this sprint.

## 13. Burndown plan

The burndown tracks **remaining committed task hours** and is updated after the
stand-up. Remaining work reflects the team's current best estimate rather than
time already spent.

The planned line is deliberately shallow in Week 1 and steeper in Week 2:

| Checkpoint | Planned remaining hours |
|---|---:|
| Start / Day 1 | 70 |
| End Day 1 | 69 |
| End Day 2 | 67 |
| End Day 3 | 64 |
| End Day 4 | 59 |
| End Day 5 | 50 |
| End Day 6 | 40 |
| End Day 7 | 30 |
| End Day 8 | 19 |
| End Day 9 | 6 |
| End Day 10 | 0 |

Scope changes require an explicit team decision and appear as upward movement;
historical burndown values remain unchanged.

## 14. Review demonstration

The five-minute demonstration follows this sequence:

1. Board and Sprint Goal (20 seconds).
2. Documented startup command from a clean checkout (40 seconds).
3. Rewind launch and `Local demo` limitation (20 seconds).
4. Home, Camera, Chat and Archive navigation (30 seconds).
5. Seeded-member switching and visible actor change (40 seconds).
6. Group prompt, countdown, quota and locked-safe state (50 seconds).
7. Focused automated test and green CI result (60 seconds).
8. Unimplemented scope and stakeholder feedback (40 seconds).

Seeded profiles are not described as login, placeholder routes are not described
as features, and local data is not represented as secure multi-user privacy.

## 15. Risks and responses

| Risk | Early signal | Sprint 0 response |
|---|---|---|
| Setup differs across laptops | A second member cannot run by Day 4 | Immediate pairing, version recording and setup simplification before features |
| Proposal scope pulls work toward AWS too early | Cloud stories enter Ready | Cloud work remains in the backlog; interfaces are validated locally first |
| Camera/media complexity consumes sprint | Recording spike starts before home slice | Real capture remains in Sprint 1; S0-X1 requires completion of all Must work |
| Members work in silos | Large unreviewed branches or duplicate files | Reviewer map, WIP limit and short branches are enforced |
| Documentation is postponed | No evidence/report owner by Day 5 | Evidence is acceptance work; D/E maintain continuous drafts |
| “Local demo” is mistaken for privacy/auth | UI or presentation uses “secure login” | Simulation labelling and a negative membership-policy test are required |
| Unknown availability causes missed work | Hours are not declared in planning | Capacity is recalculated and lowest-value scope is removed before commitment |

## 16. High-level direction after Sprint 0

This is a forecast, not a detailed commitment:

| Period | Indicative outcome | Share of total 400 h |
|---|---|---:|
| S0: 1–12 Sep | Planning, architecture, delivery rails, seeded skeleton, and local runtime foundation | 17.5% / 70 h |
| S1: 13–26 Sep | Identity/groups, real device permission/capture, contribution lock, and local product flow | 26.25% / 105 h |
| S2: 29 Sep–12 Oct | Reminder/chat plus simulated reveal/archive; strengthen security/CI evidence | 27.5% / 110 h |
| S3: 13–26 Oct | Integration, highest-value approved cloud slice, device pilot, hardening and submission | 21.25% / 85 h |
| Presentation: 27 Oct–2 Nov | Rehearsal, slide refinement, demo backup and presentation feedback preparation | 7.5% / 30 h |
| **Total** |  | **100% / 400 h** |

This forecast assumes presentation preparation is part of the stated 400-hour
project effort. If the lecturer requires all 400 hours to be expended before
the 26 October submission, move the final 30 hours into S3 rather than adding
them on top of 400.

The S0 Review uses actual velocity and effort to reforecast. The presence of
cloud features in the proposal does not constitute a delivery commitment. Before
S1 planning, the assessed scope is confirmed as either a bounded local-first
proof of concept or a full cloud flow. A full cloud-flow expectation requires
reduced breadth and selection of one end-to-end capture-to-reveal path.

## 17. Sprint Planning decisions

The following decisions remain outstanding; none prevents preparation of the
sprint document:

1. Actual sprint start/end dates and each member's available hours.
2. Real member names mapped to A–E and the first role rotation.
3. `rewind-app` repository/board location and branch-protection permissions.
4. Supported development machines and the single device/browser used for the
   Sprint 0 demo.
5. Lecturer expectation for local-first versus cloud scope.
6. Storage location for fortnightly reports, screenshots, diagrams and AI-use disclosure.
