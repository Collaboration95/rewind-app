# Rewind analysis and design models

These reusable models describe source revision
`40ebeb5673d103b4b6950d095192aae744980769` (remote `dev`, checked with
authenticated `gh` on 15 October 2026). They support implementation discussion
and maintenance. They are independent of final-report assembly.

## Model catalogue

| Area                                              | Use cases and design problems                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Identity](identity.md)                           | Managed Login, developer sign-in, groups, invitations, account deletion and membership authority |
| [Capture](capture.md)                             | Photo/video contribution, local preview, sealed upload and storage integrity                     |
| [Lifecycle](lifecycle.md)                         | Cycle boundaries, compilation, verified publication and Archive                                  |
| [Interactions](interactions.md)                   | Chat, prompts, reminder preferences, web-push subscription and dispatch                          |
| [Playback](playback.md)                           | Authorized film viewing, Archive, own-clip downloads and expiring media access                   |
| [Transition strategies](transition-strategies.md) | Cross-domain analysis-to-design mapping and evidence-based pattern classification                |

Each domain document contains the following editable views:

1. Use-case intent, normal outcome and major exception branches.
2. Analysis class and sequence diagrams: domain concepts and responsibilities.
3. Design class and sequence diagrams: actual modules, functions, interfaces,
   persisted records and external boundaries.
4. A design problem, illustrative before class/sequence diagrams, alternatives,
   justified choice and after class/sequence diagrams.
5. Source/test mapping and limits on what static inspection proves.

The before views are rejected conceptual baselines. They do not claim an earlier
version of Rewind used that architecture. A diagram labelled `module` represents
functional code; it does not imply a runtime class exists. Analysis entities may
map to database rows or TypeScript values rather than domain-object instances.
Mermaid `alt` blocks describe exceptions within the same use case.

## Canonical use-case crosswalk

