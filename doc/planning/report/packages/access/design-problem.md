# Design problem and pattern rationale

## Problem: preserve one private-group boundary across distinct identities

The current service has two principal types. Demo requests carry a synthetic `memberId` bound to a Demo session and selected group. Real-account requests carry an opaque browser cookie or native bearer token; the server resolves an `accountId` and then tests real-group membership. The protected outcome should remain consistent: a client-supplied group ID selects a resource, but it must not create authority.

This is a genuine design pressure visible in the implementation: Demo resource routes pass through `requireAuthorisedGroup` and `authorizeSessionMember`/`authorizeMember`, whereas real-account group and invite functions use account-specific membership/owner queries. Media has a separate boundary that distinguishes the credential families and rejects a mixed Demo-session/account request. These are deliberate runtime differences, but they create a maintenance risk if resource checks evolve independently. This finding describes an authorization-design consistency risk; it does not claim a demonstrated cross-group data leak.

## Before — route-local authorization alternative

The first static view is the brute-force alternative: each route reads identity/group values, performs its own membership or owner query, and formats its own denial. It is a comparison model, not a claim that this exact design was a historical production version. The concrete evidence for the problem is the current split shown in the after view and the linked code.

![Before class diagram: route-local checks](diagrams/problem-before-class.svg)

![Before sequence diagram: route-local checks](diagrams/problem-before-sequence.svg)

## Candidates

| Candidate | Fit | Trade-off in this codebase |
|---|---|---|
| Policy / Strategy | Keep the membership/owner decision behind a stable decision boundary while runtime adapters establish a trusted principal. Resource handlers can ask for a member/owner decision without trusting request IDs. | `authorizeMember`, `authorizeOwner`, and the Demo session wrappers already express policy as functions. The real-account path currently has account-specific queries rather than the same account-agnostic policy, so the implementation is only partially unified. Do not invent a Strategy class that is absent from code. |
| Chain of Responsibility | Compose transport, credential, session, group and role checks; a failed handler stops the request. | The current flow is explicit and short-circuiting, but separate request families carry different credential and persistence semantics. A formal handler chain would add ordering/delegation machinery and make it harder to see which transaction-bound query authorizes a real-group mutation. |

## After — implemented boundary and decision

The implemented decision is a boundary-first, function-centered policy where the identity model matches: the Demo route adapter validates session identity and group binding before calling shared member/owner policy. Real-account routes validate account sessions and use account-specific membership/owner predicates in the real-group and invite modules. The media adapter is the point that accepts either identity family and rejects mixed authority. This is the actual design to document, not a claim that all account types use one universal Policy/Strategy object.

The selected direction favors explicit identity adapters plus the shared policy functions that exist, rather than a formal Chain of Responsibility. It keeps credential interpretation at the request boundary, keeps database membership checks with the domain operation, and makes safe denial visible. The remaining split is recorded as a limitation for final architecture review; this docs package does not refactor application code to manufacture a pattern.

![After class diagram: current policy and identity adapters](diagrams/problem-after-class.svg)

![After sequence diagram: current policy and identity adapters](diagrams/problem-after-sequence.svg)

## Implementation decisions evidenced at the code cut

1. Demo route identity comes from a validated persisted Demo session. The request's group ID must match that session before member policy runs.
2. Real-account identity comes from the browser cookie or native bearer token. Account and profile identity are resolved server-side; a query/body member ID is not the real-account authority.
3. Demo member/owner checks return a safe denial through shared policy functions. Real groups query `real_group_memberships` and the recorded owner account for group/invite operations.
4. Media auth rejects a request that mixes real credentials and a Demo `sessionId` rather than choosing whichever credential succeeds.
5. OIDC issuer/subject resolution and PostgreSQL policy consolidation remain Sprint 3 design/implementation work. Neither is drawn as currently implemented.

## Code evidence

- Demo policy and group binding: [`server/src/policy.ts`](https://github.com/Collaboration95/rewind-app/blob/450a7199767ecc4ea3e96f0f7503d0f2170d382c/server/src/policy.ts#L21), [`requireAuthorisedGroup`](https://github.com/Collaboration95/rewind-app/blob/450a7199767ecc4ea3e96f0f7503d0f2170d382c/server/src/http.ts#L278).
- Real account request boundary and group routes: [`handleRealGroupRequest`](https://github.com/Collaboration95/rewind-app/blob/450a7199767ecc4ea3e96f0f7503d0f2170d382c/server/src/http.ts#L3188), [`getRealGroup` / `selectRealGroup`](https://github.com/Collaboration95/rewind-app/blob/450a7199767ecc4ea3e96f0f7503d0f2170d382c/server/src/groups/real.ts#L110).
- Real invitation owner, replay, expiry, capacity and transaction checks: [`server/src/groups/invites.ts`](https://github.com/Collaboration95/rewind-app/blob/450a7199767ecc4ea3e96f0f7503d0f2170d382c/server/src/groups/invites.ts#L124).
- Media identity adapter's mixed-credential rejection: [`requireAuthorisedMediaGroup`](https://github.com/Collaboration95/rewind-app/blob/450a7199767ecc4ea3e96f0f7503d0f2170d382c/server/src/http.ts#L302).

The “before” diagrams compare a route-local design option with the current implementation. They do not assert a historical vulnerability or an undocumented team decision.
