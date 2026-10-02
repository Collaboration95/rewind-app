# Access use cases

**Evidence cut:** `a6b6b312f219c268a16401f64efe6c3b8f808a54` (published PR #368 head, 2 October 2026; PR remains open/draft). “Account” below means the current local real-account pilot. “Demo” means the separate synthetic session runtime.

## Scope and actors

| Actor                                | Responsibility                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| Account holder                       | Registers, signs in, restores or ends an account session; creates or selects groups. |
| Group owner                          | The account holder recorded with the owner role; may issue and revoke invitations.   |
| Invited account holder               | An authenticated account that submits an invitation code and joins a group.          |
| Non-member / unauthenticated visitor | May attempt a protected operation but receives no account or group authority.        |
| Identity provider (target)           | Managed OIDC/Cognito in Sprint 3; not active in this code snapshot.                  |

The model covers the access slice of proposal FR-01 (identity and private groups) and FR-02 (group creation and invitations). The proposal calls its combined entry journey UC-01; this report follows issue #357's expanded UC01 authentication/session, UC02 group, and UC03 invitation boundaries so that each has a usable model. Issue #357 cites `R01–R03,R22`; the execution-plan-derived bounded trace is in [README.md](README.md), with its source limitation stated there.

![Overall access use-case view](diagrams/use-case-overview.svg)

## UC01 — Register, authenticate, and manage a session

**Goal:** establish a server-validated account identity for a client session and end that authority truthfully at expiry or sign-out.

**Preconditions:** the client can reach the configured HTTPS API. Registration accepts a username and password. Sign-in requires an existing account. Current implementation is local password verification and SQLite session storage; the proposal's OIDC flow remains a Sprint 3 target.

### UC01-F1 — Register an account

**Normal flow:** the holder submits a username and password; the client sends `POST /auth/register`; the server validates and normalizes the account fields, hashes the password, and persists a new account; the client receives the created account without a session token.

**Relevant exceptions:** malformed or oversized input is rejected; a normalized duplicate username returns an unavailable-name response; the registration source limiter returns a retry delay; persistence failure returns temporary unavailability. No session is implied by registration.

### UC01-F2 — Sign in

**Normal flow:** the holder submits username/password and the browser/native client type; the server applies login throttling, verifies the password hash, records a session, and returns account/session data. Browser sessions use the HttpOnly cookie; native sessions return an opaque token for secure storage.

**Relevant exceptions:** malformed fields or client type, unknown username, wrong password, or cooldown produce a generic sign-in failure. Repeated guesses are bounded by the account/source throttling state. Transport or service failure is shown as an auth error rather than an active session.

### UC01-F3 — Restore or validate a session

**Normal flow:** on startup the client reads the browser cookie or native secure token and requests `GET /auth/session`; the server validates the token hash, revocation, idle expiry and absolute expiry, updates last-seen/idle expiry for a valid session, and returns the account and expiry values.

**Relevant exceptions:** no credential returns the entry state; expired or revoked credentials return an unauthenticated outcome and the client clears stale native state and shows an expiry/revocation notice. A transport failure remains a retry/error state and is not treated as proof of expiry.

### UC01-F4 — Sign out

**Normal flow:** the client requests `POST /auth/logout`; the server revokes the presented session and expires the browser cookie; the client clears its native token and transitions to signed-out state.

**Relevant exception:** if remote revocation is not confirmed, the provider preserves the active state or a pending sign-out marker so the UI does not claim that the server session ended. The exact behavior is client-platform aware.

### Sprint 3 target, separate from UC01 pilot evidence

The proposal requires managed OIDC. The target entry will redirect to Cognito, handle successful callback and user cancellation/error, bind a stable issuer/subject to the application account, and establish the application session. It is not implemented at this evidence cut, so its callback and cancellation sequences are a final-model follow-up for #363/#364, not pilot flows.

## UC02 — Create and select a real group

**Goal:** establish a private group with its owner and first cycle, then let an account select only a group of which it is a member.

**Preconditions:** a valid real-account session. Creation accepts a group name, prompt, and member cap in the supported 2–10 range. The UI omits timezone; the API accepts an optional validated IANA timezone and defaults it to UTC.

### UC02-F1 — Create a group

**Normal flow:** the owner submits group details to `POST /real/groups`; the UI sends name, prompt, and member cap without a timezone. The server validates fields, defaults the absent timezone to UTC (or canonicalizes a valid API-supplied IANA zone), and in one transaction creates/reuses the owner profile, group metadata including timezone, the initial four-week cycle, owner membership, and current-group selection; it commits and returns the created group.

**Relevant exceptions:** malformed body or invalid name/prompt/member cap/timezone is rejected; a persistence error rolls back the transaction and returns a no-partial-group response. A missing/invalid session is rejected before group creation.

### UC02-F2 — List, read, and select a group

**Normal flow:** the account requests its current group/list; the server derives the account from the validated session and lists only joined groups. To switch, the client posts a group ID; the server checks membership before persisting the selection and returning the selected group.

**Relevant exceptions:** an account with no selection receives a null current group; a malformed group identifier is rejected; an unjoined or unknown group is denied without making it current. A stale session is denied before lookup.

### UC02-F3 — Edit current collecting-cycle prompt and group timezone

**Normal flow:** the group owner changes the prompt and an IANA timezone in the group settings panel. The authenticated settings route verifies owner role and that the current cycle is still collecting and has not ended, then transactionally updates group metadata timezone and the current cycle prompt. Success returns refreshed group data. When a successor cycle is created, it copies the current cycle prompt.

**Relevant exceptions:** invalid prompt/timezone is rejected; a non-owner or inaccessible group is forbidden; a closed or elapsed cycle is rejected; storage failure rolls back both updates. Existing cycles are not all rewritten by this setting change.

### UC02-F4 — Save a member reminder preference

**Normal flow:** any group member can enable/disable their own reminder preference or set a snooze. The service validates membership and preference fields, limits snooze to 31 days, and upserts the preference by `(group_id, account_id)`. The response calculates the next Sunday 19:00 occurrence in the group's IANA timezone and reports delivery as `not-configured`.

**Relevant exceptions:** non-member/unknown group is forbidden; malformed enabled or snooze values are rejected; an invalid schedule or persistence failure does not imply a notification was sent. A nonexistent local Sunday 19:00 during a timezone transition is skipped by the scheduler's bounded resolver.

## UC03 — Issue, revoke, and accept a group invitation

**Goal:** allow a group owner to create a short-lived invitation and allow one authenticated non-member to join, subject to validity, capacity, and replay controls.

**Preconditions:** invite creation/revocation requires a valid owner account session; acceptance requires a valid account session. Current invitation expiry defaults to 24 hours and may range from five minutes to seven days.

### UC03-F1 — Create an invitation

**Normal flow:** the owner requests an invitation for a group; the server confirms both owner membership and the recorded owner account, validates expiry, allocates a unique random code, persists the active invitation, and returns its code/expiry; the client can display or form a deep link from that result.

**Relevant exceptions:** a missing group, non-owner, invalid expiry, or persistence/code-allocation error is rejected; no partial invite is reported as success.

### UC03-F2 — Revoke an invitation

**Normal flow:** the owner deletes the active invitation resource; one conditional update expires it only when group, invitation, owner account, active status, and owner membership all match.

**Relevant exceptions:** nonexistent, already-used/expired, cross-group, or non-owner requests make no update and return the same unavailable-invitation response.

### UC03-F3 — Accept a valid invitation

**Normal flow:** an authenticated invitee submits the code and optional expected group ID; the server records a guess attempt, normalizes/validates the code, loads the active invite, checks expiry and group consistency, checks capacity and duplicate membership, creates a profile if necessary, inserts membership, marks the invite accepted, selects the joined group, and commits the transaction.

**Relevant branch:** an existing account profile is reused. For a new profile the profile and membership changes occur with invite consumption and selection in the same transaction.

### UC03-F4 — Reject an unusable invitation

The same accept boundary rejects malformed or unknown codes, exhausted account/source guess limits, expired codes, accepted/replayed codes, a requested group that differs from the code's group, full groups, and absent/expired account sessions. A storage failure rolls back membership and invite consumption. Responses preserve a safe failure state; none of these paths creates partial membership.

## Flow-to-sequence inventory

Each row has a separate analysis sequence and design sequence in [models.md](models.md). The flow families group branch outcomes only where they share the same initiating interaction; each relevant exception remains named above and appears in that flow's sequence diagram.

| Flow    | Normal path                                              | Exceptional branches included                                                                          |
| ------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| UC01-F1 | New account persisted                                    | Invalid/oversized input, duplicate name, rate limit, store failure                                     |
| UC01-F2 | Password accepted and browser/native session issued      | Invalid fields/type, bad credentials, throttling/cooldown, service error                               |
| UC01-F3 | Valid browser/native session restored                    | Missing, expired/revoked token, transport failure                                                      |
| UC01-F4 | Session revoked and client signs out                     | Remote failure/pending state                                                                           |
| UC02-F1 | Group, cycle, owner membership, selection committed      | Invalid fields, no session, transaction rollback                                                       |
| UC02-F2 | Member lists/selects own group                           | Null selection, malformed/unknown/non-member group, stale session                                      |
| UC02-F3 | Owner updates collecting-cycle prompt and group timezone | Non-owner, invalid prompt/zone, closed cycle, rollback                                                 |
| UC02-F4 | Member saves personal group reminder preference          | Non-member, invalid/snooze boundary, persistence/schedule failure; delivery unconfigured               |
| UC03-F1 | Owner creates unique expiring invitation                 | Missing group, non-owner, invalid expiry, persistence/allocation failure                               |
| UC03-F2 | Owner revokes active invite                              | Missing, inactive, used, cross-group, non-owner                                                        |
| UC03-F3 | Invitee joins and group becomes selected                 | Existing/new profile branches within successful transaction                                            |
| UC03-F4 | No membership mutation                                   | Missing session, malformed/unknown/throttled, expired, replayed/duplicate, cross-group, full, rollback |

## Explicit exclusions and target cases

Public discovery, public profiles, owner transfer, member removal, leaving/rejoining, account deletion, and account recovery are outside this access slice. Managed OIDC login, provider cancellation/callback, and provider-subject mapping are target behavior for Sprint 3 and are not part of the twelve current pilot flow families. Reminder delivery is also not configured; only schedule calculation and preference storage are modeled as implemented.
