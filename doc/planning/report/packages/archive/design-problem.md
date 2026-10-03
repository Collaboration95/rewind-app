# Private archive delivery and client-boundary design

## Problem

Archive media is private, publication-gated content delivered through browser and native clients with different file APIs. The client needs a bounded API that returns usable archive state and playback/download paths without treating a group ID or long-lived object path as authority. PWA shell updates must not cache private API/media responses or replace a working shell with an incomplete build. Invitation URLs must carry enough bounded intent to route a user while leaving group membership and acceptance to the server.

This is a real design problem supported by the current code. The package describes patterns where the implementation has functional/module roles; it does not add classes or refactor code to create textbook structures.

## Before — plausible but unsafe alternative

The “before” figures are conceptual comparison models, not a claim about a historical version. They show direct/stale media paths, platform branching scattered through screen code, and duplicated invite parsing as the alternatives the current boundaries help avoid.

![Before class comparison](diagrams/problem-before-class.svg)

![Before sequence comparison](diagrams/problem-before-sequence.svg)

## Candidate patterns

| Pattern | Fit to current code                                                                                                                                                                                                                                                                        | Decision and limit                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Proxy   | Strong: `MediaCapabilities` issues short-lived play/download grants and resolves them only after rechecking current account session, selected-group membership, published cycle, ready output identity and stored digest. The protected media route controls access to the stored subject. | Name the implemented capability-gated route as an access-control Proxy role. Do not claim a standalone `MediaProxy` class or S3 signed-object proxy. The backing provider and S3 delivery remain unverified. |
| Adapter | Strong: `downloadReleasedArchiveMedia` chooses browser fetch/blob/anchor or Expo filesystem saving. `deep-links.ts` maps native and web link forms into one bounded parse result, but no app-level URL consumer is evidenced at this cut.                                                  | Name the existing functions as platform Adapters. They are concrete branches/functions, not a class hierarchy. Physical provider/browser association behavior remains open.                                  |
| Facade  | Strong: `createRealAccountArchiveClient` groups premiere and paginated-archive requests, maps response shapes and can refresh an item across pages.                                                                                                                                        | Name this actual client boundary as the archive Facade. It does not replace server authorization; each protected route still checks its own preconditions.                                                   |

## After — implemented design

The actual implementation composes the three responsibilities. The archive screen calls the archive-client Facade for state and fresh items. Browser/native Adapter functions deliver media through platform APIs. Before bytes are served, a purpose-bound capability passes the server's Proxy checks and the store-serving function snapshots and verifies the media. The service worker caches public shell files by build identity and bypasses API/private media requests. Link parsing is a separate bounded function; an invitation payload does not grant membership.

![After implementation class diagram](diagrams/problem-after-class.svg)

![After implementation sequence](diagrams/problem-after-sequence.svg)

## Implementation decisions pinned to accepted source

1. `MediaCapabilities.issue` creates a random short-lived token, stores only its hash, binds purpose, member, group, job and exact output metadata, and returns `/media/access/{token}`. `resolve` rechecks session, selected membership, published cycle, ready job and the caller's own-clip condition.
2. The HTTP media path revalidates the resolved identity after asynchronous storage work, opens stored bytes through integrity verification, and applies serving capacity limits before streaming. No S3 deployment assumption is made here.
3. The archive client checks response status, maps media paths, and supports independent film/clip cursors. Downloads refresh the archive item before use, deduplicate in-flight requests, and select browser or Expo file delivery.
4. The service worker installs only a complete build-specific public shell; failed warm-up removes the incomplete new cache. API, private media, and non-GET requests bypass cache; offline navigation uses the public shell. The group UI accepts a supplied `inviteIntent`, but parser-to-app URL wiring is not evidenced.
5. Invite parsing accepts the supported web `/invite` and native `rewind://invite` targets, rejects malformed/expired values, and carries no session credential. The current builder rejects native links when a real group ID is supplied. The current source does not show a consumer wiring parsed URLs to the group UI intent prop; authenticated server acceptance remains authoritative.
6. `app.json` sets `updates.enabled` to false. Only the web/PWA update lifecycle is represented; a native OTA update flow is outside this source snapshot.

## Pinned source and fixture references

- Capability Proxy: [`server/src/archive/capabilities.ts`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/archive/capabilities.ts#L21); protected premiere/archive/download routes in [`server/src/http.ts`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/http.ts#L2995); integrity-gated stored media in [`store-serving.ts`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/server/src/archive/store-serving.ts#L14).
- Archive Facade and screen: [`createRealAccountArchiveClient`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/src/auth/real-account-client.ts#L471), [`RealAccountArchiveScreen`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/src/archive/ArchiveScreen.tsx#L251).
- Platform Adapter and invite parser: [`archive-download.ts`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/src/archive/archive-download.ts#L54), [`deep-links.ts`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/src/invites/deep-links.ts#L52).
- Web install/update/cache boundary: [`public/sw.js`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/public/sw.js#L64); native scheme/update setting in [`app.json`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/app.json#L1).
- Existing source fixtures: [`real-account-archive-client.test.ts`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/tests/real-account-archive-client.test.ts), [`archive-download.test.ts`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/tests/archive-download.test.ts), [`deep-link-invites.test.ts`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/tests/deep-link-invites.test.ts), [`pwa.test.mjs`](https://github.com/Collaboration95/rewind-app/blob/1128b6a68985cf68215beb4a7a80fd00ec4242fa/tests/pwa.test.mjs).

S3 delivery, audible installed-phone playback, physical universal-link/provider behavior and final report assembly remain pending. These diagrams document model intent and implementation evidence, not deployment or device acceptance.
