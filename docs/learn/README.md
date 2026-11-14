# Learn Rewind, layer by layer

Two pages to open in a browser:

- [index.html](index.html): product-level overview (L1 to L5, decisions and limits).
- [technical.html](technical.html): how it works inside (HTTP, auth, database, job queue, media, SSE, client, PWA, CI, tests, risks).

| Level     | Question it answers                                                 |
| --------- | ------------------------------------------------------------------- |
| L1        | What does the app do?                                               |
| L2        | What runs where? (CloudFront, nginx, Node, PostgreSQL, S3, Cognito) |
| L3        | What happens to one clip, from capture to film?                     |
| L4        | Where is the code? (client and server folders)                      |
| L5        | How does a merged PR reach the server?                              |
| Decisions | Why these choices, and what they cost                               |

Locally the server uses SQLite and disk media instead of PostgreSQL and S3.

Authoritative references:

- [Current system](../architecture/current-system.md)
- [Delivery and verification](../architecture/delivery-and-verification.md)
- [Architecture guardrails](../architecture/architecture-guardrails.md)
- [Domain contracts](../domain/contracts.md) and [glossary](../domain/glossary.md)
- [Deploy README](../../deploy/README.md) and [Terraform README](../../infra/terraform/README.md)

Items marked "(inferred)" in the pages are a reading of the code, not stated in a doc.
