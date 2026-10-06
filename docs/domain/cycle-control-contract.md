# Cycle timing contract

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
