# Sprint 0 extension: runtime foundation and Sprint 1 handoff

Status: Sprint 0 runtime-foundation scope recorded for team planning.

This plan records the smallest executable extension of the Sprint 0 walking
skeleton. Sprint 0 now includes the local runtime foundation (#28–#32) so the
next sprint can build a real local product flow on a verified boundary. It does
not turn the local demo into authentication, a cloud service, or a
private-media product.

## Sprint 0 runtime foundation

The five moved issues stay dependency-ordered and are the only new Sprint 0
implementation scope:

| Issue                                                          | Outcome                                            | Dependency/status |
| -------------------------------------------------------------- | -------------------------------------------------- | ----------------- |
| [#28](https://github.com/Collaboration95/rewind-app/issues/28) | Validate LAN runtime, SQLite, and FFmpeg           | Ready; first gate |
| [#29](https://github.com/Collaboration95/rewind-app/issues/29) | Bootstrap typed local service and health endpoint  | After #28         |
| [#30](https://github.com/Collaboration95/rewind-app/issues/30) | Add SQLite schema, migrations, fixtures, and reset | After #29         |
| [#31](https://github.com/Collaboration95/rewind-app/issues/31) | Add typed app API boundary and connection states   | After #29         |
| [#32](https://github.com/Collaboration95/rewind-app/issues/32) | Centralise group and media membership policy       | After #30         |

Issue #28 is the first Ready item; #29–#32 remain Product Backlog until their
dependencies are complete. Sprint 1 begins with identity, capture, chat, and
reveal work on top of this boundary.

## Boundary and working agreement

- Keep the product local-first. The Expo client may use a local companion
  runtime, SQLite, and FFmpeg, but no cloud deployment or real credentials are
  required for Sprint 1 development.
- Keep mock access explicit. Synthetic members, groups, and media fixtures are
  labelled as local demo data and are never described as secure accounts,
  authenticated users, or private storage.
- Limit Sprint 1 work in progress to five active issues. New work stays in
  Product Backlog until a slot is available and its dependencies are ready.
- Preserve the existing single-device Expo flow as the supported fallback. If
  the companion runtime or LAN path is not reliable, the team continues with
  deterministic local fixtures and records the limitation instead of claiming
  multi-device behaviour.

## Day 1 runtime gate

Issue [#28](https://github.com/Collaboration95/rewind-app/issues/28) is the
first Ready issue and the Day 1 gate for the moved Sprint 0 foundation. Before
dependent work starts, its preflight must demonstrate:

1. the documented Node/npm baseline can start the local companion service;
2. the service binds to the advertised LAN address and a second local client
   can reach its health endpoint;
3. SQLite can create, read, and reset one synthetic record; and
4. FFmpeg can transform a generated synthetic MP4 while a deliberate failure
   produces an actionable error.

If any gate remains unreliable at the Day 1 checkpoint, activate the
single-device fixture fallback: run the Expo app locally, keep data synthetic,
and do not add a feature that depends on an unverified LAN, SQLite, or FFmpeg
capability. Revisit the gate before moving the dependent issue into active
work.

## Ownership and ready queue

Current GitHub contributors own the first slice by area:

| Area                                   | Owner             | Initial queue     |
| -------------------------------------- | ----------------- | ----------------- |
| Local runtime, persistence, and policy | `Collaboration95` | #28, then #29–#32 |
| Identity, groups, and capture          | `KaenBin`         | #34, then #36/#38 |
| UI, accessibility, and demo quality    | `bibi45c`         | #40, then #41/#42 |

The first Ready issue is #28. The board should show #28–#32 in Sprint 0, with
#28 Ready and #29–#32 in Product Backlog until the gate and dependencies make
them executable. The remaining Sprint 1 issues stay in Sprint 1.

## Review checkpoint

At the next planning checkpoint, review the #28 preflight result, move the
dependent foundation issue into Ready only when its predecessor is complete,
confirm the fallback is still sufficient, and update the Project board before
starting Sprint 1 implementation. Any change to the local-only boundary or
the five-item WIP limit is recorded as a new issue decision.
