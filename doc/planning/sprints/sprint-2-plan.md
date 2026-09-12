# Rewind Sprint 2 plan — hosted capture-to-reveal demo

- **Status:** Proposed for Sprint Planning
- **Prepared:** 12 September 2026 (Asia/Singapore)
- **Sprint length:** 2 weeks / 10 working days
- **Nominal dates:** 27 September–10 October 2026; confirm against the team's
  actual calendar
- **Team assumption:** 5 members
- **Primary outcome:** A non-author can run the defining Rewind journey from a
  public HTTPS URL without a developer terminal
- **UI boundary:** Functional placeholder controls only; final UI planning and
  visual polish happen after the demo path is accepted

## 1. Evidence baseline

This plan uses fresh GitHub, repository, and local verification evidence rather
than treating issue closure alone as completion.

| Measure                                    |                                     Sprint 1 evidence | Planning interpretation                                                |
| ------------------------------------------ | ----------------------------------------------------: | ---------------------------------------------------------------------- |
| Direct Sprint 1 pull requests closed       |                                                     3 | All three merged: #79, #80, and #91.                                   |
| Canonical Sprint 1 milestone issues closed |                                                    13 | #33–#43, #53, and #69.                                                 |
| Additional Sprint 1 review defects closed  |                                                     9 | #81–#89; these were not milestone issues.                              |
| Report-compatible closed deliverables      |                                                    22 | Useful for continuity, but nine were defects discovered during review. |
| User stories among the 22 closures         |                                                     4 | #35, #36, #38, and #41.                                                |
| Project priority distribution              |                               11 P0, 5 P1, 5 P2, 1 P3 | High-priority work dominated the increment.                            |
| Project risk distribution                  |                             10 High, 10 Medium, 2 Low | The completed scope was technically substantial.                       |
| Current `origin/main` verification         | 134 tests pass; web export and runtime preflight pass | Main is a sound local foundation.                                      |

The completed effort was not small. It added the Node/SQLite/FFmpeg local
runtime boundary, Demo sessions, groups and invitations, capture/review
contracts, pending clip submission, deterministic cycle controls, central
authorisation, and nine review-driven fixes. The merged direct Sprint 1 change
covered 97 files and roughly +9,043/-181 lines, including about 2,200 lines of
test churn. These line counts show breadth, not business value.

### Evidence caveats to fix before Sprint 2 implementation

- Sprint 1 was planned for 13–26 September, but its three PRs merged on 10–11
  September. The count is therefore a milestone-labelled baseline, not a
  trustworthy issues-per-calendar-day velocity.
- Only issues #33 and #34 are marked `Done` on Project #8. Closed issue #82 is
  still `Ready`, and the other 19 closed Sprint 1 items remain `Product Backlog`.
- All 22 closed issues still have unchecked acceptance checklists. PR-level
  evidence exists, but the issue records are stale.
- Physical-device recording required by #41/#89 is not proven. Simulator
  fixtures prove state handling, not real camera and microphone capture.
- PR #92 is open and currently fails its quality workflow. Locally, formatting
  fails in six imported planning files; isolated checks also expose one
  date-sensitive server test and five video-screen test failures. Sprint 2 work
  must not stack on an ungreen integration branch.

## 2. Sprint goal

> By the Sprint Review, a reviewer opens Rewind from a public HTTPS URL,
> enters clearly labelled synthetic Demo access, creates or joins a group,
> submits a synthetic demo clip, sees it processed and sealed, advances the
> one-day demo cycle, and plays the released group film from Archive. The
> backend runs on AWS, the journey survives a backend restart, and a non-author
> can reset and repeat it from a written runbook.

### Success in one sentence

“Open URL → join group → add moment → see sealed → advance cycle → watch film.”

### Demo acceptance script

1. Open the hosted web application on a clean browser.
2. Enter synthetic Demo access as the owner.
3. Create a group and prompt, generate an invite, and accept it in a second
   browser/incognito session as another synthetic member.
4. Choose **Use synthetic demo clip**. A real bounded MP4 upload and real camera
   recording are stretch acceptance paths.
