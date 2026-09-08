# Sprint evidence

Evidence is committed under `evidence/issues/<issue-number>/` using synthetic,
non-sensitive data only.

## Naming convention

- `completion.md` — acceptance checklist, commands, limitations, and links.
- `*.png` or `*.jpg` — synthetic UI screenshot named for the route/state,
  for example `start-shell.png` or `loading-state.png`.
- `*.txt` — short command output or manual verification notes.
- `*.json` — machine-readable check output only when it contains no secrets or
  personal data.

Use lowercase kebab-case names. Do not commit private media, credentials,
tokens, `.env` files, dependency directories, Expo build output, or screenshots
containing personal information.

Every issue's `completion.md` should link the relevant commit/PR and record
which acceptance criteria were checked, which commands ran, and any residual
limitations. Screenshots support visible-state evidence; they do not replace
keyboard/focus, screen-reader, or device checks.
