# Rewind analysis and design models

These reusable models describe source revision
`40ebeb5673d103b4b6950d095192aae744980769` (remote `dev`, checked with
authenticated `gh` on 15 October 2026). They support implementation discussion
and maintenance. They are independent of final-report assembly.

## Model catalogue

| Area                                              | Use cases and design problems                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| [Identity](identity.md)                           | Managed Login, developer sign-in, groups, invitations and membership authority    |
| [Capture](capture.md)                             | Photo/video contribution, local preview, sealed upload and storage integrity      |
| [Lifecycle](lifecycle.md)                         | Cycle boundaries, compilation, verified publication and Archive                   |
| [Interactions](interactions.md)                   | Chat, prompts, reminder preferences, web-push subscription and dispatch           |
| [Playback](playback.md)                           | Authorized film viewing, Archive, own-clip downloads and expiring media access    |
| [Transition strategies](transition-strategies.md) | Cross-domain analysis-to-design mapping and evidence-based pattern classification |

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