5. Review and submit the clip. The AWS backend resolves a server-owned fixture,
   applies quota policy, processes it with FFmpeg, deletes the temporary
   successful source, and exposes only sealed metadata before release.
6. Use a clearly labelled owner-only Demo control to advance the cycle.
7. The backend creates exactly one compilation job, orders eligible clips,
   generates a playable MP4, and publishes it atomically.
8. Open Archive and play the film.
9. Sign in as a non-member and prove that group, processed-media, and film
   access are denied without revealing whether the resource exists.
10. Reset the hosted Demo data and repeat the script without source edits or a
    developer terminal.

## 3. What “more than 2x velocity” means

Raw closure count is not the primary target because the 22-item baseline
contains nine review defects and three large/overlapping PRs. Sprint 2 uses four
measures together:

| Measure                               |       Baseline | Sprint 2 minimum |                             Sprint 2 target |
| ------------------------------------- | -------------: | ---------------: | ------------------------------------------: |
| Accepted vertical user outcomes       |      4 stories |                8 |                                          10 |
| Merged green PRs                      |              3 |                7 |                                       10–12 |
| Hosted demo checkpoints               |              0 |                2 | 3: thin slice, full path, release candidate |
| Closed, accepted issue-sized outcomes | 22 mixed items |               30 |  36; more than 44 only as a natural stretch |

The team will not create trivial tickets to manufacture 45 closures. A closure
counts toward the target only when it has an observable outcome, acceptance
evidence, a merged PR where code changed, and honest Project status.

### Flow targets

- Main stays releasable after every merge.
- Median PR lifetime is less than one working day.
- No implementation PR carries more than three issue outcomes.
- Target fewer than 500 changed hand-written lines per PR. Split by boundary or
  user-visible state when a change grows beyond that.
- One active issue per delivery lane and at most five implementation issues in
  progress across the team.
- Every workday ends with a merged increment or a written blocker/decision on
  the relevant issue.
- No open P0 defect may remain on the demonstrated path at Sprint Review.

## 4. Scope and prioritisation

### P0 — committed demo path

P0 is the Sprint commitment. If any P0 outcome is threatened, P1 and P2 stop.

#### Release gate and decisions

| Key                   | Outcome                                     | Estimate | Acceptance                                                                                                                                            |
| --------------------- | ------------------------------------------- | -------: | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s2-release-001`      | Restore PR #92 to green                     |      3 h | Formatting, date-independent cycle tests, video-screen tests, and full `npm run check` pass.                                                          |
| `s2-release-002`      | Resolve #90 and merge or supersede PR #92   |      2 h | Review index has an authoritative disposition; merged code is on current `main`; no duplicate open integration PR remains.                            |
| `s2-release-003`      | Reconcile Sprint 1 issue and Project status |      2 h | The 22 closed items have honest status and verification references; #41/#89 retain their physical-device proof caveat.                                |
| `s2-architecture-001` | Record the hosted Demo appliance decision   |      2 h | The issue decision fixes AWS region, host, storage, HTTPS, CORS, synthetic-media boundary, backup, and rollback without claiming production security. |

#### AWS backend and hosted frontend

| Key            | Outcome                                                 | Estimate | Acceptance                                                                                                                                         |
| -------------- | ------------------------------------------------------- | -------: | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s2-cloud-001` | Build a production-shaped runtime container             |      4 h | A pinned Node 22 image contains FFmpeg, runs as non-root, exposes health, and passes the existing preflight.                                       |
| `s2-cloud-002` | Persist SQLite and processed Demo media                 |      3 h | Database and media directories live on persistent instance storage and survive container/process restart.                                          |
| `s2-cloud-003` | Provision one AWS Lightsail instance                    |      4 h | A reproducible script or Terraform module creates the instance, static IP, least-open firewall, tags, and cost guard.                              |
| `s2-cloud-004` | Add the generated AWS HTTPS distribution                |      4 h | A Lightsail distribution serves the instance through its default `cloudfront.net` HTTPS address; API caching is disabled and SSH is IP-restricted. |
| `s2-cloud-005` | Deploy the Expo web export                              |      3 h | `npm run build:web` deploys `dist` behind the same HTTPS distribution; SPA fallback works and `/api` reaches the runtime.                          |
| `s2-cloud-006` | Automate backend deploy and rollback                    |      5 h | A green `main` artifact can deploy without editing the server; the previous image/config can be restored.                                          |
| `s2-cloud-007` | Add hosted migrate, seed, reset, and readiness commands |      3 h | An operator can initialise/reset only Demo data and readiness fails until migrations complete.                                                     |
| `s2-cloud-008` | Add hosted health, safe logs, and budget alert          |      3 h | Health/version is visible; logs contain no media paths/codes/secrets; the AWS account has a small monthly alert.                                   |

