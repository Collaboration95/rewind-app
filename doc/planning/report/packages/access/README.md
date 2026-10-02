# Access package — report draft

**Status:** implementation-grounded, open package draft; fixed evidence cut `a6b6b312f219c268a16401f64efe6c3b8f808a54` (published PR #368 source snapshot), refreshed 2 October 2026. **Not final report assembly or acceptance evidence.**

This package models UC01 account authentication and sessions, UC02 real-group create/select, and UC03 invitation issue/revoke/accept. It follows issue [#357](https://github.com/Collaboration95/rewind-app/issues/357), the submitted *Rewind Project Proposal* §§4.1, 5.1–5.2 and 7.1, and the supplied Practice Module Report Template §§3.3.2, 3.4.1 and 3.5.1. Those sources require analysis and design class models, normal and relevant exceptional flows, one analysis and one design sequence for every major flow, and before/after class and sequence views for a real design problem.

## Evidence boundary

- The code snapshot is the published PR #368 source commit at the exact SHA above; that SHA is a fixed evidence cut even if the PR advances. PR #368 remains open/draft. Account registration, local-password sign-in, opaque sessions, real groups, and real invitations are implemented against SQLite. The refreshed UC02 pilot also stores group timezone and per-member/group reminder preferences.
- Synthetic Demo sessions remain a separate access path. They are not accounts or credentials.
- Managed OIDC/Cognito, provider-subject mapping, and PostgreSQL are Sprint 3 targets tracked by [#363](https://github.com/Collaboration95/rewind-app/issues/363) and [#364](https://github.com/Collaboration95/rewind-app/issues/364). Redirect, cancellation, and provider callback behavior are not represented as implemented pilot behavior.
- `server/src/policy.ts` centralizes member/owner decisions for Demo identities. Real-account group and invitation paths validate account sessions and use account-specific membership queries. The diagrams preserve that distinction; they do not imply one universal policy object.
- Group creation accepts an optional validated IANA timezone and defaults it to UTC; the current client omits it. The owner can edit the prompt and timezone only while the current cycle is collecting. Members can save an enabled/snoozed preference per group; the API calculates a Sunday 19:00 group-zone schedule but reports delivery as `not-configured`.
- This source package does not assign report ownership or state individual effort. It does not make an acceptance claim.

## Draft coverage

The flow catalogue declares twelve major flow families. Each has a separately identified analysis sequence and design sequence, with exceptional branches enumerated in its flow description and diagram. UC01–UC03 each have one analysis and one design class diagram. The central authorization problem has before/after static and dynamic diagrams. All 35 vector sources are in [`diagrams/`](diagrams/); links below embed those figures.

| Report item | Draft location | State |
|---|---|---|
| Overall use-case view and explicit exclusions | [use-cases.md](use-cases.md) | Drafted |
| Normal and exceptional flow descriptions | [use-cases.md](use-cases.md) | Twelve flow families, with branches enumerated |
| Per-use-case analysis/design classes and per-flow sequences | [models.md](models.md) | Drafted for the current pilot; see Sprint 3 boundary |
| Design problem, candidates, rationale, implementation decision | [design-problem.md](design-problem.md) | Drafted against current source |
| Code and source traceability | All three files | Exact commit and line anchors at the captured code SHA |

## Issue requirement trace (bounded)

Issue #357 names `R01–R03,R22` but does not include their canonical wording or a requirement-to-use-case crosswalk. This bounded trace uses the supplied Sprint 2 execution plan §§3 and 13; it is not presented as the canonical crosswalk. The execution-plan file is a local submission source and is not present in the published `a6b6b31` tree.

| ID | Grounded summary from supplied execution plan | Evidence in this package | Boundary |
|---|---|---|---|
| R01 | Managed OIDC/auth-session target and signup/authentication journey | UC01 models the implemented local-password account/session pilot and labels managed OIDC as Sprint 3 target | OIDC/provider callback is not implemented at this cut |
| R02 | Invite-only private groups, 2–10 capacity, and membership privacy | UC02 group creation/selection plus UC03 invite acceptance and member checks | Models only the cited code paths; no public discovery or membership removal implied |
| R03 | Expiring native/web invitations | UC03 issue/revoke/accept flows and bounded expiry/deep-link trace | Device/provider acceptance has not been verified here |
| R22 | Final report template, proposal presentation, and Agile evidence | This is the ACCESS model package input to the eventual report | Does not assemble the report/presentation or assert team contributions/effort |

The plan-level summary is enough to orient this package, but exact canonical R wording and an approved R-to-UC mapping remain unavailable from the #357 issue body and committed `a6b6b31` source. Keep this limitation explicit until the canonical crosswalk is supplied.

## Deliberate limits

This is a report-package draft, not a claim that the proposal is fully implemented. UC01 demonstrates the local-password auth/session pilot; managed OIDC, callback behavior, and provider-subject mapping remain Sprint 3 targets. Reminder preference persistence and schedule calculation exist, but delivery is not configured. Provider and physical-device acceptance have not been verified at this evidence cut. The canonical `R01–R03,R22` wording/crosswalk is not in the issue body or committed source; the bounded plan-derived mapping above must not be mistaken for that missing canonical artifact. Individual ownership, effort, and acceptance are not asserted here.

No product tests were run for this prose/model package. Changed SVGs were rendered using the machine's existing macOS SVG renderer for visual inspection; no diagram package was installed. Refresh the package when the evidence cut changes and assemble it with the remaining report packages only in the final report workflow.
