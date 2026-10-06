# Learn Rewind, layer by layer

Two pages, open in a browser:

- [technical.html](technical.html): **how it works inside** (HTTP, auth, SQLite, job queue, media, SSE, client, PWA, CI, tests, risks)
- [index.html](index.html): product-level overview (L1–L5 + tradeoffs)

The table below is for `index.html`.

| Level     | Question it answers                                        |
| --------- | ---------------------------------------------------------- |
| L1        | What does the app do?                                      |
| L2        | What runs where? (CloudFront → nginx → Node + SQLite + S3) |
| L3        | What happens to one clip, from capture to film?            |
| L4        | Where is the code? (client vs server folders)              |
| L5        | How does a merged PR reach the server?                     |
| Tradeoffs | Why these choices, and what they cost                      |

Deeper reading already in the repo:

- [ADR-0001](../architecture/ADR-0001-local-first-sprint-0.md): client/domain/adapter boundary
- [Architecture guardrails](../architecture/architecture-guardrails.md)
- [Domain contracts](../domain/contracts.md) and [glossary](../domain/glossary.md)
- [Terraform README](../../infra/terraform/README.md)
- [Deploy README](../../deploy/README.md)

Items marked "(inferred)" in the page are my reading of the code, not stated in a doc.
