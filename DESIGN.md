---
version: alpha
name: 'Rewind'
description: 'A quiet darkroom for shared moments that stay sealed until a group reveal.'
colors:
  primary: '#FFA572'
  background: '#252326'
  deep: '#1D1B1E'
  paper: '#302D30'
  ink: '#F9EBD5'
  muted: '#B9ABA0'
  edge: '#BBA270'
  accent: '#FFA572'
  line: '#51474A'
typography:
  sans:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
  mono:
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
rounded:
  DEFAULT: '0.5rem'
  sm: '0.375rem'
  md: '0.625rem'
  lg: '1.25rem'
spacing:
  page: '1.5rem'
  section: '1.125rem'
  panel: '1rem'
components:
  card:
    backgroundColor: 'colors.paper'
    textColor: 'colors.ink'
    rounded: 'rounded.md'
    padding: 'spacing.panel'
  navigation:
    backgroundColor: 'colors.background'
    textColor: 'colors.muted'
  locked:
    backgroundColor: 'colors.deep'
    textColor: 'colors.ink'
    rounded: 'rounded.md'
    padding: 'spacing.panel'
---

# Rewind Design System

## Overview

### Creative North Star

Rewind should feel like a small darkroom notebook: warm paper-like panels sit
inside a charcoal frame, while a single apricot accent marks the moments that
are still alive. The interface is a product surface first—calm, legible, and
honest about what is sealed—rather than a social feed or a media gallery.

### Product context and register

- **Audience and primary job:** A group member checking the current prompt,
  cycle countdown, and their remaining contribution allowance.
- **Target market(s) and evidence:** English-language SWE5006 prototype; the
  repository ADR defines a local-first Sprint 0 boundary.
- **Locale(s) and language policy:** English only for Sprint 0; use plain
  sentence-case copy and retain accessible text alongside visual status.
- **Usage scene:** Frequent phone checks and small browser windows; content must
  reflow without hiding the bottom navigation or status text.
- **Register:** Product UI with restrained brand expression.
- **Memorable signature:** A sealed-state card uses warm outlined rules and
  explicit words to make delayed reveal feel tangible without showing media.
- **Restraint:** Keep panels, labels, and navigation quiet; do not simulate
  recording, playback, chat, or authentication.
- **Anti-references:** Avoid generic bright dashboard gradients, image-first
  social feeds, and glossy media-player chrome because those imply capabilities
  this Sprint 0 increment does not provide.
- **Token ownership/runtime mapping:** The existing React Native `COLORS`
  object in `src/theme.ts` remains the runtime source; this file mirrors those
  exact values and documents their semantic roles. A future token extraction
  should update both surfaces together.

## Colors

`deep` frames the app and safe areas; `background` is the working surface;
`paper` creates quiet information panels; `ink` is primary copy; `muted` is
supporting copy; `edge` labels sealed or secondary information; `accent` marks
focus and active navigation; and `line` separates regions. Status must always
include text, not rely on the accent or border color alone.

## Typography

The system sans stack keeps native text metrics stable on Expo web and iOS.
Large screen titles use weight and scale for hierarchy; labels are compact,
tracked, and uppercase only when they identify a region. Countdown and quota
values use the same sans stack with explicit accessible prose so numeric styling
never becomes the only way to understand state.

## Layout

The app uses a centered phone-width frame (`390px` maximum) with a `24px` page
inset, an `18px` section rhythm, and a bottom navigation surface that remains
inside the safe area. Content owns the vertical scroll; panels wrap rather than
truncate important values. Larger text increases block height naturally.

## Elevation & Depth

Hierarchy comes from tonal layers and one-pixel rules, not shadows. `paper`
panels sit above the `background`; the outer `deep` frame protects safe areas.
Do not add blur, gradients, or media thumbnails to the sealed-state surface.

## Shapes

Panels use a modest `md` radius; the profile picker uses the existing larger
`lg` radius as its distinct local-demo card. Dashed outlines are reserved for
sealed placeholders. Dividers use `line`, and focus uses the visible `accent`
edge rather than color-only changes.

## Components

### Foundational visual states

Loading reserves the capsule panel footprint and uses an app-owned text status.
Empty, denied, and recoverable-error states keep the same panel geometry. Focus
is visible, disabled controls are not actionable, and locked state is always
written in text.

### Buttons and actions

The current Sprint 0 shell uses outlined controls and a disabled `Add a moment`
placeholder. No capsule action exposes media or sharing. Retry is a neutral,
text-labelled button with a stable size.

### Navigation and data display

The bottom tab bar is the canonical navigation surface. Capsule data is shown
as stacked panels: group identity, current prompt/countdown, quota, and sealed
state. Values wrap on narrow screens and remain available to assistive tech.

### Forms and overlays

The local group form uses the same quiet paper panels as capsule data, with
apricot focus/error edges and readable counters for bounded name/prompt input.
Prompt choices are outlined native pressable rows; a custom prompt expands
inside the panel without changing the page frame. The reset confirmation is an
app-owned compact modal: warm paper surface, deep backdrop, benign cancel
action first, and an explicit local-demo-data scope. Future capture and
permission flows must establish their own contract before they are added.

### Iconography

The current shell has no icon dependency. Text labels remain mandatory for
navigation and locked status until an icon family is intentionally introduced.

### Motion

The countdown may update once per second because time is the content. Other
transitions are immediate; no decorative animation is needed. Reduced-motion
settings must not remove the textual countdown or state announcement.

### Content and data visualization

Copy is direct and reassuring: say what is available, what is sealed, and what
the member can do next. Quota values use explicit units (`contributions`,
`seconds`) and never expose private media metadata before reveal.

## Do's and Don'ts

- **Do:** Derive group, prompt, countdown, and quota from the domain boundary.
- **Do:** Pair every color/state treatment with readable text.
- **Don't:** Add preview images, media URIs, players, or share controls while a
  cycle is locked.
- **Don't:** Make a local fixture look like authentication or private account
  state.
