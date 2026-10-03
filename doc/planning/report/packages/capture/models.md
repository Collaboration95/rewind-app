# UC04–UC06 analysis and design models

**Evidence cut:** accepted dev commit [`fc2b8c811e9c13b176113fa0bdb2c015798990b4`](https://github.com/Collaboration95/rewind-app/commit/fc2b8c811e9c13b176113fa0bdb2c015798990b4). Analysis figures show responsibilities in the problem domain. Design figures name components evidenced by the pinned code. Sequence alternate panels correspond to the exception lists in [use-cases.md](use-cases.md).

## UC04 — Video capture and submission

### Analysis class diagram
![UC04 analysis classes](diagrams/uc04-analysis-class.svg)

### Design class diagram
![UC04 design classes](diagrams/uc04-design-class.svg)

#### UC04-F1 — Acquire access and record
**Analysis sequence**
![UC04-F1 analysis sequence](diagrams/uc04-f1-analysis-sequence.svg)

**Design sequence**
![UC04-F1 design sequence](diagrams/uc04-f1-design-sequence.svg)

#### UC04-F2 — Review, trim, choose mode or retake
**Analysis sequence**
![UC04-F2 analysis sequence](diagrams/uc04-f2-analysis-sequence.svg)

**Design sequence**
![UC04-F2 design sequence](diagrams/uc04-f2-design-sequence.svg)

#### UC04-F3 — Transfer, accept and process video
**Analysis sequence**
![UC04-F3 analysis sequence](diagrams/uc04-f3-analysis-sequence.svg)

**Design sequence**
![UC04-F3 design sequence](diagrams/uc04-f3-design-sequence.svg)

## UC05 — Photo contribution

### Analysis class diagram
![UC05 analysis classes](diagrams/uc05-analysis-class.svg)

### Design class diagram
![UC05 design classes](diagrams/uc05-design-class.svg)

#### UC05-F1 — Capture and review a photo
**Analysis sequence**
![UC05-F1 analysis sequence](diagrams/uc05-f1-analysis-sequence.svg)

**Design sequence**
![UC05-F1 design sequence](diagrams/uc05-f1-design-sequence.svg)

#### UC05-F2 — Transfer, accept and process a photo
**Analysis sequence**
![UC05-F2 analysis sequence](diagrams/uc05-f2-analysis-sequence.svg)

**Design sequence**
![UC05-F2 design sequence](diagrams/uc05-f2-design-sequence.svg)

## UC06 — Allowance and correction

### Analysis class diagram
![UC06 analysis classes](diagrams/uc06-analysis-class.svg)

### Design class diagram
![UC06 design classes](diagrams/uc06-design-class.svg)

#### UC06-F1 — Read allowance and reserve contribution
**Analysis sequence**
![UC06-F1 analysis sequence](diagrams/uc06-f1-analysis-sequence.svg)

**Design sequence**
![UC06-F1 design sequence](diagrams/uc06-f1-design-sequence.svg)

#### UC06-F2 — Delete and replace once
**Analysis sequence**
![UC06-F2 analysis sequence](diagrams/uc06-f2-analysis-sequence.svg)

**Design sequence**
![UC06-F2 design sequence](diagrams/uc06-f2-design-sequence.svg)

## Code trace

- Capture permissions, recording, mode/trim review and local lifecycle: [VideoCaptureScreen](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/VideoCaptureScreen.tsx#L562), [ClipReviewSession](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/video-review.ts#L124), [CameraPlatform interface](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/contracts.ts#L76).
- Real-group route selection and direct transfer: [media config and selected mode](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/groups/RealAccountGroupExperience.tsx#L360), [runtime client](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/real-account-video-runtime.ts#L46), [intent transfer workflow](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/direct-transfer.ts#L337).
- Still capture and managed-file lifecycle: [CameraCaptureScreen](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/CameraCaptureScreen.tsx#L144), [StillImageCaptureSession](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/still-image-session.ts#L48), [file stores](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/src/capture/file-store.ts#L96).
- Allowance and correction: [quota operations](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/contributions/index.ts#L77), [one delete transaction](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/contributions/index.ts#L240), [replacement linkage](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/contributions/ledger.ts#L575).
- Worker behavior: [FFmpeg clip/photo processing](https://github.com/Collaboration95/rewind-app/blob/fc2b8c811e9c13b176113fa0bdb2c015798990b4/server/src/ffmpeg.ts#L206).

These diagrams are report models, not implementation tasks. No class or interface is proposed for the deferred pre-upload retro pipeline.
