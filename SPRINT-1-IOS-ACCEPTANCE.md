# Sprint 1 iOS acceptance check

This report was created under the previous Project label, Sprint 2. GitHub
Project #8 relabelled that work as Sprint 1 on 26 September 2026; the issue
title and recorded findings retain their original wording.

- Date: 2026-09-25
- Repository: `Collaboration95/rewind-app`
- Commit checked: `525d3e539151b2f854a59d73c82b33e02f67d1cd` (`main`)
- Device: iPhone 15 Pro Simulator, iOS 17.5, Expo Go 57.0.9
- Runtime: isolated local SQLite/FFmpeg service at `127.0.0.1:8787`; synthetic camera mode enabled. No AWS resources or real media were used.

## Findings

### P1 — iOS Chat realtime never connects (#153)

On the Chat tab, the simulator displayed `Chat connection: Reconnecting…` and this error: `This platform does not provide EventSource. Supply an eventSourceFactory for LAN realtime support.` Tapping `Retry chat connection` left the same state. This prevents native iOS from receiving the realtime events needed for off-tab unread counts and reconnect behavior.

Evidence points to the default runtime constructing `RealtimeChatClient` without a native EventSource implementation; `src/chat/realtime-client.ts:122-133` throws when `globalThis.EventSource` is absent. This is a reproducible native acceptance failure, despite passing browser and automated checks.

### P1 — Local reveal control throws before it can report cycle state

With the local runtime connected and Amber as group owner, Settings → **Start local reveal** displayed `Cannot read property 'request' of undefined`. The call first advances the cycle, then fails when it calls the detached `revealDemoCycle` method. In `App.tsx:740`, the method is copied from the client and then invoked at `App.tsx:759`; `LocalRuntimeClient` methods call `this.request(...)`. Preserve the receiver or call the method directly, and add a regression test using a class-backed runtime client.

The documented local mobile capture-to-reveal flow cannot complete through this button until this is fixed. The isolated-runtime full-cycle backend scenario passes separately, so this failure is in the app integration path.

### P2 — Seeded contribution disagrees with visible allowance totals (#158)

On Home, the ledger showed `Submission 1`, `demo-contribution`, sealed, 3 seconds, with the row stating it uses one contribution and 3 seconds. Before a new capture, the totals showed 0/5 and 0/30 seconds. After creating a synthetic 2-second contribution, the totals showed 1/5 and 2/30 seconds while the ledger showed both the 3-second and 2-second entries. The isolated database confirms both records are attached to the current cycle.

This makes the contribution history and allowance summary disagree in the local Demo. Align the seeded fixture accounting with its contribution row, or change the displayed row/impact if it is intentionally excluded.

### P2 — Fresh Demo fixture reports missing ready outputs (#171)

On the newly initialized isolated runtime, read-only `consistency --json` reported two non-repairable `missing_output` findings: `demo-clip` and `demo-film`. Both seeded jobs have status `ready` but no `output_path`; neither file exists. A new unmodified local runtime therefore starts with consistency findings. Decide whether these placeholders should be excluded from the audit or seeded with valid outputs.

## Checks that passed

- `npm run check` on this exact `main`: formatting, lint, architecture, typecheck, 31 root tests, 193 server tests, 347 Jest tests, and 6 accessibility browser tests.
- `npm run test:responsive`: 19/19 tests.
- `npm run test:full-cycle`: 1/1 (`reset → join → sealed clip → reveal → authorized archive`).
- `npm run server:preflight` on the isolated local runtime: service, SQLite fixture, LAN address, and FFmpeg gates passed.
- `retention --json` defaulted to dry-run and returned no candidates; no files were deleted.
- The simulator connected to the local runtime. Home displayed the cycle prompt and locked state; synthetic clip creation completed and reported `Contribution sealed`; Archive showed prompt/date/state metadata and stated that locked media had no playback or media links.

## Acceptance limits

- The simulator has no physical camera. The app correctly identified the synthetic fixture preview and said recording was unsupported there. Physical capture and device-camera evidence remain unverified.
- Hosted HTTPS acceptance, two clean hosted runs, rollback/recovery proof, and a genuine non-author run remain blocked by existing issue #145: the Lightsail instance/static IP/distribution were deleted, Terraform state is unreconciled, and there is no verified recovery point. No AWS operation was performed.
- The Archive UI was checked before release. The app-level reveal error prevented validating released-cycle playback in the simulator; the separate full-cycle backend scenario passed.
