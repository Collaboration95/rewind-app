# Sprint 3: Cognito sign-in (agent prompt)

Hand this file to one agent as its prompt. Owner decisions were made on
8 October 2026. They replace the "Managed OIDC (Cognito) is deferred" product
decision in `AGENTS.md` and the pilot-login exception recorded in #169.

**Why:** the submitted project document (§4.1, §5.2, §6, §7.1) requires
sign-in through a standards-based OIDC flow, with Amazon Cognito User Pools
as the preferred provider. Rewind must not store or verify passwords on
the release environment.

**Security bar:** this app demonstrates DevSecOps practice and has no real
users. Where security and developer speed conflict, choose speed and write
down the trade-off in the PR. Never slow down local runs, tests or live
testing on hosted dev.

## Decisions

| #   | Topic                    | Decision                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Sign-in UI               | Cognito Managed Login (redirect), authorization code + PKCE, branded in Warm Glass colours.                                                                                                                                                                                                                                    |
| 2   | Token exchange           | Server-side (backend-for-frontend). The server swaps the code, validates the ID token, then issues the existing opaque Rewind session (`__Host-rewind_session` cookie, or bearer token). Group, media and chat routes do not change.                                                                                           |
| 3   | Session length           | **Rewind session idle expiry: 7 days** (was 12 h; `SESSION_IDLE_MS` in `server/src/auth/index.ts`). Absolute expiry stays 30 days. Cognito ID/access tokens: 1 day (they are only used at sign-in). No Cognito calls after sign-in, except sign-out and deletion.                                                              |
| 4   | Sign-in identifier       | Email + password, email verified. Self-service "forgot password" uses Cognito's default email sender. The display name stays in the Rewind profile and is asked for on first sign-in.                                                                                                                                          |
| 5   | Self sign-up             | On.                                                                                                                                                                                                                                                                                                                            |
| 6   | MFA                      | Off.                                                                                                                                                                                                                                                                                                                           |
| 7   | Social login             | None.                                                                                                                                                                                                                                                                                                                          |
| 8   | Tier and domain          | Essentials tier, default Cognito prefix domain, no custom domain.                                                                                                                                                                                                                                                              |
| 9   | Environments             | One user pool per environment (dev, release), each with its own app client and callback list, built from one Terraform module. Apply dev now; release goes out with the next `main` promotion.                                                                                                                                 |
| 10  | Existing accounts        | Delete all real accounts and their data on hosted dev and release, and start fresh. No backup, linking or migration; test data can be re-seeded later.                                                                                                                                                                         |
| 11  | Password code            | Keep password sign-in only for local runs, tests and **hosted dev** (see Developer-speed rules). Release refuses to start with password sign-in enabled.                                                                                                                                                                       |
| 12  | Native Expo builds       | Web/PWA only. Native builds sign in with a password against local or hosted-dev servers only; the report lists this as a limitation.                                                                                                                                                                                           |
| 13  | Account deletion check   | Typed "DELETE" confirmation in place of the password. The server deletes the Cognito user (`AdminDeleteUser`) and then runs the existing purge.                                                                                                                                                                                |
| 14  | Sign-out                 | Revoke the Rewind session and redirect to Cognito `/logout` so the next sign-in asks for credentials again.                                                                                                                                                                                                                    |
| 15  | iPhone home-screen check | The agent verifies everything it can. The owner then does one 2-minute check on their iPhone (installed PWA, sign in, sign out).                                                                                                                                                                                               |
| 16  | Issues                   | Rewrite #363 (Terraform + server) and #364 (client) in the Problem / Expected / How to check format. Add the `mvp` label, the Sprint 3 milestone and `doing`. Comment on #169 that the exception is reversed. Update the Cognito line under "Product decisions" in `AGENTS.md`. Close #481 and #482, which shipped in PR #490. |
| 17  | Delivery                 | One worktree from `origin/dev` and one PR (Terraform + server + client). The agent applies dev Terraform itself and merges when Quality is green.                                                                                                                                                                              |
| 18  | Timing                   | Start now. Merge to `dev` by about 17 October.                                                                                                                                                                                                                                                                                 |

## Developer-speed rules (these override the decisions above)

Checked against `origin/dev` on 8 October. Each rule stops Cognito from
blocking a workflow that exists today.

1. **Keep password sign-in on hosted dev ("Developer sign-in").** Today,
   agents and scripts test hosted dev by calling `/auth/register` and
   `/auth/login` directly (`scripts/verify-real-login.mjs` and
   `scripts/measure-real-group-performance.mjs`). Expo Go sessions also use
   them. Agents cannot receive Cognito verification emails, and an agent
   driving a browser cannot type credentials into a Cognito-hosted page.
   This is the standard path for live testing, because it has no AWS, rate
   limit or network dependency.
   - Add `REWIND_AUTH_PASSWORD=true|false`. It is true in local, test and
     hosted-dev settings, and false on release.
   - The server refuses to start with it set to true when the environment
     is release.
   - On dev, the entry screen shows "Continue with Cognito" as the main
     action and a small "Developer sign-in" link to the existing form.
   - Both paths end in the same Rewind session, so everything after sign-in
     tests the same code that release runs. The Cognito-specific parts
     (redirect, callback, account lookup, sign-out) are covered by rule 3's
     offline tests and by one manual sign-in by the owner.
