# Rewind

Rewind is a SWE5006 group project. A small group collects photos and short
videos through a cycle. Contributions stay sealed until the reveal, then the
server builds a film the group watches together. Released films are kept in
Archive. Members also get group chat and web-push reminders.

- **Clients:** a web app that also runs as an installed iPhone Home Screen PWA.
  Android has a test APK. Compiled native iOS is out of scope.
- **Server:** one Node application with ffmpeg media processing.
- **Hosted:** Amazon Lightsail behind CloudFront, managed PostgreSQL, private S3
  media and Amazon Cognito sign-in. Merges to `dev` deploy to hosted dev
  automatically. Release is deployed from `main`.
- **Local:** SQLite and disk media, with a password "Developer sign-in".

Hosted dev: [https://d2m6kz76y4kuvm.cloudfront.net](https://d2m6kz76y4kuvm.cloudfront.net)
(HTTPS is needed for iPhone camera capture, PWA install and web push).

## Run it locally

Needs the Node version in `.nvmrc` (run `nvm use`), npm 10 or newer, `ffmpeg`
and a Chromium-based browser.

```sh
npm ci
make run          # alias of make run-real
```

`make run` runs `scripts/run-real-local.mjs`: the server (SQLite in
`.local-data/real`) and the Expo web app behind one same-origin proxy. Open
`http://localhost:8090`, create an account and sign in. New groups use
10-minute cycles so reveal and Archive can be tried quickly. Use a browser on the
same machine; plain-HTTP sign-in works on localhost only. Press Ctrl-C to stop.
Use non-sensitive test media only.

## Test

```sh
npm run test:fast         # unit, server and client tests (the PR gate)
npm run check             # format, lint, architecture, types, tests, a11y
npm run test:slow         # web export, routing, PWA, e2e (before a main promotion)
make test-postgres        # server suite on a disposable PostgreSQL 17
```

Diagnose one file with `npm run test:focused -- server server/tests/<file>.test.mjs`
(also `frontend` and `root`).

## Documentation

- [Documentation index](doc/README.md): product, design, delivery and process.
- [Current system architecture](docs/architecture/current-system.md)
- [Delivery and verification](docs/architecture/delivery-and-verification.md)
- [Learn Rewind](docs/learn/README.md): browser-friendly explainer pages.
- [Hosted deployment, backup and recovery](deploy/README.md)
- [Terraform and AWS](infra/terraform/README.md)
- [Working agreement](AGENTS.md)
