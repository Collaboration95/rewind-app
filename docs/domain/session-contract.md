# Account session contract

This contract names the acting identity used by the app: a real account
registered with the Rewind server (`server/src/auth/`). The synthetic Demo
session that earlier sprints used was removed on 6 October 2026.

## Sign-in result

A successful sign-in returns the account, an opaque session token, and its
`expiresAt` instant. Invalid credentials and throttled attempts return
non-authorised outcomes without revealing which part was wrong. Sign-out and
account deletion end the session; a new session must be created by signing in
again.

## Request boundary

Every protected route resolves its actor through the presented session token.
The server ignores `memberId`-like query, body, and header values; a request's
`groupId` is only a resource selector, and persisted membership or owner policy
decides access. Missing, unknown, expired, and revoked sessions return the same
session-required response. A valid session aimed at a group the account does
not belong to returns the shared safe denial without probing that group's
resources.

The contract excludes managed OIDC and external identity providers, which are
deferred.