2. **Local runs stay on password sign-in by default.**
   - `make run-real` (`scripts/run-real-local.mjs`), the LAN/Expo Go
     preview (`scripts/run-local-dev.mjs`, phone on `http://192.168.x.x`)
     and `npm run web` keep the current form. Cognito accepts plain-HTTP
     callbacks only for `localhost`, so a LAN phone could never complete a
     Cognito redirect.
   - Optional: with `REWIND_COGNITO=dev`, `make run-real` uses the dev pool,
     and `http://localhost:8090/api/auth/callback` is in the dev client's
     callback list.
3. **Tests need no network or AWS.**
   - All existing server tests sign in with a password through
     `server/tests/helpers/real-http.mjs` (about 30 files). The real-account
     e2e (`npm run test:real-account-e2e`) does the same. Keep them as
     they are.
   - New OIDC tests generate an RSA key pair in the test and preload the
     JWKS into the verifier (`aws-jwt-verify` has `cacheJwks`). Cover a good
     token and wrong issuer, wrong audience, expired token, bad signature,
     bad state and replayed state.
4. **Deploys are unaffected.** `deploy-dev.yml` and `deploy-release.yml`
   only check `/api/health`. Cognito settings flow through the existing
   Terraform-written `hosted_env` object (`infra/terraform/media/main.tf`
   and its release equivalent), so no one copies IDs by hand.

## Implementation notes

- **Routes.** Use `/api/auth/cognito/start` and `/api/auth/callback` as the
  redirect URI.
  - Keeping them under `/api/*` means CloudFront forwards query strings and
    cookies (`api_forward_all` in `infra/terraform/demo/web-distribution.tf`).
  - The service worker passes `/api` requests straight to the network
    (`public/sw.js`), so it will not serve the app shell on the callback.
- **State and PKCE.** Keep `state`, `nonce` and the PKCE verifier in a
  short-lived `SameSite=Lax` cookie. Preserve any pending invite code
  through the redirect, either in that cookie or under the existing saved
  invitation key.
- **Account record.** Add a `cognito_sub` column (unique, nullable) to
  `real_accounts` through a new migration that works on both SQLite and
  PostgreSQL. Create the account on first Cognito sign-in. The email is
  stored only if a screen needs it.
- **Deletion.** Grant the runtime IAM user `cognito-idp:AdminDeleteUser`,
  scoped to that environment's pool ARN only. Use the existing
  `aws_iam_user_policy.runtime`.
- **Session expiry.** Change `SESSION_IDLE_MS` to 7 days and update the
  tests that assert 12 h. This change can land first.
- **Wipe (decision 10).** Delete the `real_accounts` rows on dev
  (PostgreSQL) and release (SQLite); the cascades remove sessions,
  memberships and invites. Then remove orphaned media through the existing
  purge path. Record the counts wiped in the PR.
- **Not in scope.** Federation, MFA, custom domains, Cognito Plus, native
  `expo-auth-session`, a headless Cognito test-user script, and the frozen
  report folder.

## Known risk: iPhone home-screen app

When an installed iPhone PWA redirects to another origin, iOS opens the page
in an overlay browser. It is not certain that the session cookie set on
return lands in the PWA's own storage. The agent cannot check this; the
owner's device check (decision 15) does.

If it fails, use this fallback, which works no matter which cookie store iOS
uses:

1. The PWA calls `POST /api/auth/pending` and gets back a one-time ID.
2. The PWA opens Cognito with that ID carried in `state`.
3. The callback marks the ID as complete.
4. The PWA polls `GET /api/auth/pending/:id` and receives its session in its
   own context.

Build this only if the device check fails.

## Before starting

- This file is untracked in the main checkout. Copy it into the worktree
  and commit it with the PR.
- Run `gh pr list` and make sure no open PR touches `server/src/auth`,
  `src/auth`, `infra/terraform/media` or `infra/terraform/release`. The
  PostgreSQL issues #504 and #505 touch the last two.
- Create the worktree from `origin/dev`, run `npm ci`, and follow
  `skills/ship-issues/SKILL.md`.

## Done when

1. Hosted dev:
   - The Managed Login page loads with Warm Glass branding (agent opens it
     and takes a screenshot; no credentials typed).
   - Two accounts made through Developer sign-in complete create group →
     invite → join, and an outsider is denied.
   - Sign-out from a Cognito session returns to Cognito-required sign-in.
2. Locally: `make run-real` and the LAN preview work exactly as before.
   `npm run test:fast` passes, plus the new OIDC tests. Run
   `npm run test:slow`, because the entry and routing screens change.
3. The release configuration refuses `REWIND_AUTH_PASSWORD=true`; a focused
   test covers this.
4. The PR is merged to `dev` and #363 and #364 are closed with a link to it.
   The owner has been asked for one Cognito sign-in on hosted dev in a
   desktop browser and the iPhone check.
