# Issue #3 evidence — runnable delivery foundation

Status: local verification passed; independent second-machine and CI checks
remain pending until review.

## Acceptance evidence

- [x] A clean local install completed with `npm install` and generated a
      committed lockfile; the documented clean path uses `npm ci`.
- [x] The README documents one Node.js/npm + Expo web setup path and states
      that AWS credentials, accounts, and private media are not required.
- [x] `package.json` provides `lint`, `typecheck`, `test`, `check`, and web
      export/startup commands.
- [x] `.github/workflows/quality.yml` runs `npm ci` and `npm run check` for
      pushes to `main` and pull requests.
- [x] The scaffold smoke and component tests cover app identity, baseline
      scripts, workflow wiring, the accessible title, and the honest Local demo
      status.
- [x] `npm run build:web` exported the Expo web bundle successfully.
- [x] `npm run web -- --non-interactive` served the app at
      `http://localhost:8081`; the curl probe returned an HTML document titled
      `Rewind`. See [`startup.txt`](startup.txt).

## Pending independent verification

- [ ] A second supported machine runs the README clean-start path.
- [ ] The GitHub Actions run for the pull request is green.

The pending checks require another environment or GitHub's hosted runner and
are left visible rather than represented as local proof.

## Dependency audit note

`npm audit --omit=dev --audit-level=moderate` reports ten moderate transitive
`uuid` findings through Expo's build/configuration toolchain. `npm audit fix
--force` proposes a breaking Expo downgrade, so it was not applied. This is a
known foundation risk to review before production delivery; it is outside the
Sprint 0 baseline acceptance criteria and does not affect the exported web
bundle check.
