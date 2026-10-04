# Access analysis and design models

**Code baseline:** [accepted dev source snapshot `fc2b8c811e9c13b176113fa0bdb2c015798990b4`](https://github.com/Collaboration95/rewind-app/commit/fc2b8c811e9c13b176113fa0bdb2c015798990b4). This is the fixed evidence cut; PR #368 is merged; this pin is the refreshed accepted dev baseline. Analysis models express account/group/invitation responsibilities. Design models name only components or persistence concepts evidenced in that snapshot. The dashed Cognito box is a Sprint 3 target, not a deployed dependency.

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

### UC02-F3 — Edit collecting-cycle prompt and group timezone

**Analysis sequence**

![UC02-F3 analysis sequence](diagrams/uc02-f3-analysis-sequence.svg)

**Design sequence**

![UC02-F3 design sequence](diagrams/uc02-f3-design-sequence.svg)

### UC02-F4 — Save a member reminder preference

**Analysis sequence**

![UC02-F4 analysis sequence](diagrams/uc02-f4-analysis-sequence.svg)

**Design sequence**

![UC02-F4 design sequence](diagrams/uc02-f4-design-sequence.svg)

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

- Account screen and provider state: [`RealAccountProvider.tsx`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/auth/RealAccountProvider.tsx#L55), [`real-account-client.ts`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/auth/real-account-client.ts#L103).
- Account registration, password verification, session validation and revocation: [`server/src/auth/index.ts`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/auth/index.ts#L122), [`server/src/http.ts` auth routes](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/http.ts#L4141).
- Real group input/default timezone, create, read and select: [`server/src/groups/real.ts`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/groups/real.ts#L15), [`UTC default + validation`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/groups/real.ts#L40), [`createRealGroup`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/groups/real.ts#L45), [`handleRealGroupRequest`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/http.ts#L3516).
- UC02 settings and reminders: [`updateRealGroupSettings`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/groups/settings.ts#L5), [`getRealReminderPreference`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/groups/settings.ts#L44), [`updateRealReminderPreference`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/groups/settings.ts#L70), and [HTTP routes](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/http.ts#L3783).
- UI evidence: [group create JSON omits timeZone](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/groups/RealAccountGroupExperience.tsx#L658), [owner-only prompt/timezone controls](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/reminders/RealGroupSettings.tsx#L131), and [member reminder controls](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/reminders/RealGroupSettings.tsx#L184).
- Timezone validation and Sunday schedule: [`validateTimeZone`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/reminders/schedule.ts#L3), [`nextWeeklyReminderAt`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/reminders/schedule.ts#L55). [UTC migration default and reminder table setup](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/db.ts#L219); preference schema [`025-real-group-reminders.sql`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/migrations/025-real-group-reminders.sql#L3).
- Successor cycle copies prompt: [`ensureSuccessor`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/cycles/lifecycle.ts#L276).
- Invitation create/revoke/accept: [`server/src/groups/invites.ts`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/groups/invites.ts#L124), [`RealAccountGroupExperience.tsx`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/groups/RealAccountGroupExperience.tsx#L687), [`deep-links.ts`](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/invites/deep-links.ts#L52).

The figure source files are editable SVG. They intentionally show the current SQLite-backed persistence, timezone settings, persisted reminder preference, and account-specific membership checks. Reminder delivery is marked unconfigured. The separate Demo member/session lane appears in the design-problem figures because its policy boundary is part of the observed authorization design; it is not a substitute for real-account identity.