#### Hosted synthetic-media ingestion and sealed contribution

| Key            | Existing issue | Outcome                                              | Estimate | Acceptance                                                                                                             |
| -------------- | -------------- | ---------------------------------------------------- | -------: | ---------------------------------------------------------------------------------------------------------------------- |
| `s2-media-001` | New            | Add guaranteed synthetic clip ingestion              |      3 h | Hosted UI can select a labelled server-owned fixture; the path uses the same quota/process workflow as uploaded media. |
| `s2-media-002` | #44            | Enforce persistent weekly quota and idempotency      |      5 h | Sixth clip, over-30-second total, and over-15-second clip fail; replayed submit consumes no extra allowance.           |
| `s2-media-003` | #45            | Process trim/mode metadata with FFmpeg               |      6 h | Each supported mode yields a playable processed MP4 with bounded trim.                                                 |
| `s2-media-004` | Split from #45 | Delete successful temporary input safely             |      3 h | Success retains processed output only; failure is recoverable and does not expose a filesystem path.                   |
| `s2-media-005` | #46            | Render queued, processing, sealed, and failed states |      4 h | Placeholder UI shows truthful states and has no pre-reveal player, thumbnail, URI, share, or download control.         |
| `s2-media-006` | New            | Require valid Demo sessions in hosted mode           |      4 h | Hosted protected routes cannot fall back to a caller-supplied `memberId`; cross-group denials stay uniform.            |

#### Cycle, film, reveal, and archive

| Key              | Existing issue       | Outcome                                               | Estimate | Acceptance                                                                                                    |
| ---------------- | -------------------- | ----------------------------------------------------- | -------: | ------------------------------------------------------------------------------------------------------------- |
| `s2-cycle-001`   | #54                  | Make cycle transition idempotent                      |      5 h | Boundary transition happens once and cannot start the next cycle before a successful release.                 |
| `s2-cycle-002`   | New                  | Expose an owner-only placeholder Demo advance control |      2 h | The existing session-protected API is reachable in-app, labelled Demo-only, and hidden/denied for non-owners. |
| `s2-film-001`    | #55                  | Persist one compilation job                           |      5 h | Exactly one restart-safe job is created from accepted, processed, non-deleted contributions.                  |
| `s2-film-002`    | Split from #55       | Claim and resume compilation idempotently             |      4 h | Restart cannot duplicate a job or published film.                                                             |
| `s2-film-003`    | Split from #57       | Concatenate clips chronologically                     |      5 h | Synthetic clips appear in accepted timestamp order in a playable output.                                      |
| `s2-film-004`    | Split from #57       | Normalise audio and publish atomically                |      5 h | Output has usable normalised audio; invalid input cannot expose a partial film.                               |
| `s2-film-005`    | Minimum slice of #61 | Show truthful failed/delayed state                    |      3 h | One intentional retry is safe and no playback/download appears before publish.                                |
| `s2-archive-001` | #63                  | Serve and play an authorised premiere                 |      5 h | Member plays the released film; non-member and pre-release requests receive safe denial.                      |
| `s2-archive-002` | Split from #65       | List released films in Archive                        |      3 h | Correct-group released film appears; empty state is explicit.                                                 |

#### End-to-end proof

