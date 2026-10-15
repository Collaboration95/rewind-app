# Cognito sign-in: design decisions and trade-offs

Recorded 8 October 2026 with the PR that delivers #363 and #364. The owner's
decisions are in `prompt.md`; this file lists what the implementation chose
where the prompt left room, and what was traded for speed.

## Flow

1. `GET /api/auth/cognito/start?return=<path>` creates `state`, `nonce` and a
   PKCE verifier, stores them in a 10-minute `__Host-rewind_oidc` cookie
   (HttpOnly, Secure, SameSite=Lax) and redirects to Cognito Managed Login.
2. `GET /api/auth/callback` checks the cookie, the `state` and that the `state`
   was not used before, swaps the code for tokens at Cognito's `/oauth2/token`,
   verifies the ID token with `aws-jwt-verify` (signature, issuer, audience,
   `token_use`, expiry), checks the `nonce` and `email_verified`, finds or
   creates the account by `cognito_sub`, and issues the normal opaque
   `__Host-rewind_session` cookie. It then redirects to the saved `return`
   path, which is how a pending invitation survives the round trip.
3. Everything after sign-in (groups, media, chat) is unchanged: it reads the
   Rewind session, never a Cognito token.

Routes live under `/api/*` so CloudFront forwards cookies and query strings and
the service worker does not intercept the callback.

## Choices

| Topic                         | Choice                                                                                                                                                                                   | Why                                                                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App client                    | Public client (no secret) with PKCE                                                                                                                                                      | The server exchanges the code, but a secret would have to live in the hosted env too. PKCE already binds the code to this browser.                                           |
| Account rows                  | New nullable unique `cognito_sub`; password columns keep `NOT NULL` and hold random values nobody knows                                                                                  | SQLite cannot drop `NOT NULL` without rebuilding a table that many tables reference. Random values mean a password can never match a Cognito account.                        |
| Username for Cognito accounts | `cognito-<12 hex>`                                                                                                                                                                       | The column is `NOT NULL UNIQUE`; the email is not stored because no screen needs it.                                                                                         |
| Display name                  | Empty at creation; the app asks on first sign-in (`POST /auth/profile`)                                                                                                                  | Cognito never sees the display name (prompt decision 4).                                                                                                                     |
| Replay protection             | In-memory set of used `state` values with a 10-minute lifetime                                                                                                                           | One server process. A restart can only shorten the window, which the cookie already bounds.                                                                                  |
| Redirect URI                  | Built from the request host (`https` behind the authenticated proxy, `http` only for the local-dev exception) plus `/api/auth/callback`                                                  | Cognito enforces an exact match against the client's callback list, which Terraform derives from `web_origins`, so a forged `Host` cannot start a flow Cognito would accept. |
| Return path                   | Same-origin absolute paths only, otherwise `/`                                                                                                                                           | Prevents an open redirect through `return`.                                                                                                                                  |
| Sign-out                      | `POST /auth/logout` revokes the session and returns `logoutUrl` for Cognito accounts; the client navigates there                                                                         | Next sign-in asks for credentials again (decision 14).                                                                                                                       |
| Deletion                      | Cognito accounts: typed `DELETE`. The Cognito user is deleted first; if that fails the account is left intact (502)                                                                      | A retry works because "user not found" counts as success.                                                                                                                    |
| Password sign-in              | `REWIND_AUTH_PASSWORD` (default true); `/auth/login` and `/auth/register` return 403 when false; `parseConfig` throws when the media or database environment is `release` and it is true | Release must never verify passwords (decision 11). The release module call sets `auth_password = false`.                                                                     |
| Partial Cognito settings      | A `ConfigError` unless all four `REWIND_COGNITO_*` values are set; password off without Cognito is also an error                                                                         | Nobody could sign in otherwise.                                                                                                                                              |
| Client config                 | Web fetches `GET /auth/config` once, waiting at most 2.5 s on the launch screen                                                                                                          | The entry screen never flashes password buttons and then swaps them. Failure keeps today's UI.                                                                               |
| Native builds                 | Never show the Cognito button                                                                                                                                                            | Decision 12: native signs in with a password against local or hosted-dev servers only. This is a limitation for the report.                                                  |
| Migration                     | `031-cognito-accounts.sql` for SQLite and PostgreSQL                                                                                                                                     | Same two statements on both.                                                                                                                                                 |

## Trade-offs made for speed (no real users)

- Cognito deletion protection is off, MFA is off, and email goes through
  Cognito's default sender (low daily limit; fine for this project).
- Password policy is a 10-character minimum with no forced complexity.
- Tokens last one day (Cognito's refresh minimum is 60 minutes); Rewind never
  calls Cognito after sign-in except to sign out or delete.
- The Terraform apply role gained `cognito-idp:*` (`infra/terraform/bootstrap/access.tf`)
  because it could not create a user pool. It is a family-level grant, the
  same style the role already uses for other services.
- `/real/*` routes do not refuse an account whose display name is still empty;
  the client gates it. An API caller could create a group with an empty name.
- The Managed Login logo asset did not render; colours and buttons did.

## Not done in this PR

- Release Terraform apply and the release account wipe go with the next `main`
  promotion, because release deploys only from `main`.
- `REWIND_COGNITO=dev` for `make run-real` is not scripted. Export the four
  `REWIND_COGNITO_*` values (from Terraform outputs) before `make run-real`;
  `http://localhost:8090/api/auth/callback` is already in the dev callback list.
- The `/api/auth/pending` fallback for the iPhone home-screen app is not built;
  it is only needed if the owner's device check fails.
