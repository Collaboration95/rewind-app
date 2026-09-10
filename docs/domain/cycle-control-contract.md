# Local demo cycle control contract

Cycle timing is calculated by one framework-free engine in
`server/src/cycles/engine.ts`. Callers inject a `() => Date` clock when they
need deterministic policy or lifecycle tests. The supported presets are:

| Preset      | Duration |
| ----------- | -------- |
| `one-day`   | 24 hours |
| `four-week` | 28 days  |

`createCycleWindow` derives an ISO-8601 end instant from a start instant and a
preset. `advanceCycleWindow` shifts both boundaries by the same positive
number of seconds, preserving the configured duration. Shifting the stored
boundaries means the existing client countdown and server policy observe one
timeline; no UI-only clock is introduced.

The `POST /cycles/demo/advance` endpoint is a local demonstration control. It
requires a persisted `memberships.role = 'owner'` row for the requested group.
The authorization check happens before input validation and resource lookup, so
non-owners receive the same safe 403 body even for malformed or missing cycle
requests. Valid mutations are recorded in the local `cycle_control_events`
table with the old and new boundaries, actor, amount, and timestamp. This is a
control history, not a secure authentication or production time-travel claim.

The client exposes the control through `CycleControlRepository` and maps 403,
404, invalid request, and runtime failures to typed domain results. UI callers
can therefore render denial or recovery states without depending on HTTP
details.