| Key              | Existing issue | Outcome                                             | Estimate | Acceptance                                                                               |
| ---------------- | -------------- | --------------------------------------------------- | -------: | ---------------------------------------------------------------------------------------- |
| `s2-quality-001` | Split from #67 | Automate the local reset-to-reveal path             |      5 h | One command proves sealed-before and playable-after using deterministic media.           |
| `s2-quality-002` | Split from #67 | Automate the hosted happy-path smoke test           |      4 h | Production URL passes Demo entry, ingest, advance, release, and authorised playback.     |
| `s2-quality-003` | Builds on #69  | Run hosted cross-group negative tests               |      3 h | Group, media, film, and download endpoints reveal no cross-group data.                   |
| `s2-quality-004` | #71 minimum    | Prove restart and media failure recovery            |      4 h | Restart preserves accepted work; failed processing/compile cannot publish partial media. |
| `s2-quality-005` | #75            | Publish reset, demo, fallback, and rollback runbook |      4 h | A non-author completes two runs without source edits or unstated machine state.          |

### P1 — pull only after the hosted film plays by Day 8

P1 expands usefulness but must not delay the defining demo.

| Order | Existing issue | Outcome                                                                                                    |
| ----: | -------------- | ---------------------------------------------------------------------------------------------------------- |
|     1 | #48            | Authorised real-time text transport.                                                                       |
|     2 | #49            | Persistent timeline and minimal composer.                                                                  |
|     3 | #51            | Reconnect, failed-send retry, and access-denial handling.                                                  |
|     4 | #47            | One safe delete-and-recapture allowance.                                                                   |
|     5 | #61            | Full bounded compilation retry policy beyond the P0 truthful delayed state.                                |
|     6 | #59            | Labelled archive-filler policy.                                                                            |
|     7 | New            | Add an S3 media-store adapter and lifecycle policy while retaining the instance-disk adapter for rollback. |
|     8 | New            | Upload actual bounded MP4 bytes to a server-owned temporary file; never trust a client-local URI.          |
|     9 | #65            | Download the authorised group film with request-time membership checks.                                    |
|    10 | #73            | Validate one physical mobile capture/playback path separately from fixture evidence.                       |

### P2 — explicitly deferred unless P0 and P1 are green

- #50 chat replies and reactions.
- #52 reminders and local notification preferences.
- Cognito/OIDC and claims of real authentication.
- PostgreSQL/RDS, SQS, a separately scaled worker, autoscaling, multi-region,
  and production high availability.
- Real private/personal media. The hosted Sprint 2 service accepts only
  synthetic or explicitly approved non-sensitive demonstration clips.
- Advanced archive browsing, own-clip downloads, sharing, live filters, gallery
  import, account management, and public links.
- Final visual system, motion, iconography, illustration, brand polish, and
  production content design.

## 5. Hosting decision

### Recommended two-week deployment

```text
AWS Lightsail distribution
  generated cloudfront.net HTTPS endpoint
        |
        | static Expo files + uncached /api requests
        v
AWS Lightsail, single 2 GB Linux instance
  Caddy/Nginx origin boundary
  Node 22 modular-monolith API
  SQLite on persistent instance storage
  FFmpeg worker in the same deployment
  temporary + processed synthetic media on persistent instance storage
```

This is a **Demo appliance**, not the final cloud architecture. It intentionally
preserves the existing Node/SQLite/FFmpeg implementation and avoids spending the
sprint rewriting persistence for Cognito, RDS, SQS, and a separate worker before
the product's defining loop exists.

The AWS-only default is to serve the static web build and API through one
Lightsail distribution. AWS supplies a generated `cloudfront.net` HTTPS domain,
and Lightsail distributions can forward `POST`, `PUT`, `PATCH`, `DELETE`,
`OPTIONS`, and authorisation/origin headers when configured. Static files may
be cached; `/api/*` must have caching disabled and forward the session inputs.
This removes the custom-domain and cross-origin dependency from P0.

Vercel remains feasible because Expo documents a static web export to `dist`
and a Vercel SPA rewrite configuration. It is now optional rather than a Sprint
dependency. The frontend cannot by itself solve media capture: the current web
camera adapter disables video recording, and the current upload endpoint sends
JSON metadata rather than media bytes. That is why P0 guarantees a server-owned
synthetic clip path. A real byte-ingestion endpoint is pulled only after the
hosted reveal path is green.

### Cost and fallback

