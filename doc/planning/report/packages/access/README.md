# Access package — report draft

**Status:** implementation-grounded draft, captured against `450a7199767ecc4ea3e96f0f7503d0f2170d382c` on 2 October 2026. **Not final acceptance evidence.**

This package models UC01 account authentication and sessions, UC02 real-group create/select, and UC03 invitation issue/revoke/accept. It follows issue [#357](https://github.com/Collaboration95/rewind-app/issues/357), the submitted *Rewind Project Proposal* §§4.1, 5.1–5.2 and 7.1, and the supplied Practice Module Report Template §§3.3.2, 3.4.1 and 3.5.1. Those sources require analysis and design class models, normal and relevant exceptional flows, one analysis and one design sequence for every major flow, and before/after class and sequence views for a real design problem.

## Evidence boundary

- The code snapshot is the integrated Sprint 2 pilot at the exact SHA above. Account registration, password sign-in, opaque sessions, real groups, and real invitations are implemented against SQLite.
- Synthetic Demo sessions remain a separate access path. They are not accounts or credentials.
- Managed OIDC/Cognito, provider-subject mapping, and PostgreSQL are Sprint 3 targets tracked by [#363](https://github.com/Collaboration95/rewind-app/issues/363) and [#364](https://github.com/Collaboration95/rewind-app/issues/364). Redirect, cancellation, and provider callback behavior are not represented as implemented pilot behavior.
- `server/src/policy.ts` centralizes member/owner decisions for Demo identities. Real-account group and invitation paths validate account sessions and use account-specific membership queries. The diagrams preserve that distinction; they do not imply one universal policy object.
- This source package does not assign report ownership or state individual effort. It does not make an acceptance claim.

## Draft coverage

The flow catalogue declares ten major flow families. Each has a separately identified analysis sequence and design sequence, with exceptional branches enumerated in its flow description and diagram. UC01–UC03 each have one analysis and one design class diagram. The central authorization problem has before/after static and dynamic diagrams. All vector sources are in [`diagrams/`](diagrams/); links below embed those figures.

| Report item | Draft location | State |
|---|---|---|
| Overall use-case view and explicit exclusions | [use-cases.md](use-cases.md) | Drafted |
| Normal and exceptional flow descriptions | [use-cases.md](use-cases.md) | Ten flow families, with branches enumerated |
| Per-use-case analysis/design classes and per-flow sequences | [models.md](models.md) | Drafted for the current pilot; see Sprint 3 boundary |
| Design problem, candidates, rationale, implementation decision | [design-problem.md](design-problem.md) | Drafted against current source |
| Code and source traceability | All three files | Anchored to the captured code SHA |

## Deliberate limits

This is a report-package draft, not a claim that the proposal is fully implemented. UC01 currently demonstrates local-password auth rather than the proposal's managed OIDC; provider callback behavior and OIDC subject mapping are not implemented. Provider and physical-device acceptance have not been verified at this evidence cut. The committed source set does not define a crosswalk for issue-level `R01–R03,R22`; the issue is cited as their source, and the proposal's directly traceable labels `FR-01` and `FR-02` are retained without guessing a mapping. Individual ownership, effort, and acceptance are not asserted here; this package does not turn those report facts into a review gate.

No product tests were run for this prose/model package. Diagram sources are SVG. They were rendered using the machine's existing macOS SVG renderer for visual inspection; no diagram package was installed. The final report must refresh code links, flows, models, requirement trace, and factual status after Sprint 3 OIDC/database work and final review.
