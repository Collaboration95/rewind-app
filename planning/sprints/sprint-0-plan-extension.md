# Sprint 0 extension: Sprint 1 working agreement

Status: agreed for Sprint 1 planning after the Sprint 0 review.

This plan records the smallest executable extension of the Sprint 0 walking
skeleton. It does not expand Sprint 0's product commitment or turn the local
demo into authentication, a cloud service, or a private-media product.

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
first Ready issue and the Day 1 gate. Before dependent Sprint 1 feature work
starts, its preflight must demonstrate:

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
| Local runtime, persistence, and policy | `Collaboration95` | #28, then #29/#30 |
| Identity, groups, and capture          | `KaenBin`         | #34, then #36/#38 |
| UI, accessibility, and demo quality    | `bibi45c`         | #40, then #41/#42 |

The first Ready issue is #28. The board should show it as Ready with Sprint 1
selected; later issues remain Product Backlog until the gate and dependencies
make them executable.

## Review checkpoint

At the next planning checkpoint, review the #28 preflight result, confirm the
fallback is still sufficient, and update the Project board before starting
dependent implementation. Any change to the local-only boundary or the five
item WIP limit is recorded as a new issue decision.