- Start with the current Lightsail 2 GB Linux bundle, listed at USD 12/month
  with a public IPv4 address. Add the smallest Lightsail distribution, currently
  listed at USD 2.50/month, for a generated HTTPS address. Expected fixed Demo
  hosting is therefore about USD 14.50/month before tax or eligible AWS credits.
- The 1 GB instance bundle is cheaper but leaves little headroom for Node plus
  FFmpeg; move to 4 GB only if measured compilation requires it.
- No purchased domain is required. If the team later wants a branded address,
  add one without changing the application architecture.
- Vercel Hobby remains an optional zero-additional-cost frontend when the
  course use satisfies its personal/non-commercial policy. AWS Amplify Hosting
  is the AWS-only alternative and provides a generated `amplifyapp.com` HTTPS
  domain; its free-tier eligibility depends on the account.
- Set a small AWS budget alert before media testing. Delete unused instances,
  snapshots, static IPs, and object storage after the course according to an
  explicit teardown checklist.

Current platform references:

- [Expo: publish websites](https://docs.expo.dev/guides/publishing-websites/)
- [AWS Lightsail pricing](https://aws.amazon.com/lightsail/pricing/)
- [AWS Lightsail distribution request handling](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-distribution-request-and-response.html)
- [AWS Lightsail firewall guidance](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-firewall-and-port-mappings-in-amazon-lightsail.html)
- [AWS Lightsail networking and static IPs](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-networking.html)
- [AWS Amplify default domains](https://docs.aws.amazon.com/amplify/latest/userguide/custom-domains.html)
- [Vercel pricing](https://vercel.com/pricing)

### Transition after the demo

The ports/adapters boundary should keep the following path open without making
it Sprint 2 scope:

```text
Demo appliance                Production transition
SQLite                     -> PostgreSQL/RDS
instance media disk         -> private S3 temporary/processed buckets
in-process job runner       -> SQS + independently deployed worker
synthetic Demo session      -> Cognito/OIDC
single host                 -> managed container API + worker
manual/demo reset           -> versioned migrations and controlled operations
```

## 6. Capacity, ownership, and working model

The P0 estimates total approximately 120 team-hours. This is deliberately above
the course plan's roughly 100-hour average because the requested sprint is an
acceleration sprint, but it is only credible if all five members confirm about
24 hours each across the two weeks. Hold another 10 hours as contingency rather
than pre-loading P1. More than 2x flow should still come from smaller batches
and parallel critical paths, not from assuming unlimited working time. If the
team confirms only 100 hours, remove `s2-cloud-006`, `s2-cloud-008`, and the P0
retry polish from the commitment while keeping manual deployment, safe logs,
and a truthful failure state.

| Lane                    | Primary responsibility                                   | Initial focus                    | Pair/reviewer |
| ----------------------- | -------------------------------------------------------- | -------------------------------- | ------------- |
| A — release/cloud       | PR #92 gate, AWS host/distribution, CI/CD                | `s2-release-*`, `s2-cloud-*`     | E             |
| B — contribution        | fixture ingestion, quota, processing, sealed state       | `s2-media-*`                     | A             |
| C — film worker         | lifecycle, job, compile, atomic publish                  | `s2-cycle-*`, `s2-film-*`        | B             |
| D — archive/integration | premiere, archive, hosted flow                           | `s2-archive-*`, `s2-quality-002` | C             |
| E — quality/demo        | negative tests, device proof, runbook, release rehearsal | `s2-quality-*`                   | D             |

The names A–E are placeholders until the team records actual ownership. Each
issue must name one driver and one reviewer before entering `Ready`.

### Dependency strategy

- Lane A unblocks the first hosted health check.
- Lane B can develop against the local runtime before AWS is ready.
- Lane C can compile deterministic generated clips before client ingestion is
  complete.
- Lane D can implement playback against a known generated film fixture.
- Lane E writes the happy-path harness from Day 1 and replaces stubs as each
  stage becomes real.
- Integration happens daily through `main`; no end-of-sprint merge branch.

## 7. Ten-day execution plan

| Day | Parallel work                                                                                                                  | Required exit criterion                                                                                             |
| --: | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
|   1 | Green/resolve PR #92; reconcile Sprint 1; freeze demo script and hosted-Demo decision; confirm AWS account, region, and budget | `main` is green; no unresolved baseline branch; every P0 issue has driver/reviewer/dependency.                      |
|   2 | Container, persistent directories, Lightsail provision; synthetic-media contract; compilation fixture harness                  | Runtime container passes preflight locally; AWS host answers HTTPS health or a named blocker is escalated.          |
|   3 | AWS distribution deploy, hosted session gate, migrate/seed/reset, and server fixture path                                      | Public web shell reaches the AWS health endpoint and a hosted Demo session is accepted. **Hosted checkpoint 1.**    |
|   4 | Quota/idempotency, FFmpeg happy path, lifecycle transition/job schema, placeholder processing states                           | Hosted fixture produces one processed sealed clip; temporary-success source is removed.                             |
|   5 | Processing failures, persistent job claim, chronological concat, owner Demo advance                                            | Owner completes create/join/submit/seal/advance on the hosted system. Mid-sprint review cuts any noncritical scope. |
|   6 | Audio normalisation, atomic publish, authorised media serving, Archive list                                                    | Exactly one playable film is published from deterministic contributions.                                            |
|   7 | Playback UI, delayed state, restart persistence, and cross-group hosted tests                                                  | Full defining path works once end to end. **Hosted checkpoint 2.**                                                  |
|   8 | Hosted E2E automation, CI deploy/rollback, and web pass; only then pull P1 chat/deletion                                       | Full path passes twice from reset; no P0 defect remains open. **Hosted checkpoint 3 / release candidate.**          |
|   9 | Failure injection, security/denial pass, budget/log review, non-author runbook rehearsal                                       | Non-author completes the demo; restart and rollback do not lose or expose accepted Demo state.                      |
|  10 | Defect-only changes, second non-author rehearsal, Sprint Review; timeboxed UI-planning workshop after acceptance               | Same tagged release passes twice; demo owner and fallback are named; UI follow-up backlog is recorded separately.   |

### Daily integration checkpoints

- 10-minute lane/blocker sync at the start of the team's working window.
- Merge window at least twice daily so dependent lanes never wait overnight for
  a reviewable boundary.
- At each merge, run affected focused tests plus `npm run check`; deployment PRs
  also run container and hosted smoke tests.
- At Day 5 and Day 8, demonstrate from the production URL, not localhost.
- A red `main` or failed production smoke test becomes the team's only P0 until
  restored.

## 8. Definition of Done

An issue is Done only when:

1. Its observable acceptance criteria are checked with a specific test, PR,
   hosted URL result, or manual device result.
2. The change is merged to `main`; branch-only work is not Done.
3. Relevant automated checks pass and the PR is reviewed by someone other than
   its driver.
4. Project Status, Sprint, Priority, Risk, Work Type, and dependencies match the
   repository evidence.
5. The hosted Demo remains usable, or the issue is explicitly non-deploying and
   cannot affect it.
6. Logs, URLs, screenshots, and commits contain no secrets, invitation codes,
   local media paths, or private media.
7. Demo and simulator boundaries are labelled honestly. Synthetic access is
   not authentication; fixture capture is not physical recording; the single
   host is not production high availability.

## 9. Risks, triggers, and cuts

| Risk                                      | Trigger                                              | Immediate response                                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR #92 consumes the sprint                | Not green by Day 1 noon                              | Split or supersede it; merge only the verified baseline needed by Sprint 2.                                                                                           |
| AWS HTTPS distribution blocks deployment  | No working endpoint by Day 2 noon                    | Use the Lightsail container-service default HTTPS endpoint for a stateless fallback, or a temporary external DNS name with Caddy; keep the public API off plain HTTP. |
| Web camera cannot provide video           | Any browser/permission failure                       | Use the labelled synthetic clip or bounded file-picker path. Physical camera remains stretch evidence.                                                                |
| Media upload expands the critical path    | Real byte-upload work begins before the film plays   | Keep P0 on the server-owned synthetic fixture; do not pretend JSON `sourceUri` is an upload. Pull real byte upload only from P1.                                      |
| FFmpeg compilation is unstable            | No playable deterministic film by Day 6 noon         | Reduce to one normalised format and 1–2 fixture clips; cut chat, deletion, filler, and advanced retry.                                                                |
| SQLite concurrency/restart issue          | Busy/locked or lost data under the five-user fixture | Enforce one host/process, WAL/busy timeout, serial job claims, and restore from the last snapshot; do not add horizontal scale.                                       |
| Aggregate PR repeats Sprint 1 review cost | PR exceeds three outcomes or waits one day           | Stop adding scope, split at the adapter/API/UI boundary, and merge the smallest green dependency first.                                                               |
| Security claims outrun Demo access        | Real personal media or public users requested        | Stop; require OIDC/private-storage planning before expanding beyond synthetic/non-sensitive Demo data.                                                                |
| Issue-count pressure reduces quality      | Ticket has no independent acceptance outcome         | Merge it with the parent outcome and track velocity through PRs/checkpoints instead.                                                                                  |

## 10. UI planning — deliberately last

Sprint 2 implements only the controls and states necessary for the demo script:

- `Use synthetic demo clip` / bounded file selection;
- submit/progress/sealed/failure text states;
- owner-only `Advance Demo cycle` control;
- minimal Archive list, HTML/native video control, and download action;
- accessible labels, focus order, disabled/busy state, and non-colour-only status.

After the Day 10 release candidate is accepted, hold a separate two-hour UI
planning workshop. Its output is a later-sprint backlog covering information
architecture, visual system, responsive composition, typography, motion,
empty/error content, capture ergonomics, archive browsing, and usability-test
changes. No final UI redesign is allowed to enter the Sprint 2 critical path.

## 11. Sprint Review evidence

Prepare only evidence that proves the increment:

- production frontend and backend URLs;
- release tag/commit and 10–12 small PR links;
- hosted smoke-test result and `npm run check` result;
- AWS health/version response with no secrets;
- restart persistence, reset, and rollback results;
- one authorised and one cross-group denied media request;
- one sealed-before/released-after automated assertion;
- physical-device result labelled pass, fail, or not run;
- two non-author runbook results;
- actual issue/PR/checkpoint throughput against the baseline table.

## 12. Decisions needed at Sprint Planning

The plan can start with the defaults in parentheses, but the team should record
these answers on Day 1:

1. Which AWS account and region can all deployment owners access? (**Default:**
   one shared course AWS account, Singapore region.)
2. Should the frontend use the same AWS distribution or optional Vercel?
   (**Default:** same AWS distribution, with no external hosting dependency.)
3. Is the AWS account eligible for Free Tier credits? (**Default:** budget for
   approximately USD 14.50/month and treat credits only as savings.)
4. Can the team commit about 120 hours plus 10 hours of contingency? (**Default:**
   120 committed; if only 100 are available, apply the capacity cut above and
   keep P1 uncommitted.)
5. Which physical device will run the optional real capture check? (**Default:**
   one iPhone PWA or one Android Expo build; synthetic web clip remains the
   guaranteed Demo path.)

## 13. Baseline traceability

- [Sprint 0 plan](./sprint-0-plan.md)
- [Sprint 0 extension and Sprint 1 plan](./sprint-0-plan-extension.md)
- [Sprint 1 progress evidence](../sprint-1-progress-report-evidence.txt)
- [PR #79](https://github.com/Collaboration95/rewind-app/pull/79)
- [PR #80](https://github.com/Collaboration95/rewind-app/pull/80)
- [PR #91](https://github.com/Collaboration95/rewind-app/pull/91)
- [Open PR #92](https://github.com/Collaboration95/rewind-app/pull/92)
- [Sprint 1 milestone](https://github.com/Collaboration95/rewind-app/milestone/2)
- [GitHub Project #8](https://github.com/users/Collaboration95/projects/8)

```text
NEXT_ISSUE: 90
READY_COUNT: 0
IN_PROGRESS_COUNT: 0
REVIEW_COUNT: 1
BLOCKED_COUNT: 11
DRIFT_COUNT: 22
SYNCED: no
```
