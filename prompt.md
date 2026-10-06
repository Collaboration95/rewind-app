# Parallel close-out run: eight Rewind issues

Work on #430, #413, #431, #469, #428, #429, #467 and #434. Deliver as many
fully verified outcomes as possible with small changes. Priorities are SPEED,
PARALLELISM and REAL VERIFICATION. This is explicit authorization to consider
all eight issues regardless of labels or older deferred/out-of-scope wording.

Use in-thread runtime subagents, not separate Codex chats. Implementation
subagents must use `model: gpt-6.1-Sol and `reasoning_effort: "medium"`.
Spawn independent lanes together and keep the lead doing integration and
non-overlapping work. Reuse/close completed agents to free concurrency slots.
Do not launch redundant explorers or copy the entire conversation into workers.

Do review only after PR open and use gpt 6 luna medium agent , instruct it to not nitpick and only flag actual issues. 

Read current AGENTS.md and skills/ship-issues/SKILL.md. Apply their verification,
review and tracking rules with these explicit batch instructions. Keep this
prompt untracked: never stage, commit or upload it. Use authenticated `gh`
exclusively for ALL GitHub access, including remote reads and writes. Local
Git operations such as branches, worktrees and cherry-picks are allowed.

## Behaviour to preserve

- Preserve current account/media deletion and report/block/remove semantics.
  Do not weaken acceptance or assertions.
- #434 may create disposable accounts/groups/media through existing CLI/API
  interfaces.

## Start and isolate

1. Inspect the dirty working tree and current open PRs; preserve all owner
   changes. Read each issue and its recent comments through `gh` and inspect
   relevant code from current dev. Existing implementations may already work.
2. Start from fresh dev, not the primary checkout's potentially stale HEAD.
   Follow the gh-only rule for remote access; a clean temporary clone using
   `gh repo clone Collaboration95/rewind-app <temporary-path> -- --branch dev`
   is one suitable approach. Confirm its HEAD against `gh api`'s dev SHA.
   Use local Git worktrees from that clone for independent lanes. Reuse a
   suitable task-owned clean checkout if one is already available.
3. Create a `guru/top-eight-closeout` integration branch and `guru/` lane
   branches from the same dev commit. Record the baseline SHA.
4. Keep a small untracked queue under .local-data, with per-issue states:
   claimed, verified, integrated, blocked, PR-ready or already delivered.
   Add `doing` only when starting an issue. An existing `doing` label is a
   reason to check for active ownership, not proof of a blocker. Coordinate
   any demonstrated active writer rather than duplicate their work.
5. Give every worker a fresh brief of at most ten lines: issue, outcome, own
   worktree, exclusive file scope and proving check. Workers
   read the issue and AGENTS.md themselves. No large planning files or frozen
   report/archive folders are needed.

## Parallel lanes

Launch up to six implementation workers initially, within runtime limits.
If fewer slots are available, prioritize A, D and E, then backfill completed
slots. Each worker edits only its own worktree and exclusive write scope.

| Lane | Issues | Exclusive ownership and task |
| --- | --- | --- |
| A: Legal entry | #430 | public/privacy.html, public/support.html, dedicated legal-link tests. Audit existing public pages, required disclosures, entry links and Settings links. Propose any App.tsx, shared Settings or route change to the lead instead of editing a shared file. Verify unauthenticated routes and actual link navigation. |
| B: iOS config | #431 | app.json and dedicated native-config checks. Verify existing camera/microphone purpose strings and encryption flag in generated configuration using existing tooling. Make only required config corrections. Do not create an unrelated EAS build or add tooling. Report actual generated-plist/build/upload verification separately. |
| C: Capture layout | #413 | src/capture/CameraCaptureScreen.tsx, src/capture/VideoCaptureScreen.tsx, camera-ui.tsx and dedicated layout tests. Verify current full-screen viewfinder, clear controls, failure recovery and portrait/landscape layouts. Keep layout fixes minimal; no media-validation changes. |
| D: WebKit audio | #469 | src/capture/platform.ts, tests/capture-platform.test.ts, tests/responsive/video-file-fallback.spec.ts. Reproduce the valid H.264/AAC fixture rejection. Distinguish inconclusive browser audio hints from proven absent audio. Retain MP4 audio-track validation, playback readiness and authoritative server verification. Check real review, play/pause, upload and sealing. |
| E: Safety close-out | #428, #429 | src/real/Settings.tsx, src/real/safety.ts, src/auth/RealAccountProvider.tsx and safety tests. One worker owns both issues to avoid overlapping safety changes. Audit and exercise existing deletion, report, block, unblock, contributor deletion and owner removal through real APIs. Check wrong-password/session revocation, ownership transfer, own-media cleanup and preservation of others' content. Check both UI playback and saved-film exposure where relevant. Preserve the existing retained-group-film behavior. |
| F: Safari keyboard | #467 | src/chat/RealAccountChatScreen.tsx, use-composer-keyboard.ts and dedicated keyboard checks. Reproduce right-edge clipping with the actual software keyboard in iPhone 17 Pro simulator Safari over trusted HTTPS. Keep composer/send controls inside the visual viewport with side clearance, preserve touch targets, send a message and verify restoration after Done. Also check 375×667. Desktop viewport emulation alone is insufficient proof of the native defect. |

The lead owns App.tsx, shared routing, integration, final verification and #434.
Capture layout and audio lanes must not edit one another's files. Safety and
legal lanes coordinate Settings requests through the lead. Any new shared
file ownership must be resolved before editing it.

For #434, inspect the existing release backend, account CLI and build config.
Prepare reviewer account/group/content using existing interfaces, verify that
released Archive content remains available on a normal-length cycle, and
prepare concise review instructions. Use disposable local accounts first.
Do not reset shared data, change hosted cycle configuration, apply infrastructure
or put credentials in Git, PR text, logs or queue reports. Before any AWS
operation read the rewind-aws-operations skill. Use available authorized
access; if account/signing access or TestFlight is missing, state precisely
what is verified and pending and continue the other lanes. Do not claim a
local account alone fulfills the stable-backend/TestFlight outcome. Any native
build config patch belongs to lane B or the lead, not both.

## Speed and verification discipline

- Audit merged behavior first. Do not reimplement working features or create
  empty commits simply to attach already-delivered issues to a new PR.
- Each worker runs the cheapest focused check that proves its change and a
  relevant real-app exercise. Preserve every assertion. Limit focused failed
  diagnosis to two attempts per issue, then report and move on.
- Follow ship-issues for per-lane fast checks after code changes. Run them in
  isolated worktrees and bound concurrency to available CPU/memory. Full web
  export/slow/a11y/coverage runs belong to the integrated branch; do not launch
  six identical full browser/coverage jobs.
- Isolate runtime ports, DB/data roots, build output and browser profiles.
  Use local real accounts and disk media unless the behavior needs hosted
  verification. Local HTTPS exercises secure cookies/WebKit; it does not
  prove actual installed-device behavior by itself.
- A single lane owns the iOS simulator at a time. Browser checks may run in
  parallel on isolated runtimes, but serialize expensive browser/FFmpeg jobs
  if contention makes results unreliable. Do not launch worker verification
  against another lane's files or build.
- Use existing runners, including `npm run test:focused -- frontend <file>`,
  `npm run test:focused -- server <file>` and the root equivalent. Inspect
  current scripts rather than assume commands from an old issue still exist.
- Workers report: issue outcomes, changed files, commit SHA, exact checks and
  results and pending verification. Commit only their
  scoped changes with the repository's conventional commit format.
- The lead gives concise progress updates at least once per minute during
  active work. Keep working while workers run; wait only when integration
  depends on their results. Do not ask the owner to perform checks an agent
  can perform with available tooling.

## Integrate, verify, review and raise the PR

Here “merge the issues” means integrate lane commits into the integration
branch. It does not mean merge unreviewed work into dev before opening a PR.

1. Inspect each patch and its evidence as it arrives. Cherry-pick/integrate
   verified independent lane commits, resolve ordinary conflicts and keep
   working lanes running.
2. Apply shared-file requests once under lead ownership. If dev advances,
   refresh it using gh, integrate the new baseline and retest affected paths.
3. On the final integrated branch run format:check, lint, architecture:check,
   typecheck and test:fast. For this UI/web batch run the required test:slow,
   test:a11y and frontend/server coverage commands under AGENTS.md. Diagnose
   failures with the bounded rule; never hide an existing failure or report
   a timed-out/skipped check as passing.
4. Recheck every included issue against the integrated build, not only worker
   builds: legal navigation, generated native config, both capture layouts,
   valid/silent video import, account deletion, report/block/remove, actual
   Safari keyboard and reviewer-account readiness. Checks can be parallel
   where resources are isolated. Record each outcome independently.
5. Run one review-agent pass over the integrated change. Routine portions may
   use Luna high. If auth, private media, deletion/moderation backend, migrations,
   deployment or infrastructure are touched, use GPT-6.1 Sol or Claude for the
   required sensitive review. Luna high remains the implementation model.
   Fix blocking findings and rerun checks affected by those fixes.
6. Prefer one focused PR for the bounded close-out batch. If an issue grows
   into a separate media/backend/deployment redesign, exclude that patch and
   report it as remaining work rather than expanding the batch. Preserve its
   useful bounded diagnosis. Separate PRs are appropriate only for necessary
   scope separation, not as a substitute for integrating compatible lanes.
7. Publish using gh and raise a PR targeting dev. Use `Refs #<issue>` without
   closing keywords for genuinely included outcomes. Write a concise title
   and description covering the final changes, actual checks and precise
   pending outcomes. When using gh, write a multiline body to a temporary
   file and pass --body-file. Attach every created PR to this Codex chat.
8. Check aggregate Quality on the exact PR head and resolved conversations;
   fix new failures within scope. This request ends with a reviewed,
   verified PR ready for merge. Leave the dev merge to the owner; do not
   close an issue based on an unmerged new patch. For already-merged work,
   only close when all current Definition-of-Done conditions can be
   established, with the required one-line link to its delivering PR.
9. Remove `doing` for stopped/blocked issues, leave no false completion
   claims, and clean up only processes/data/worktrees created by this run
   after preserving submitted changes. Do not remove the owner's files.

Finish with a compact table for all eight issues: verified outcome, PR or
existing merged PR, status, and the exact remaining blocker if any. Include
PR links and final check/review results.
Never present an account setup, mocked check or code-only inspection as real
device/provider acceptance.
