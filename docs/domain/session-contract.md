# Account session contract

Source baseline: `dev` `40ebeb5673d103b4b6950d095192aae744980769`, inspected
15 October 2026. This contract describes the implementation, not a live provider
or device verification result. The acting identity is a real Rewind account;
the synthetic Demo session was removed on 6 October 2026.

## Sign-in and session transport

Web/PWA uses Amazon Cognito Managed Login (authorization code + PKCE). The
server checks the short-lived state/nonce transaction, exchanges the code,
validates the ID token and verified email, and finds or creates the account by
`cognito_sub`. It then redirects to the validated same-origin return path with
an opaque Rewind session cookie. Cognito tokens do not authenticate later
application API requests. Profile onboarding collects the Rewind display name.
See the existing [Cognito decisions](../../doc/planning/sprints/sprint-3-cognito/design-decisions.md).

Local/dev retain Developer sign-in and registration under
`REWIND_AUTH_PASSWORD`. Invalid credentials and throttled attempts use generic
failure outcomes without identifying an unknown account. Release configuration
requires password sign-in off and complete Cognito settings; startup rejects
password sign-in when the media or database environment is `release`.
Native Expo clients keep the developer flow against local/dev and do not show
managed login. Compiled native iOS is outside the product scope.

Successful developer browser sign-in returns account, `expiresAt` and
`signInMethod`, with the token only in a Secure, HttpOnly, SameSite=Lax,
Path=/, no-Domain `__Host-rewind_session` cookie. Native sign-in returns the
opaque token in JSON for SecureStore and subsequent `Authorization: Bearer`
requests. Browser JavaScript does not receive the session token.

The server stores the token's SHA-256 hash, with a seven-day sliding idle
expiry and a 30-day absolute expiry. Session restore reports both expiry
instants and the sign-in method. Sign-out revokes the session and clears the
cookie; Cognito sessions also return a provider logout URL. Account deletion
revokes account sessions. A revoked or expired session requires sign-in again.

## Request boundary

Protected resource routes resolve the actor from the cookie or bearer
credential. If both are presented and differ, authentication fails. On these
routes, missing, unknown, expired and revoked credentials share the
`session_required` response.

Session restore (`GET /auth/session`, exposed as `/api/auth/session` through
the web proxy) deliberately distinguishes the cases: a missing or unusable
transport credential returns `session_required`; a presented token that is
unknown, expired or revoked returns `session_expired`. Both responses use HTTP 401. The browser client uses this distinction to separate signed-out state
from an expired-session notice.

Client-supplied member IDs cannot establish identity. A group ID is only a
resource selector; persisted membership/selection and owner/resource policy
decide access. A valid account does not grant access to another group's data.

Transport and browser origin checks precede identity resolution. Acceptable
transport is socket TLS, authenticated proxy HTTPS (matching origin proof plus
`X-Forwarded-Proto: https`), or an explicitly enabled loopback-only HTTP
exception with no forwarded protocol header. Merely setting a forwarded header
does not establish trust. Auth responses are `no-store`; credentialed browser
CORS grants an exact configured origin, never wildcard access.

Media element URLs use separate, two-minute opaque capabilities. A capability
can be presented without a session cookie, but the server rechecks its bound
session, accepted/selected membership, published cycle and exact verified
output. A different presented session is rejected. The capability is not a
general API session or a public S3 URL. See the
[current architecture](../architecture/current-system.md#trust-sessions-and-media-access).

## Implementation references

- [Server session lifecycle](../../server/src/auth/index.ts) and
  [HTTP transport, cookie and Cognito handlers](../../server/src/routes/auth-routes.ts).
- [Cognito validation](../../server/src/auth/cognito.ts) and
  [auth/environment configuration](../../server/src/config.ts).
- [Client account transport and SecureStore](../../src/auth/real-account-client.ts).
- [Media capability validation](../../server/src/archive/capabilities.ts).
