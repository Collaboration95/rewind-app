# UC12–UC14 — Archive and client delivery use cases

**Evidence cut:** accepted `dev`, `1128b6a68985cf68215beb4a7a80fd00ec4242fa`. This draft models code-backed behavior and named gaps. Requirements R15/R18/R19/R22 are carried from [issue #361](https://github.com/Collaboration95/rewind-app/issues/361); see the crosswalk in [README.md](README.md). The committed proposal's relevant source requirements are FR-01, FR-02 and FR-09.

## Actors and boundary

| Actor                          | Responsibility                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Real-account group member      | Selects a group, views published group media, and downloads only their own released clips.                                                             |
| Group owner / invite recipient | Shares or opens a bounded invitation link; acceptance requires server-side invitation and session validation.                                          |
| Browser or installed PWA       | Opens the web shell, caches public assets by build, and keeps API/media online-only.                                                                   |
| Native app                     | Uses the `rewind` URL scheme and Expo media/file APIs where configured. Real-group link handling on a physical device is not acceptance evidence here. |
| Archive and media service      | Checks account session, selected-group membership, publication, job state and stored-byte integrity before issuing or serving a media capability.      |

The user interface and evidence separate local/demo archive calls from the real-account archive client. This package's protected media model follows the real-account capability route; it does not imply cross-account or public access.

## UC12 — View premiere and released archive

**Goal:** show truthful premiere/archive state and allow an authorized member to play only a ready, published group film.

**Preconditions:** the member has a valid session and selected group. A film must be ready and published before playback capability is issued. The archive exposes published films and the current member's released clips.

### UC12-F1 — Inspect premiere and archive state

**Normal flow:** the screen requests premiere state and the first archive page. The server binds the request to the selected real group, applies membership checks, filters for released/verified items, and returns the state and scoped capabilities. The screen shows locked, processing, delayed, failed, ready, empty, or populated state truthfully.

**Relevant exceptions:** no session, stale session or wrong group is denied; a locked/non-ready film receives no playback path; invalid cursor or service failure becomes an unavailable/retry state. An empty archive remains an explicit empty state.

### UC12-F2 — Start or resume premiere playback

**Normal flow:** the member presses Play. The client refreshes premiere availability and obtains a current play capability. The protected route resolves the capability, rechecks session, membership, published cycle, ready job and output identity, then opens an integrity-checked stored snapshot. The player starts with native controls. On return to foreground, the client refreshes authorization before resuming playback.

**Relevant exceptions:** an expired capability, revoked session, changed membership/release, delayed/failed job, integrity mismatch, busy media service, or network/player error does not produce playback. The screen offers a retry or truthful status. Physical-phone audible playback remains unverified.

### UC12-F3 — Browse and page released archive

**Normal flow:** the screen requests archived film and own-clip pages using independent film/clip cursors. The server verifies archive rows and returns only released items with scoped links and next-page flags. The client merges additional pages by item ID and shows cycle context.

**Relevant exceptions:** malformed cursor is rejected; an inaccessible group is denied; missing or changed bytes are withheld and audited; network failure preserves the current page and displays a notice.

**Source anchors:** [premiere route](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/http.ts#L2995), [archive route](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/http.ts#L3146), [archive screen](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/src/archive/ArchiveScreen.tsx#L251), [archive client facade](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/src/auth/real-account-client.ts#L471).

## UC13 — Download own clip or group film

**Goal:** save or open released media only after refreshing its current access path. An own clip is restricted to its contributing member; group films require group membership.

**Preconditions:** valid real-account session and selected group; item is ready, published and integrity verified. Private media is not made available from an offline service-worker cache.

### UC13-F1 — Download my released clip

**Normal flow:** the member chooses Download on their clip. The archive facade walks current pages to refresh the matching entry and capability. The server issues a `download` purpose capability only when the requesting member owns the clip. The platform adapter fetches a browser blob and opens a temporary download anchor, or writes the response into the Expo archive cache. The screen reports opened/saved.

**Relevant exceptions:** clip missing/deleted or owned by another member, group/session no longer valid, expired capability, offline runtime, HTTP failure, storage/capacity or integrity error. A failed native HTTP response is rejected and its partial file is removed where possible.

### UC13-F2 — Download a released group film

**Normal flow:** the member chooses a published group film. The archive facade resolves a fresh entry; the service issues a group-scoped download capability. The same browser/native adapter delivers the verified bytes and reports success.

**Relevant exceptions:** unpublished/failed film, membership/session change, expired grant, storage busy/size limit, integrity failure, or offline/network error. No stale private asset is served from local shell cache.

**Source anchors:** [capability issue/resolve](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/archive/capabilities.ts#L21), [protected download routes](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/http.ts#L3263), [stored media serving](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/archive/store-serving.ts#L14), [browser/native adapter](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/src/archive/archive-download.ts#L54).

## UC14 — Install, update, and open an invitation across clients

**Goal:** model safe web-shell install/update and bounded invitation-link handling, while leaving group authority and acceptance to the server.

**Preconditions:** HTTPS web origin for a real-group invite; app scheme `rewind` for the supported native invite form; accepting any real invitation still requires an authenticated server request. The PWA worker caches only public shell content.

### UC14-F1 — Install and open the web/PWA shell

**Normal flow:** the browser loads the secure origin and installs the PWA. The worker fetches the build-specific index, manifest, icons and referenced shell assets, then stores the complete public shell. A later offline navigation may load that shell; API and private media requests stay online-only.

**Relevant exceptions:** incomplete initial warm fails installation; offline shell can open but archive, invite acceptance, playback and download actions return unavailable/retry behavior.

### UC14-F2 — Apply a web/PWA shell update

**Normal flow:** a new build installs a versioned worker and warms the full shell. It waits while app clients are open. After old windows close, activation deletes prior shell caches and claims clients.

**Relevant exceptions:** failed asset fetch deletes the incomplete new cache and leaves the old active worker/cache usable. Native Expo OTA updates are disabled in `app.json`; this use case does not claim an installed native updater.

### UC14-F3 — Create and open a cross-client invitation link

**Implemented link functions:** `createInviteLink` can construct bounded HTTPS `/invite` or `rewind://invite` forms, and `parseInviteLink` can validate supported shapes. The accepted source cut does not show an app-level URL listener consuming that parser result. The recipient-opening path is therefore an analysis target, not a claim of implemented end-to-end routing.

**Relevant exceptions and limits:** malformed, expired, duplicate, unsupported or insecure real-group links are rejected. Real-account group IDs require HTTPS; the current link builder returns no native-scheme link when a real group ID is supplied. App scheme declaration exists, but universal-link association and installed-device routing are not verified.

### UC14-F4 — Accept a valid invitation after opening/authentication

**Conditional design flow:** if the real-account group UI is supplied a validated `inviteIntent`, it posts code and group ID to the real-account invitation accept endpoint. The server validates invite state and group/capacity rules in the membership operation; success routes into the group. The UI and endpoint are code-backed, but the source cut does not show app-level URL wiring into that prop.

**Relevant exceptions:** missing session or an absent intent consumer prevents this modeled call; expired, used, unknown, full, duplicate or mismatched invitations fail without adding membership; transport errors remain retryable. Installed physical-device end-to-end behavior remains unverified.

**Source anchors:** [web worker install/update/fetch](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/public/sw.js#L64), [app scheme and native update setting](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/app.json#L1), [invite link functions](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/src/invites/deep-links.ts#L52), [real invite acceptance route](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/http.ts#L3943).

## Flow inventory

| Use case | Major flow                  | Normal outcome                           | Relevant exceptions covered                                             |
| -------- | --------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| UC12     | F1 inspect premiere/archive | truthful current release and list        | auth/group denial, locked/non-ready, invalid cursor, network/empty      |
| UC12     | F2 play/resume premiere     | authorized stream starts                 | expiry, revocation, changed release, failure, integrity, network/device |
| UC12     | F3 browse/page releases     | released pages merge by ID               | invalid cursor, access denial, withheld bytes, network                  |
| UC13     | F1 download own clip        | fresh owner-scoped capability delivered  | missing/foreign item, stale auth, offline/HTTP/storage/integrity        |
| UC13     | F2 download group film      | fresh member-scoped capability delivered | unpublished/failed, stale auth, expiry, capacity/integrity/offline      |
| UC14     | F1 install/open PWA         | complete public shell available          | install warm failure; server actions offline                            |
| UC14     | F2 update PWA shell         | safe worker activation                   | failed warm retains old cache; activation waits for open clients        |
| UC14     | F3 create/open link         | bounded intent accepted by parser        | expired/malformed/duplicate, HTTPS requirement, native real-group gap   |
| UC14     | F4 accept invitation        | authenticated membership created         | no session, invalid/used/full, transport; no partial membership         |

The class and per-flow analysis/design figures are embedded in [models.md](models.md). Before/after pattern comparison and implemented decisions are in [design-problem.md](design-problem.md).
