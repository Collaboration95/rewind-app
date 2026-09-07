# Sprint 0 delivery controls

Status: active planning record
Source: `SWEE5006-Project-Planning-docs/planning/sprints/sprint-0-plan.md`

This record makes the controls used by the `Rewind — Sprint 0` GitHub Project
visible alongside the repository. It uses planning labels rather than personal
identity data until the team confirms real member names.

## Board and milestone

- Repository: `Collaboration95/rewind-app`
- Project: `Rewind — Sprint 0`
- Milestone: `Sprint 0`
- Workflow: `Product Backlog → Ready → In Progress → Review/Test → Done`
- Exception state: `Blocked`, with the blocker reason recorded on the issue
- In Progress WIP limit: two active stories

The GitHub Project is authoritative for live status. This document records the
rules and the repository provides the auditable change history.

## Planning member map

| Member label | Sprint 0 role                                           | Planned hours | Review pairing |
| ------------ | ------------------------------------------------------- | ------------: | -------------- |
| A            | Product Owner proxy; backlog and seeded-membership lead |            15 | C              |
| B            | Acceptance lead; home/quota slice lead                  |            15 | E              |
| C            | Technical/integration lead; architecture and scaffold   |            15 | A              |
| D            | Scrum facilitator; CI, quality and reporting            |            13 | E              |
| E            | UX/accessibility and evidence lead; app shell           |            12 | B              |

These are the planned Sprint 0 capacities from the sprint plan, not a claim
about actual attendance. Real names and availability are a team decision and
must be added to the planning record before the sprint review if required.

## Working agreement

- Work is pulled toward the Sprint Goal; the two-story In Progress limit is
  respected.
- Branches start from an up-to-date `main`, stay short-lived, and use the
  `feat/`, `test/`, `docs/`, or `chore/` prefixes.
- Every change has a named reviewer who is not its author.
- Acceptance checks and evidence are produced with the change, not after the
  sprint report is due.
- Synthetic/non-sensitive data is used for demos and committed evidence.
- Cloud credentials, real identities, and private media are never required for
  Sprint 0 local work.
- Decisions that affect scope, privacy, platform, or data boundaries are
  recorded in an ADR or issue comment.

## Flow and review rules

An item enters `Ready` only after its value, acceptance criteria, dependencies,
reviewer, and verification evidence are clear. It enters `Review/Test` when a
reviewable change and evidence draft exist. It enters `Done` only after the
change is merged, acceptance is demonstrated, checks are green, and the board
and issue evidence are updated.

`Blocked` is a visible exception state, not a way to hide unfinished work. The
issue records the exact external decision or failure needed to continue.