This cross-document join was checked at `dev` revision
`39ba152af0da152ff8e0efe08be861270752129e` on 15 October 2026. The
[product baseline](../../doc/planning/current-product-baseline.md#use-case-contracts)
and domain models retain their own source revision above. Canonical semantic IDs
and domain-local IDs are different namespaces; for example, lifecycle UC-01 and
playback UC-01 are different entries. Each row names its domain. Class views are
static; sequence views are dynamic. Reused views cover shared responsibilities,
not additional independent diagrams.

| Canonical use case                                                                                | Detailed entries                                                                                                                                            | Analysis: class; sequence                                                                                                                       | Design: class; sequence                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [UC-SIGN-IN](../../doc/planning/current-product-baseline.md#uc-sign-in)                           | Identity [UC-I1–I3](identity.md#scope-and-use-cases)                                                                                                        | [IA-C1](identity.md#ia-c1); [IA-S1](identity.md#ia-s1)                                                                                          | [ID-C1](identity.md#id-c1); [ID-S1](identity.md#id-s1), [ID-S2](identity.md#id-s2)                                                                                                                                                                                   |
| [UC-CREATE-GROUP](../../doc/planning/current-product-baseline.md#uc-create-group)                 | Identity [UC-I4](identity.md#scope-and-use-cases)                                                                                                           | [IA-C1](identity.md#ia-c1); [IA-S2](identity.md#ia-s2)                                                                                          | [ID-C2](identity.md#id-c2); [ID-S3](identity.md#id-s3)                                                                                                                                                                                                               |
| [UC-SELECT-GROUP](../../doc/planning/current-product-baseline.md#uc-select-group)                 | Identity [UC-I5](identity.md#scope-and-use-cases)                                                                                                           | [IA-C1](identity.md#ia-c1); [IA-S2](identity.md#ia-s2)                                                                                          | [ID-C2](identity.md#id-c2); [ID-S3](identity.md#id-s3)                                                                                                                                                                                                               |
| [UC-INVITE-MEMBER](../../doc/planning/current-product-baseline.md#uc-invite-member)               | Identity [UC-I6](identity.md#scope-and-use-cases)                                                                                                           | [IA-C1](identity.md#ia-c1); [IA-S3](identity.md#ia-s3)                                                                                          | [ID-C2](identity.md#id-c2); [ID-S4](identity.md#id-s4)                                                                                                                                                                                                               |
| [UC-JOIN-GROUP](../../doc/planning/current-product-baseline.md#uc-join-group)                     | Identity [UC-I7](identity.md#scope-and-use-cases)                                                                                                           | [IA-C1](identity.md#ia-c1); [IA-S3](identity.md#ia-s3)                                                                                          | [ID-C2](identity.md#id-c2); [ID-S4](identity.md#id-s4)                                                                                                                                                                                                               |
| [UC-CONFIGURE-GROUP](../../doc/planning/current-product-baseline.md#uc-configure-group)           | Identity [UC-I8](identity.md#scope-and-use-cases); interactions [UC-04](interactions.md#scope-and-use-cases)                                                | [IA-C1](identity.md#ia-c1); [IA-S4](identity.md#ia-s4)                                                                                          | [ID-C2](identity.md#id-c2); [ID-S5](identity.md#id-s5); prompt/timezone UI: [D-PROMPT](interactions.md#d-prompt), [D-SETTINGS-FLOW](interactions.md#d-settings-flow)                                                                                                 |
| [UC-CONTRIBUTE](../../doc/planning/current-product-baseline.md#uc-contribute)                     | Capture [UC-1–5](capture.md#scope-and-use-cases)                                                                                                            | [CAP-A1](capture.md#cap-a1); [CAP-A2](capture.md#cap-a2), [CAP-A3](capture.md#cap-a3), [CAP-A4](capture.md#cap-a4), [CAP-A5](capture.md#cap-a5) | [CAP-D1](capture.md#cap-d1), [CAP-D7](capture.md#cap-d7); [CAP-D2](capture.md#cap-d2), [CAP-D3](capture.md#cap-d3), [CAP-D4](capture.md#cap-d4), [CAP-D5](capture.md#cap-d5), [CAP-D6](capture.md#cap-d6)                                                            |
| [UC-CORRECT-CONTRIBUTION](../../doc/planning/current-product-baseline.md#uc-correct-contribution) | Partial: capture [UC-1–5](capture.md#scope-and-use-cases) cover recapture and replacement ID propagation, not deletion eligibility or allowance restoration | Recapture views above; deletion model missing                                                                                                   | Recapture views above; deletion transaction model missing                                                                                                                                                                                                            |
| [UC-RELEASE-CYCLE](../../doc/planning/current-product-baseline.md#uc-release-cycle)               | Lifecycle [UC-01–04](lifecycle.md#scope-and-use-cases)                                                                                                      | [A-C1](lifecycle.md#a-c1); [A-S1](lifecycle.md#a-s1), [A-S2](lifecycle.md#a-s2), [A-S3](lifecycle.md#a-s3)                                      | [D-C1](lifecycle.md#d-c1); [D-S1](lifecycle.md#d-s1), [D-S2](lifecycle.md#d-s2), [D-S3](lifecycle.md#d-s3)                                                                                                                                                           |
| [UC-VIEW-ARCHIVE](../../doc/planning/current-product-baseline.md#uc-view-archive)                 | Lifecycle [UC-05](lifecycle.md#scope-and-use-cases); playback [UC-01–02, UC-05](playback.md#scope-and-use-cases)                                            | [AC-01](playback.md#ac-01); [AS-01](playback.md#as-01), [AS-02](playback.md#as-02)                                                              | [DC-01](playback.md#dc-01); [DS-01](playback.md#ds-01), [DS-02](playback.md#ds-02), [DS-03](playback.md#ds-03); lifecycle eligibility: [A-C1](lifecycle.md#a-c1), [A-S4](lifecycle.md#a-s4), [D-C1](lifecycle.md#d-c1), [D-S4](lifecycle.md#d-s4)                    |
| [UC-DOWNLOAD](../../doc/planning/current-product-baseline.md#uc-download)                         | Playback [UC-03–05](playback.md#scope-and-use-cases)                                                                                                        | [AC-01](playback.md#ac-01); [AS-03](playback.md#as-03), [AS-02](playback.md#as-02)                                                              | [DC-01](playback.md#dc-01); [DS-02](playback.md#ds-02), [DS-04](playback.md#ds-04)                                                                                                                                                                                   |
| [UC-CHAT](../../doc/planning/current-product-baseline.md#uc-chat)                                 | Interactions [UC-01–03](interactions.md#scope-and-use-cases)                                                                                                | [A-CLASS](interactions.md#a-class); [A-CHAT](interactions.md#a-chat)                                                                            | [D-CHAT-CLASS](interactions.md#d-chat-class); [D-CHAT-READ](interactions.md#d-chat-read), [D-CHAT-WRITE](interactions.md#d-chat-write)                                                                                                                               |
| [UC-MANAGE-REMINDERS](../../doc/planning/current-product-baseline.md#uc-manage-reminders)         | Interactions [UC-06–09](interactions.md#scope-and-use-cases)                                                                                                | [A-CLASS](interactions.md#a-class); [A-REMINDER](interactions.md#a-reminder), [A-OPEN](interactions.md#a-open)                                  | [D-PROMPT](interactions.md#d-prompt), [D-REMINDER-CLASS](interactions.md#d-reminder-class); [D-SETTINGS-FLOW](interactions.md#d-settings-flow), [D-REGISTER](interactions.md#d-register), [D-DISPATCH](interactions.md#d-dispatch), [D-OPEN](interactions.md#d-open) |
| [UC-INSTALL-PWA](../../doc/planning/current-product-baseline.md#uc-install-pwa)                   | No detailed installation entry in these model packages                                                                                                      | Installation model missing                                                                                                                      | Installation/service-worker lifecycle model missing                                                                                                                                                                                                                  |
| [UC-MANAGE-SAFETY](../../doc/planning/current-product-baseline.md#uc-manage-safety)               | No detailed report/block/owner-removal entry in these model packages                                                                                        | Safety model missing                                                                                                                            | Safety authorization/mutation model missing                                                                                                                                                                                                                          |
| [UC-DELETE-ACCOUNT](../../doc/planning/current-product-baseline.md#uc-delete-account)             | Identity [UC-I9](identity.md#scope-and-use-cases)                                                                                                           | [IA-C1](identity.md#ia-c1); [IA-S5](identity.md#ia-s5)                                                                                          | [ID-C3](identity.md#id-c3); [ID-S6](identity.md#id-s6)                                                                                                                                                                                                               |
| [UC-INSPECT-OPERATIONS](../../doc/planning/current-product-baseline.md#uc-inspect-operations)     | No detailed operator inspection entry; lifecycle worker recovery and reminder dispatch are related internal flows                                           | Operator inspection model missing                                                                                                               | Health/diagnostic/snapshot flow model missing                                                                                                                                                                                                                        |

These four coverage gaps concern documentation, not an assertion that the product
features are absent. The baseline supplies their contracts and source references.
Correction still needs the original-window, one-deletion and quota/tombstone flow;
installation needs browser/OS and service-worker boundaries; safety needs report,
block and owner-removal authorization; operator inspection needs the safe
health/diagnostic/snapshot path. This crosswalk records the gaps without expanding
the domain packages or treating related internal flows as complete coverage.

## Coverage and attribution registry

| Model area   | UC/problem coverage                                                                                                | Implementation evidence         | Confirmed human ownership |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ------------------------- |
| Identity     | [UC-I1–I9](identity.md#scope-and-use-cases); [design problem](identity.md#design-problem-and-alternatives)         | Linked current source and tests | Awaiting member facts     |
| Capture      | [UC-1–5](capture.md#scope-and-use-cases); [design problem](capture.md#design-problem-and-alternatives)             | Linked current source and tests | Awaiting member facts     |
| Lifecycle    | [UC-01–05](lifecycle.md#scope-and-use-cases); [design problem](lifecycle.md#design-problem-and-alternatives)       | Linked current source and tests | Awaiting member facts     |
| Interactions | [UC-01–09](interactions.md#scope-and-use-cases); [design problem](interactions.md#design-problem-and-alternatives) | Linked current source and tests | Awaiting member facts     |
| Playback     | [UC-01–05](playback.md#scope-and-use-cases); [design problem](playback.md#design-problem-and-alternatives)         | Linked current source and tests | Awaiting member facts     |

Confirmed: the code mappings describe responsibilities in the inspected revision.
Unconfirmed: which team member owns or contributed each UC and design problem.
Source authorship alone does not establish design ownership. This registry therefore
does **not** assert that every member has a confirmed UC/problem assignment.
To establish that requirement, record a member-confirmed UC ID, design-problem
heading and supporting contribution reference for each member. No names, hours,
equal work split or ceremony participation are inferred here.

## Reading and verification

Start with the analysis views for product behaviour, then follow the corresponding
design flow and source symbols. Exceptions are part of the contract: denied
membership, expired sessions/capabilities, interrupted uploads, quota rejection,
worker failures and provider acceptance without device-delivery proof.

The product is the real-account web/PWA application; photo and video remain in
scope. Native iOS distribution and extending native push are outside scope.
Hosted storage uses S3; local runs use disk. The retained `local` object-store
adapter is represented only where existing interfaces require explanation.

Static models do not prove hosted deployment, Cognito account journeys, camera
hardware operation or notification delivery. Linked tests are verification
locations, not claims that they ran during documentation authoring. The batch
verification worker owns the unchanged application's current `test:fast` result.
Markdown formatting, link/source checks, Mermaid rendering and the independent
review are reported in the documentation PR.
