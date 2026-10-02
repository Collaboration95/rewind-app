# Access analysis and design models

**Code baseline:** [integrated commit `450a719`](https://github.com/Collaboration95/rewind-app/commit/450a7199767ecc4ea3e96f0f7503d0f2170d382c). Analysis models express account/group/invitation responsibilities. Design models name only components or persistence concepts evidenced in that snapshot. The dashed Cognito box is a future target, not a deployed dependency.

## UC01 — Account authentication and session

### Analysis class diagram

![UC01 analysis classes](diagrams/uc01-analysis-class.svg)

### Design class diagram

![UC01 design classes](diagrams/uc01-design-class.svg)

### UC01-F1 — Register an account

**Analysis sequence**

![UC01-F1 analysis sequence](diagrams/uc01-f1-analysis-sequence.svg)

**Design sequence**

![UC01-F1 design sequence](diagrams/uc01-f1-design-sequence.svg)

### UC01-F2 — Sign in

**Analysis sequence**

![UC01-F2 analysis sequence](diagrams/uc01-f2-analysis-sequence.svg)

**Design sequence**

![UC01-F2 design sequence](diagrams/uc01-f2-design-sequence.svg)

### UC01-F3 — Restore or validate a session

**Analysis sequence**

![UC01-F3 analysis sequence](diagrams/uc01-f3-analysis-sequence.svg)

**Design sequence**

![UC01-F3 design sequence](diagrams/uc01-f3-design-sequence.svg)

### UC01-F4 — Sign out

**Analysis sequence**

![UC01-F4 analysis sequence](diagrams/uc01-f4-analysis-sequence.svg)

**Design sequence**

![UC01-F4 design sequence](diagrams/uc01-f4-design-sequence.svg)

## UC02 — Group create and selection

### Analysis class diagram

![UC02 analysis classes](diagrams/uc02-analysis-class.svg)

### Design class diagram

![UC02 design classes](diagrams/uc02-design-class.svg)

### UC02-F1 — Create a group

**Analysis sequence**

![UC02-F1 analysis sequence](diagrams/uc02-f1-analysis-sequence.svg)

**Design sequence**

![UC02-F1 design sequence](diagrams/uc02-f1-design-sequence.svg)

### UC02-F2 — List, read, and select a group

**Analysis sequence**

![UC02-F2 analysis sequence](diagrams/uc02-f2-analysis-sequence.svg)

**Design sequence**

![UC02-F2 design sequence](diagrams/uc02-f2-design-sequence.svg)

## UC03 — Invitations

### Analysis class diagram

![UC03 analysis classes](diagrams/uc03-analysis-class.svg)

### Design class diagram

![UC03 design classes](diagrams/uc03-design-class.svg)

### UC03-F1 — Create an invitation

**Analysis sequence**

![UC03-F1 analysis sequence](diagrams/uc03-f1-analysis-sequence.svg)

**Design sequence**

![UC03-F1 design sequence](diagrams/uc03-f1-design-sequence.svg)

### UC03-F2 — Revoke an invitation

**Analysis sequence**

![UC03-F2 analysis sequence](diagrams/uc03-f2-analysis-sequence.svg)

**Design sequence**

![UC03-F2 design sequence](diagrams/uc03-f2-design-sequence.svg)

### UC03-F3 — Accept a valid invitation

**Analysis sequence**

![UC03-F3 analysis sequence](diagrams/uc03-f3-analysis-sequence.svg)

**Design sequence**

![UC03-F3 design sequence](diagrams/uc03-f3-design-sequence.svg)

### UC03-F4 — Reject an unusable invitation

**Analysis sequence**

![UC03-F4 analysis sequence](diagrams/uc03-f4-analysis-sequence.svg)

**Design sequence**

![UC03-F4 design sequence](diagrams/uc03-f4-design-sequence.svg)

## Source trace

- Account screen and provider state: [`RealAccountProvider.tsx`](https://github.com/Collaboration95/rewind-app/blob/450a7199767ecc4ea3e96f0f7503d0f2170d382c/src/auth/RealAccountProvider.tsx#L55), [`real-account-client.ts`](https://github.com/Collaboration95/rewind-app/blob/450a7199767ecc4ea3e96f0f7503d0f2170d382c/src/auth/real-account-client.ts#L101).
- Account registration, password verification, session validation and revocation: [`server/src/auth/index.ts`](https://github.com/Collaboration95/rewind-app/blob/450a7199767ecc4ea3e96f0f7503d0f2170d382c/server/src/auth/index.ts#L122), [`server/src/http.ts` auth routes](https://github.com/Collaboration95/rewind-app/blob/450a7199767ecc4ea3e96f0f7503d0f2170d382c/server/src/http.ts#L3460).
- Real group creation and selection: [`server/src/groups/real.ts`](https://github.com/Collaboration95/rewind-app/blob/450a7199767ecc4ea3e96f0f7503d0f2170d382c/server/src/groups/real.ts#L14), [`server/src/http.ts` real-group routes](https://github.com/Collaboration95/rewind-app/blob/450a7199767ecc4ea3e96f0f7503d0f2170d382c/server/src/http.ts#L3215).
- Invitation create/revoke/accept: [`server/src/groups/invites.ts`](https://github.com/Collaboration95/rewind-app/blob/450a7199767ecc4ea3e96f0f7503d0f2170d382c/server/src/groups/invites.ts#L124), [`RealAccountGroupExperience.tsx`](https://github.com/Collaboration95/rewind-app/blob/450a7199767ecc4ea3e96f0f7503d0f2170d382c/src/groups/RealAccountGroupExperience.tsx#L388), [`deep-links.ts`](https://github.com/Collaboration95/rewind-app/blob/450a7199767ecc4ea3e96f0f7503d0f2170d382c/src/invites/deep-links.ts#L49).

The figure source files are editable SVG. They intentionally show the current SQLite-backed persistence and account-specific membership checks. The separate Demo member/session lane appears in the design-problem figures because its policy boundary is part of the observed authorization design; it is not a substitute for real-account identity.
