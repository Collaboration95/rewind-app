# Archive and delivery analysis and design models

**Code baseline:** [accepted `dev` snapshot `1128b6a68985cf68215beb4a7a80fd00ec4242fa`](https://github.com/Collaboration95/rewind-app/commit/1128b6a68985cf68215beb4a7a80fd00ec4242fa). Analysis classes express user and domain responsibilities. Design classes identify only code-backed modules and boundaries. The figure set includes 6 use-case classes, 18 paired flow sequences and 4 pattern-comparison diagrams.

## UC12 — Premiere and released archive

### Analysis class diagram

![UC12 analysis classes](diagrams/uc12-analysis-class.svg)

### Design class diagram

![UC12 design classes](diagrams/uc12-design-class.svg)

### UC12-F1 — Inspect premiere and archive state

**Analysis sequence**

![UC12-F1 analysis sequence](diagrams/uc12-f1-analysis-sequence.svg)

**Design sequence**

![UC12-F1 design sequence](diagrams/uc12-f1-design-sequence.svg)

### UC12-F2 — Start or resume premiere playback

**Analysis sequence**

![UC12-F2 analysis sequence](diagrams/uc12-f2-analysis-sequence.svg)

**Design sequence**

![UC12-F2 design sequence](diagrams/uc12-f2-design-sequence.svg)

### UC12-F3 — Browse and page released archive

**Analysis sequence**

![UC12-F3 analysis sequence](diagrams/uc12-f3-analysis-sequence.svg)

**Design sequence**

![UC12-F3 design sequence](diagrams/uc12-f3-design-sequence.svg)

## UC13 — Own clip and group film download

### Analysis class diagram

![UC13 analysis classes](diagrams/uc13-analysis-class.svg)

### Design class diagram

![UC13 design classes](diagrams/uc13-design-class.svg)

### UC13-F1 — Download my released clip

**Analysis sequence**

![UC13-F1 analysis sequence](diagrams/uc13-f1-analysis-sequence.svg)

**Design sequence**

![UC13-F1 design sequence](diagrams/uc13-f1-design-sequence.svg)

### UC13-F2 — Download a released group film

**Analysis sequence**

![UC13-F2 analysis sequence](diagrams/uc13-f2-analysis-sequence.svg)

**Design sequence**

![UC13-F2 design sequence](diagrams/uc13-f2-design-sequence.svg)

## UC14 — Install, update and invitation links

### Analysis class diagram

![UC14 analysis classes](diagrams/uc14-analysis-class.svg)

### Design class diagram

![UC14 design classes](diagrams/uc14-design-class.svg)

### UC14-F1 — Install and open the web/PWA shell

**Analysis sequence**

![UC14-F1 analysis sequence](diagrams/uc14-f1-analysis-sequence.svg)

**Design sequence**

![UC14-F1 design sequence](diagrams/uc14-f1-design-sequence.svg)

### UC14-F2 — Apply a web/PWA shell update

**Analysis sequence**

![UC14-F2 analysis sequence](diagrams/uc14-f2-analysis-sequence.svg)

**Design sequence**

![UC14-F2 design sequence](diagrams/uc14-f2-design-sequence.svg)

### UC14-F3 — Create and open a cross-client invitation link

**Analysis sequence**

![UC14-F3 analysis sequence](diagrams/uc14-f3-analysis-sequence.svg)

**Design sequence**

![UC14-F3 design sequence](diagrams/uc14-f3-design-sequence.svg)

### UC14-F4 — Accept invite after opening/authentication

**Analysis sequence**

![UC14-F4 analysis sequence](diagrams/uc14-f4-analysis-sequence.svg)

**Design sequence**

![UC14-F4 design sequence](diagrams/uc14-f4-design-sequence.svg)

## Pattern comparison figures

### Before — alternative class structure

![Before pattern class diagram](diagrams/problem-before-class.svg)

### Before — alternative sequence

![Before pattern sequence diagram](diagrams/problem-before-sequence.svg)

### After — implementation class structure

![After pattern class diagram](diagrams/problem-after-class.svg)

### After — implementation sequence

![After pattern sequence diagram](diagrams/problem-after-sequence.svg)

The “before” views are explicit comparison models only, not claims about historical source. The “after” views correspond to implementation choices discussed in [design-problem.md](design-problem.md). The complete source/requirement crosswalk and remaining evidence boundaries are in [README.md](README.md).
