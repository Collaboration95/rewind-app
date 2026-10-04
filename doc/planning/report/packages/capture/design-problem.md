# Design problem — contain capture, transfer and processing variation

## Problem statement and evidence

Capture varies across browser/native platforms; real-group transfer varies between a configured direct upload intent and the authenticated staged-source route; post-upload transformation varies by the selected mode and media type. Without explicit boundaries, capture UI responsibilities can become coupled to concrete platform APIs, transfer protocol details, allowance rules and processing operations.

The “before” diagrams are **problem-pressure models**, not a historical claim that one monolithic class existed in the repository. The evidence cut is accepted dev commit [`fc2b8c811e9c13b176113fa0bdb2c015798990b4`](https://github.com/Collaboration95/rewind-app/commit/fc2b8c811e9c13b176113fa0bdb2c015798990b4); this snapshot already contains the after boundaries. No source history in this package establishes a refactor sequence.

## Before: variation concentrated at the capture workflow

### Problem class view

![Problem pressure class diagram](diagrams/problem-before-class.svg)

### Problem sequence view

![Problem pressure sequence](diagrams/problem-before-sequence.svg)

The diagrams show the coupling pressure when one workflow owns browser/native capture details, direct/staged transport protocol, quota decisions and FFmpeg mode execution. That is the design problem being evaluated, not a claim about the code at the pinned SHA.

## Candidate patterns

| Candidate       | Fit to the observed problem                                                                                                                                                                                                             | Decision                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Adapter         | Fits concrete platform capture behind `CameraPlatform`, transfer APIs behind the real-account runtime, and storage implementations behind `MediaStore`. Those boundaries already exist in source.                                       | Use to describe actual platform/storage/transport seams.                                                    |
| Strategy        | Fits a selectable algorithm only where implementations are interchangeable. Current FFmpeg mode choice selects a filter branch inside one processor; direct versus staged transfer is configuration routing inside one runtime adapter. | Mention as a useful conceptual lens, but do not claim separate Strategy classes or force a new abstraction. |
| Template Method | Requires a shared base algorithm with overridable steps. The accepted capture and server code has no such superclass lifecycle; async functions and explicit sessions coordinate the work.                                              | Reject as an implementation claim; it would require invented hierarchy/refactor.                            |

## After: actual accepted design

### Implemented class view

![Implemented class diagram](diagrams/problem-after-class.svg)

### Implemented sequence view

![Implemented transfer and processing sequence](diagrams/problem-after-sequence.svg)

The after view names the implemented seams: `CameraPlatform` adapters, `ClipUploadSession` and `createRealAccountVideoRuntimeClient`, the direct-transfer workflow and server upload-intent service, the staged intake fallback, contribution quota/ledger operations, private `MediaStore`, and FFmpeg processing. It distinguishes both configured transfer branches. Direct transfer obtains a capability through the authenticated application API, sends media bytes to that signed target without application credentials, pins a storage version, and completes through the application API. Staged mode sends the bytes to the authenticated intake service. The server remains responsible for authorization, idempotency, quota, job creation and processing in either branch.

## What this means for pre-upload retro

The current modes are post-upload FFmpeg choices (`soft-focus`, `high-contrast`). They do not implement the future requirement for four original treatments before the final upload. That work is explicitly deferred to [#365](https://github.com/Collaboration95/rewind-app/issues/365), [#366](https://github.com/Collaboration95/rewind-app/issues/366), and [#367](https://github.com/Collaboration95/rewind-app/issues/367). The future pipeline is not placed into the after diagram as if implemented. No future class hierarchy, ownership or completion date is inferred.

## Pinned implementation evidence

- [Capture abstraction](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/contracts.ts#L101) and [platform implementation](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/platform.ts#L340).
- [Runtime transfer-mode boundary](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/real-account-video-runtime.ts#L46) and [config-driven selection](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/groups/RealAccountGroupExperience.tsx#L360).
- [Direct transfer workflow](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/direct-transfer.ts#L337) and [upload-intent service](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/media/upload-intents.ts#L386).
- [MediaStore contract](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/media/store.ts#L45) and [FFmpeg processing](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/ffmpeg.ts#L206).

This comparison describes design decisions at one accepted source cut. It does not assert product-level upload/provider acceptance or recommend a refactor to manufacture named patterns.
