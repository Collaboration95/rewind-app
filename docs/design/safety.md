# Safety: report, block and owner removal

Source inspected: `dev` revision `39ba152af0da152ff8e0efe08be861270752129e`, 15 October 2026. Contract:
[UC-MANAGE-SAFETY](../../doc/planning/current-product-baseline.md#uc-manage-safety). Analysis names are conceptual
responsibilities; design modules below are functional code, not instantiated domain classes. Test links identify
specifications, not passing results.

<a id="safety-scope"></a>

## UC-MANAGE-SAFETY

**Actors/preconditions:** signed-in group member; owner specializes member for removal. Reports/removal authorize the group
in the URL against stored membership; these safety routes do not additionally require that group to be currently selected.
Blocking authorizes through any shared group and stores an account-level relation. Archive/media reads separately require
live selected membership and published assets.

**Normal flow:** member chooses a message, contribution or person and sends a report; Rewind validates the target and stores
one report per reporter/target. Message/contribution reports hide that item for the reporter. A person report alone records a
concern without hiding all that person's content. Member may separately block/unblock a person. Owner may confirm removal of
a group contribution, marking it hidden for all viewers and excluding it from eligible compilation inputs.

| Operation        | Validation, outcome and major exceptions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Report           | Exactly one recognized nonempty string target: `messageId`, `contributionId` or `memberId` (profile ID). Any explicitly empty target is invalid; reason defaults to empty, must be a string of at most 500 characters and is trimmed on insert. Message must belong to group; contribution must belong through its cycle and have no `deleted_at`. Person must be another account in that group. Invalid shape → 400; missing membership/foreign or missing target/self-person → 404; success, including duplicate → 201. Own message/contribution reporting is not explicitly forbidden by the service. |
| Block            | Target profile must resolve to another account sharing at least one group. Self, nonexistent or no-shared-group target → 404, without insertion. A target outside the selected group can qualify through another shared group. Duplicate insertion is ignored; success → 201. Unblock deletes only the caller's relation, returns 200 even if absent, and does not undo reports.                                                                                                                                                                                                                         |
| Owner remove     | Membership absent → 404; member without owner role → 403; contribution outside that group or missing → 404. Success → 200; repeated removal preserves the first marker. Service does not require an undeleted contribution, collecting phase or another author; Film UI offers removal only on another person's visible segment.                                                                                                                                                                                                                                                                         |
| Request boundary | Transport/origin rejection → 403; invalid session → 401. Report/block/unblock share the account token bucket (capacity 20, replenished over ten minutes); exhaustion → 429 before mutation. Removal is not routed through that safety bucket.                                                                                                                                                                                                                                                                                                                                                            |

**Effects and limits:** blocking hides the target's messages/moments for the blocker; it does not expel a member or prevent
ordinary group messages. Replies and reactions require a visible target and no block in either direction. Hidden
quoted-message previews are stripped. Reporting is not a verdict or a demonstrated review workflow: UI text promising review
within 24 hours is not evidence of an operational SLA.

Owner removal is **not correction deletion**: it writes `removed_at` and `removed_by_account_id`, leaving `deleted_at`, quota
counters and the author's correction allowance untouched. Eligible self-correction instead runs `deleteContribution` in a
writer transaction: validate original current seven-day window/collecting phase/job state, decrement reserved count/seconds,
increment `deletions_used`, tombstone contribution/job and update cycle counters; commit before bounded local file cleanup.
Ineligibility and exceptions roll back. Removal does not invoke that transaction or restore quota.

Archive/premiere return frozen segment offsets with viewer-specific `hidden` flags. The Film client skips hidden segments;
removed/deleted/missing contributions hide for everyone. The compiled film bytes are unchanged. Film downloads are still
advertised with those segments, and capability checks do not enforce segment redaction; `removed_at` is also not a clip
capability predicate. Do not infer secure erasure, a sanitized download or revocation of previously downloaded copies.

<a id="safety-a-class"></a>

## Analysis class view

```mermaid
classDiagram
  class SafetyBoundary
  <<boundary>> SafetyBoundary
  class SafetyControl
  <<control>> SafetyControl
  class Member
  class Membership
  Membership : role
  class Group
  class Report
  Report : targetKind
  Report : reason
  class Block
  class SharedItem
  SharedItem : removalMarker
  class ViewingPolicy
  <<control>> ViewingPolicy
  SafetyBoundary --> SafetyControl
  Member "1" -- "0..*" Membership
  Group "1" -- "1..*" Membership
  SafetyControl --> Membership : authorize
  SafetyControl --> Report : record
  SafetyControl --> Block : set or clear
  SafetyControl --> SharedItem : owner marks contribution
  Report --> SharedItem : item target or
  Report --> Member : person target
  Block --> Member : blocker and target
  ViewingPolicy --> Report
  ViewingPolicy --> Block
  ViewingPolicy --> SharedItem
```

<a id="safety-a-sequence"></a>

## Analysis sequence: normal and major failure paths

```mermaid
sequenceDiagram
  actor A as Member or owner
  participant B as Safety boundary
  participant C as Safety control
  participant R as Group and safety records
  participant V as Viewing policy
  A->>B: Choose report, block or remove
  B->>C: Submit actor, operation and target
  C->>R: Check membership, role and target scope
  alt Invalid actor, target, role or request
    C-->>B: Deny without changing safety records
    B-->>A: Explain failure or retry delay
  else Valid request
    alt Report
      C->>R: Record concern once
    else Block or unblock
      C->>R: Set or clear personal restriction
    else Owner removes contribution
      C->>R: Preserve removal author and time
      Note over C,R: No correction or quota restoration
    end
    C-->>B: Acknowledge operation
    B-->>A: Confirm and update local view
    V->>R: Read restrictions for subsequent chat or film view
    V-->>B: Filter messages or mark hidden film segments
    Note over B,V: Compiled/downloaded bytes are not rewritten
  end
```

<a id="safety-d-class"></a>

## Design class view: actual symbols and persistence

```mermaid
classDiagram
  class SettingsScreen
  <<component>> SettingsScreen
  class FilmScreen
  <<component>> FilmScreen
  class client_safety_ts
  <<module>> client_safety_ts
  class http_ts
  <<module>> http_ts
  class server_safety_ts
  <<module>> server_safety_ts
  class RewindDatabase
  <<typeAlias>> RewindDatabase
  class FilmSegment {
    <<interface>>
    contributionId
    startSeconds
    durationSeconds
    hidden
    mine
  }
  SettingsScreen --> client_safety_ts
  FilmScreen --> client_safety_ts : report
  FilmScreen --> http_ts : removal POST
  client_safety_ts --> http_ts : authenticated request
  http_ts --> server_safety_ts
  server_safety_ts --> RewindDatabase
  server_safety_ts ..> FilmSegment : returns projection
  FilmScreen ..> FilmSegment : skip hidden
```

`SettingsScreen`: [Settings.tsx](../../src/real/Settings.tsx); `FilmScreen`: [Film.tsx](../../src/real/Film.tsx). Module
aliases: [client safety](../../src/real/safety.ts) (`reportContent`, `blockMember`, `unblockMember`, `listBlocked`);
[HTTP](../../server/src/http.ts) (`handleRealGroupRequest`, `handleRequest`); [server
safety](../../server/src/groups/safety.ts) (sequence functions plus `visibleChatEvent`, `canInteractWithChatMessage`).
`RewindDatabase` aliases `DatabaseSync` (providing `prepare`/`exec`) in [db.ts](../../server/src/db.ts). Tables: `content_reports`, `member_reports`,
`account_blocks`, `contributions`, `film_segments`, joined to membership/profile/cycle/job/input rows. See
[028](../../server/migrations/028-content-safety.sql), [029](../../server/migrations/029-member-reports.sql), superseded for
report retention by [030](../../server/migrations/030-moderation-records.sql): target/group deletion can null references
while reporter/reason/time survive; deleting the reporter cascades their reports.

<a id="safety-d-sequence"></a>

## Design sequence: normal and major failure paths

```mermaid
sequenceDiagram
  participant U as SettingsScreen or FilmScreen
  participant H as http.ts
  participant S as groups/safety.ts
  participant D as RewindDatabase
  U->>H: Authenticated safety request
  alt Bad transport/origin, session or exhausted applicable bucket
    H-->>U: 403, 401 or 429, no safety mutation
  else Boundary accepted
    alt POST /real/groups/:groupId/reports
      H->>S: reportContent(database, accountId, groupId, body, now)
      S->>D: Validate shape, membership, scoped target
      alt Invalid shape or missing/foreign/self-person target
        S-->>H: invalid or not_found
        H-->>U: 400 or 404
      else Eligible target
        S->>D: INSERT OR IGNORE content_reports or member_reports
        H-->>U: 201 reported
      end
    else POST /real/blocks
      H->>S: blockMember(database, accountId, profileId, now)
      S->>D: Resolve other account through any shared membership
      alt Self, missing or no shared group
        S-->>H: not_found
        H-->>U: 404
      else Shared other account
        S->>D: INSERT OR IGNORE account_blocks
        H-->>U: 201 blocked
      end
    else POST /real/groups/:groupId/contributions/:id/remove
      H->>S: removeContribution(database, accountId, groupId, id, now)
      S->>D: Check role and contribution cycle group
      alt No membership/target, or non-owner
        S-->>H: not_found or forbidden
        H-->>U: 404 or 403
      else Owner and scoped contribution
        S->>D: UPDATE removed_at, removed_by_account_id if unmarked
        Note over S,D: Single UPDATE, no deletion transaction or quota change
        H-->>U: 200 removed
      end
    end
  end
  opt Later authorized Archive or premiere read
    H->>S: filmSegments(database, filmId, viewerProfileId)
    S->>D: freezeFilmSegments if absent, SAVEPOINT inserts, release or rollback
    S->>D: Join frozen offsets to contribution, block and report state
    S-->>H: FilmSegment[] with viewer-specific hidden flags
    H-->>U: Published verified film access plus segments
    U->>U: Skip hidden moments using timeUpdate and seek
  end
```

<a id="safety-transition"></a>

## Analysis-to-design transition and alternatives

| Refinement / design choice               | Actual mapping and tradeoff                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boundary/control/entity separation       | Conceptual SafetyBoundary becomes Settings/chat/Film components plus client request functions; SafetyControl becomes HTTP guards and functional safety exports. Reports/blocks are rows, not invented service/entity classes. Chat uses [RealAccountChatScreen](../../src/chat/RealAccountChatScreen.tsx) and server [chat functions](../../server/src/chat/index.ts).                         |
| Identity and scope refinement            | Conceptual person targets become profile IDs resolved to account IDs. Reports/removal retain group scope; blocks persist by account pair. This prevents a selected-group-only UI rule being mistaken for server authorization.                                                                                                                                                                 |
| Distinct lifecycle operations            | Owner marker and transactional self-correction remain separate. [deleteContribution](../../server/src/contributions/index.ts) owns quota restoration; [jobs input selection](../../server/src/jobs/index.ts) excludes removed contributions. A shared destructive delete would conflate safety authority with the author's bounded allowance.                                                  |
| Derived visibility and stable timing     | `filmSegments` derives visibility rather than mutating compiled output. `freezeFilmSegments` inserts all offsets under a savepoint, rolling back partial insertion on error; it also supports nesting during account purge. Reports/blocks/removal use individual SQL mutations, not that savepoint.                                                                                           |
| Alternatives, not implementation history | Client-only filtering would lack persisted cross-session policy. Re-encoding each viewer's film could redact bytes but adds processing/storage and invalidation work. Actual persisted restrictions plus read-time flags preserve one film and stable offsets, with the explicit raw-media limitation above. These are evaluated alternatives, not claims of earlier versions or GoF patterns. |
| Composed action failure                  | Settings/chat send the report before optional block as separate HTTP requests. A block/network failure can follow a committed report; retry deduplicates reporting. No combined all-or-nothing transaction is claimed.                                                                                                                                                                         |

Specification locations: [account safety](../../server/tests/account-safety.test.mjs) (validation, duplicates, chat/block,
retention), [rate limits](../../server/tests/safety-rate-limits.test.mjs), [real
Archive](../../server/tests/real-archive.test.mjs) (viewer flags, owner scope, unchanged counters/offsets), [correction
policy](../../server/tests/contribution-policy.test.mjs), [Settings safety](../../tests/real-settings-safety.test.tsx), [chat
UI](../../tests/real-account-chat.test.tsx), [Film UI](../../tests/film-screen.test.tsx).

Static-only limits: source and linked definitions were inspected; no tests, app, browser/device flows, deployment, external
moderation process or performance checks were executed. Rendering, independent review, application checks and CI belong to
the integrating batch. No human design ownership or operational compliance is inferred.
