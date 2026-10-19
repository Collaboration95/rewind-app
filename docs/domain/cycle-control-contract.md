# Cycle timing and lifecycle contract

Source revision: `40ebeb5673d103b4b6950d095192aae744980769` (15 October 2026).
The framework-free [timing engine](../../server/src/cycles/engine.ts) accepts an
injected `() => Date` clock for deterministic policy and lifecycle checks.

| Engine preset | Duration |
| ------------- | -------- |
| `one-day`     | 24 hours |
| `four-week`   | 28 days  |

`createCycleWindow` derives an ISO-8601 end instant from a start and preset.
`advanceCycleWindow` subtracts the same positive whole number of seconds from
both boundaries, preserving duration: wall time observes an older cycle. It
does not change the system clock. Persisted control events record the actor,
previous/next boundaries and advance. Engine presets describe timing helpers;
[real-group creation](../../server/src/groups/real.ts) defaults to 28 days and
accepts a configured positive duration for short local runs. The metadata
`cycle_duration_ms` remains constrained to the product default; stored cycle
boundaries are authoritative and successors repeat their actual duration.

The engine reports `upcoming`, `collecting` or `ended` for a collecting row
according to the injected clock. Revealing/archived rows retain their stored
phase. A countdown reaching zero does not itself publish media.

[Lifecycle transactions](../../server/src/cycles/lifecycle.ts) persist these
steps:

1. At/after `ends_at`, change collecting to revealing, retain the lock, ensure
   one film job for the cycle, create its collecting successor and advance the
   group pointer. The successor starts at the old cycle's end. Collection can
   therefore continue while the old film is being prepared.
2. Publish only after the film output is ready and its exact bytes/reference
   are verified, at/after the collection end. Store independent
   `release_status=published` and `release_published_at`; revealing alone does
   not grant release access.
3. Keep the premiere for 24 hours from publication, then archive after another
   output verification. Both revealing and archived rows remain stored as
   `lock_state=locked`; access policy also evaluates publication and lifecycle.

A partial unique predecessor index permits one successor per cycle. Unique
`(cycle_id,transition)` receipts make lifecycle event replay idempotent. The
pointer update is conditional on the old current ID so replay of an older
cycle cannot rewind the group. These are application transactions plus schema
constraints; `groups.current_cycle_id` itself has no SQL FK.

Allowance is per member and seven-day window anchored at `starts_at`, rather
than per whole cycle or calendar week. Open/pinned upload intents reserve
allowance alongside accepted usage. Acceptance rechecks the current cycle and
window, so an expired hold or rollover cannot authorize a late contribution.
See [database design](database-design.md) for keys, quotas, deletion and release
metadata, and [glossary](glossary.md) for product terms.
