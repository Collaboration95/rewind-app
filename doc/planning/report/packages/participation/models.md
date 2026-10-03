# Participation analysis and design models

**Fixed source pin:** [accepted `dev` snapshot `1128b6a68985cf68215beb4a7a80fd00ec4242fa`](https://github.com/Collaboration95/rewind-app/commit/1128b6a68985cf68215beb4a7a80fd00ec4242fa). Analysis diagrams express domain responsibilities without implementation class claims. Design diagrams use actual component, function, transport and persisted-record names at this cut. Flow inventory: [use cases](use-cases.md).

## UC09 — Owner prompt and timezone

### Analysis classes

![UC09 analysis classes](diagrams/uc09-analysis-class.svg)

### Design classes

![UC09 design classes](diagrams/uc09-design-class.svg)

### UC09-F1 — Load owner controls

**Analysis sequence**

![UC09-F1 analysis sequence](diagrams/uc09-f1-analysis-sequence.svg)

**Design sequence**

![UC09-F1 design sequence](diagrams/uc09-f1-design-sequence.svg)

### UC09-F2 — Save prompt and timezone

**Analysis sequence**

![UC09-F2 analysis sequence](diagrams/uc09-f2-analysis-sequence.svg)

**Design sequence**

![UC09-F2 design sequence](diagrams/uc09-f2-design-sequence.svg)

## UC10 — Reminder preference and delivery

### Analysis classes

![UC10 analysis classes](diagrams/uc10-analysis-class.svg)

### Design classes

![UC10 design classes](diagrams/uc10-design-class.svg)

### UC10-F1 — Read, enable, disable or snooze

**Analysis sequence**

![UC10-F1 analysis sequence](diagrams/uc10-f1-analysis-sequence.svg)

**Design sequence**

![UC10-F1 design sequence](diagrams/uc10-f1-design-sequence.svg)

### UC10-F2 — Register, inspect or disable destination

**Analysis sequence**

![UC10-F2 analysis sequence](diagrams/uc10-f2-analysis-sequence.svg)

**Design sequence**

![UC10-F2 design sequence](diagrams/uc10-f2-design-sequence.svg)

### UC10-F3 — Scan and enqueue one weekly job

**Analysis sequence**

![UC10-F3 analysis sequence](diagrams/uc10-f3-analysis-sequence.svg)

**Design sequence**

![UC10-F3 design sequence](diagrams/uc10-f3-design-sequence.svg)

### UC10-F4 — Send, receipt, retry or terminate

**Analysis sequence**

![UC10-F4 analysis sequence](diagrams/uc10-f4-analysis-sequence.svg)

**Design sequence**

![UC10-F4 design sequence](diagrams/uc10-f4-design-sequence.svg)

## UC11 — Private group chat

### Analysis classes

![UC11 analysis classes](diagrams/uc11-analysis-class.svg)

### Design classes

![UC11 design classes](diagrams/uc11-design-class.svg)

### UC11-F1 — Read bounded history

**Analysis sequence**

![UC11-F1 analysis sequence](diagrams/uc11-f1-analysis-sequence.svg)

**Design sequence**

![UC11-F1 design sequence](diagrams/uc11-f1-design-sequence.svg)

### UC11-F2 — Send text or reply

**Analysis sequence**

![UC11-F2 analysis sequence](diagrams/uc11-f2-analysis-sequence.svg)

**Design sequence**

![UC11-F2 design sequence](diagrams/uc11-f2-design-sequence.svg)

### UC11-F3 — Toggle reaction

**Analysis sequence**

![UC11-F3 analysis sequence](diagrams/uc11-f3-analysis-sequence.svg)

**Design sequence**

![UC11-F3 design sequence](diagrams/uc11-f3-design-sequence.svg)

### UC11-F4 — Reconnect and replay

**Analysis sequence**

![UC11-F4 analysis sequence](diagrams/uc11-f4-analysis-sequence.svg)

**Design sequence**

![UC11-F4 design sequence](diagrams/uc11-f4-design-sequence.svg)

## Source trace at the fixed pin

- Owner prompt/timezone controls: [`RealGroupSettings`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/src/reminders/RealGroupSettings.tsx#L20), [`updateRealGroupSettings`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/groups/settings.ts#L5), group settings/reminder route [`server/src/http.ts`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/http.ts#L3783), timezone resolver [`nextWeeklyReminderAt`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/reminders/schedule.ts#L55).
- Preference read/write: [`getRealReminderPreference`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/groups/settings.ts#L44), [`updateRealReminderPreference`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/groups/settings.ts#L70), schema [`025-real-group-reminders.sql`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/migrations/025-real-group-reminders.sql#L3).
- Device destination client and platform adapters: [`createPrivateReminderClient`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/src/reminders/private-reminder-client.ts#L39), [`push-platform.ts`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/src/reminders/push-platform.ts#L43), destination routes [`server/src/http.ts`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/http.ts#L3569), [`registerReminderDestination`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/reminders/outbox.ts#L158), [`disableReminderDestination`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/reminders/outbox.ts#L274).
- Durable reminder scheduling and delivery: the one-shot [`runReminderCommand`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/cli.ts#L676) requires `--once` and explicitly does not start a schedule; it invokes [`scanDueReminderJobs`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/reminders/outbox.ts#L303) and [`runReminderOutboxTick`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/reminders/outbox.ts#L440). Provider adapters [`createExpoReminderProvider`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/reminders/providers.ts#L122) and [`createWebPushReminderProvider`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/reminders/providers.ts#L194), queue schema [`027-reminder-outbox.sql`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/migrations/027-reminder-outbox.sql#L3).
- Chat client flows: [`RealAccountChatScreen`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/src/chat/RealAccountChatScreen.tsx#L50), [`RealtimeChatClient`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/src/chat/realtime-client.ts#L171), [`sendMessage`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/src/chat/realtime-client.ts#L208), [`subscribe` reconnect loop](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/src/chat/realtime-client.ts#L329), native/browser event source boundary [`createRuntimeEventSource`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/src/chat/native-event-source.ts#L229).
- Chat persistence and authorization: history/replay [`listChatEvents`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/chat/index.ts#L156), bounded history [`listChatHistoryPage`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/chat/index.ts#L206), atomic send [`createChatMessage`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/chat/index.ts#L282), reaction [`toggleChatReaction`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/chat/index.ts#L426), HTTP history/SSE/send/reaction routes [`server/src/http.ts`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/http.ts#L1626) ([SSE](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/http.ts#L1667); [send](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/http.ts#L1811); [reaction](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/http.ts#L1868)), realtime transport [`server/src/realtime/index.ts`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/realtime/index.ts#L42).
- Shared design contracts: [group/member domain boundaries](../../../../../docs/domain/contracts.md), [Demo session scope](../../../../../docs/domain/session-contract.md), [SQLite chat persistence inventory](../../../../../docs/architecture/hosted-demo-persistence.md).

The diagrams show implemented local behavior at this code cut. They do not claim managed identity/database adoption, provider production configuration, actual handset notification presentation or accepted hosted two-member acceptance.
