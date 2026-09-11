# Architecture guardrails

`npm run architecture:check` statically verifies the boundaries that are easy
to erode while adding platform features:

- `src/domain` and the pure `server/src/cycles/engine.ts` module may import
  only relative modules, so domain policy remains framework- and
  device-independent. The sibling cycle application service is allowed to
  depend on SQLite and local event persistence.
- `src/routes` and colocated `*.route.*` modules may not import Expo,
  React Native, or device packages directly. Platform capabilities belong in
  adapters behind domain ports.

The command is part of `npm run check` and is covered by
`tests/architecture.test.mjs`, including a temporary-fixture test proving the
rules fail closed. The route directory is optional today; the rule activates
automatically when that layer is introduced.
