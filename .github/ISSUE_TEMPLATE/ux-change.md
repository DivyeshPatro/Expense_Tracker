---
name: UX change
about: Any change to what a user sees or does. Must be measurable before it is built.
title: ""
labels: enhancement
---

<!--
No issue gets implemented until these four are filled in.
"Before" must be a measured value, not an impression — go and measure it.
-->

### Why
<!-- What user problem does this solve? One or two sentences. -->

### Before
<!-- The current experience, as a number. e.g. "41 card containers, 2.01 screens of scroll" -->

### After
<!-- The desired experience, as a number. e.g. "8 visible sections" -->

### Success metric
<!-- How we know it worked. e.g. "Users find their balance within 2 seconds" -->

---

<details>
<summary>How we measure success on this project</summary>

We do **not** measure progress by commits, PRs, or issues closed. Those are
activity, not outcomes. Measure what users actually feel:

| Metric | How to capture |
|---|---|
| Scroll reduction | `document.documentElement.scrollHeight / innerHeight` — "screens of content" |
| Tap reduction | Count taps for the task, excluding typing |
| Time to complete task | Stopwatch a real run at 390px |
| Information density | Count of card containers + chips on screen |
| First meaningful paint | `performance.getEntriesByType('paint')` |
| Time to first action | Open → first interactive tap |
| Time to find information | Open → the answer is on screen |

Measure at **390×844** unless the change is desktop-specific, and record the
number in the issue before closing it.

</details>
