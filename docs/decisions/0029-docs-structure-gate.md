# ADR-0029: Gate documentation STRUCTURE, not documentation CLAIMS

- **Status:** Accepted
- **Date:** 2026-08-04
- **Requirements:** N-1 (verification posture); answers the GATE PROPOSAL in
  issue #61, which stays OPEN

## Context

Every gate in this repo checks code. Nothing checked the documentation except
`check-links.sh`, which checks link targets, and the documentation is where
this project's stated differentiator lives.

Issue #61 proposed closing that with a **claim** gate: flag lines containing an
absolute quantifier (*only*, *never*, *nowhere*, *every*) unless the line
carries a citation. The motivating evidence was real. Across 2026-07-29 a
review found roughly ten defects in this repo's prose and zero in the code it
described, with the suite green throughout, and every one of those defects
contained a universal quantifier.

That proposal has now been measured twice and it does not work. This ADR
records both measurements and what shipped instead, because "we tried the
obvious thing and it failed" is the load-bearing part.

## Decision

**1. The claim gate is rejected, on measurement rather than on taste.**

The first attempt (2026-07-31, withdrawn) built a 20-defect labelled corpus and
concluded the defect population had no lexical shape. That conclusion was
withdrawn after an adversarial methodology review returned CONCLUSION_UNSAFE on
all three lenses, with 27 findings upheld: recall and noise were scored in
different units, the citation field was hand-assigned on one side and
regex-scored on the other, the class taxonomy was chosen after seeing the data,
the controls were contaminated, and the whole thing was measured over all 3,920
existing lines when issue #61 scopes to added lines only. Every material error
ran in the direction the author preferred. It is preserved unmerged on
`experiment/61-docs-claims-measurement` with a full defect register.

What survived that review was narrow: the rule as specified caught 2 or 3 of 20
defects, and **one unexamined variant looked much better** — a superlative /
uniqueness check (`the only`, `the reason`, `nowhere`, `no other`,
`the single`) with no citation escape hatch, scoring 7.8:1 recall-to-noise
against roughly 1.2:1 for the specified rule, and catching the defect issue #61
itself calls the worst of 2026-07-29.

**The second measurement (2026-08-04) is the first in issue #61's actual scope,
added lines against the merge base, and it kills that variant too:**

| variant | lines fired | % of added lines | **commits blocked** |
| --- | --- | --- | --- |
| full (the 7.8:1 one) | 97 | 0.64% | **24 / 40** |
| drop `the reason` | 87 | 0.57% | **24 / 40** |
| `nowhere\|no other` only | 16 | 0.11% | **9 / 40** |
| `nowhere` only | 13 | 0.09% | **8 / 40** |

Measured over the last 40 docs-touching commits, 15,233 added markdown lines,
**anchored at `9334f18`** (the merge-base for this work). The anchor is stated
because the window is `git log -40`, so re-running it later slides forward and
returns different figures; independently reproduced to the digit at that
anchor, with zero merge commits in the window, so no diff is double-counted.

**Scope sensitivity, since the denominator is dominated by `process/` working
notes** (10,280 of the 15,233 lines) and issue #61 arguably targets `docs/`.
Restricted to `docs/` and README only, **4,693** added lines at that same
anchor: the full variant blocks **21 of 40** commits and the narrowest blocks
**5 of 40**. The decision survives at both scopes, which is why it is recorded
as a kill rather than as a scope-dependent maybe.

**⚠️ These three figures were wrong in the first draft of this paragraph, and
the way they were wrong is the paragraph's own subject.** It quoted 4,775,
22/40 and 6/40, which are the numbers this measurement gives at `c4722e7`
rather than at the anchor the same sentence asserts, because the window is
`git log -40` and HEAD had moved onto the branch. Independently re-derived at
both refs by review and again by hand. The warning about the sliding window was
added in the same edit that violated it.

**The 7.8:1 figure was computed per LINE, and a gate fails per COMMIT.** One
firing line fails the build, so commits-blocked is the unit that decides
viability, and on that unit even the narrowest variant blocks one docs commit
in five. Sampling the firings, they are overwhelmingly true statements:
"`runTelemetryExport` was the only shipped reader", "`sessionId` and `turnId`
are sanitised nowhere on the write path". This repository's prose is emphatic
and its strong claims are usually correct, which is precisely why a syntactic
proxy for "is this absolute supported?" cannot work. Choosing a unit that
flattered the hypothesis is the same error the withdrawn experiment was
reviewed for, reappearing in a new place.

**2. What ships instead: two checks with an actual binary property.**

Issue #61's own status comment set the bar: *"Either find a check with an
actual binary property to test, or accept that this class is caught by
review."* Both of these are binary, and both were derived from defects that
shipped past a fully green suite rather than from imagination.

- **Table structure** (`scripts/check-docs.sh`). A blank line terminates a GFM
  table, so a pipe-leading line after one renders as a paragraph with visible
  pipes. On 2026-08-04 a residual-risk row was added exactly there. The
  commit's entire stated purpose was to add that row to that table; tests,
  lint, typecheck and `check-links` were all green over it, because
  `check-links` checks links. Rule: every run of consecutive pipe-leading lines
  outside a fence must have a delimiter row as its second line.
- **Fence balance**, same script. An unclosed fence swallows the rest of a
  rendered document. This is the documentation-side instance of the failure
  ADR-0028 accepts as residual for skill bodies, and unlike that one it costs
  nothing to check here.
- **Derived constants.** The ADR count is asserted in README in three
  spellings (a range, a bare numeral, a spelled-out word) and all three are
  re-derived from the filesystem (`check-docs.sh`); the test count is
  re-derived by running the suite (`check-test-count.sh`, in the build job
  because it needs one). The README test count drifted on 2026-08-04 because
  two branches each measured themselves alone and one merged beside the other.

  **⚠️ CORRECTION, and it matters because it is this ADR's own subject.** An
  earlier draft said the gate "caught a live instance the moment it was
  written" and the commit message claimed "three live drifts". Adversarial
  review checked it: both gates are GREEN on a clean pre-branch tree, and the
  hand-fix to the test count had already landed before the gate existed. Every
  drift the gate reported was one **this change itself created** by adding
  ADR-0029 and new tests. Real evidence that the checks fire, and no evidence
  at all of pre-existing drift caught in the wild, which is what "live" implied.
  The one thing that genuinely was caught cold is narrower and worth keeping:
  the gate's own blind spot, a bare `28 ADRs` numeral that no check covered
  while the range and spelled-out forms were both checked. One fact with three
  spellings needs three checks.

**3. Both fail the build. Neither warns.**

Issue #61 left this open. Warn-only is the pattern ADR-0015 rejected for shell
runners: a warning that never blocks is a claim of coverage without the
coverage. These two are cheap to satisfy (move a blank line; re-derive a
number), which is what makes failing affordable, and it is the same property
that made the no-em-dash rule survive.

**4. The docs gate is workflow-only, and deliberately absent from
`prepublishOnly`.**

ADR-0022 decision 4 makes the workflow-versus-`prepublishOnly` invariant
directional: the workflow may be stricter, never looser. The deploy path still
runs both gates, because `publish.yml` calls the same `gates.yml`.

**Correction to an earlier draft, which said this was "the first gate to use"
the `GATE_NAMES` / `PREPUBLISH_FLOOR` split.** It is not. `check-links` was
already a workflow-only gate absent from `prepublishOnly` before this change,
and neither literal is modified here — both remain the same five elements. The
split explains why a workflow-only gate is *permitted*; it was not introduced
or first exercised by this one. The placement is right; the rationale attached
to it was inflated.

`check-docs.sh` runs in the existing `docs-links` job rather than a new one:
it needs no install, so a broken table is reported in seconds, and it is a STEP in that job
rather than a new job because a second job costs another checkout and runner
spin-up for a check that takes under a second. An earlier draft justified this
by saying it "avoids renaming a job", which is a non-sequitur: adding a job
orphans nothing, and only renaming or removing an existing required context
does. The rename hazard is real (`test / docs-links` IS a required status check
on `main`, verified against the API) but it is not what this decision avoided.

## Consequences

- **The claim class is now explicitly accepted as review-caught, not
  gate-caught.** That is a real residual. The 2026-07-29 defects would still
  ship today. What has changed is that the two structural classes underneath
  them will not, and that the claim gate is closed with numbers rather than
  left open as a plausible idea nobody has costed.
- **Coverage is narrow by construction.** These checks catch structure, not
  meaning. A table that is well-formed and wrong passes. Anyone reading the
  green as "the docs are checked" has read more into it than it says.
- **⚠️ THE SCANNER'S BLIND SPOTS, stated as a list rather than as a closed
  set, because an earlier draft of this bullet claimed a closed set and was
  wrong.** That draft said the residual limits were blockquoted rows and fences
  indented past 3 spaces. Round-3 review found at least three more, one of them
  with a live counterexample in this repo:
  1. **A table indented 4+ spaces is not scanned at all.** Row detection is
     `^ ? ? ?\|`. `docs/decisions/0028-skill-section-nonce-delimiter.md` holds a
     five-space-indented table of measured security results inside a list item;
     appending a row to it after a blank line is invisible to this gate.
     Verified empirically.
  2. **Tables without leading pipes** (`a | b` / `--- | ---`) are invisible,
     header and orphan rows alike.
  3. **Opener detection is context-free**, so a fence-shaped line inside an HTML
     block toggles the state machine. This is mechanism 2 of the three ADR-0028
     measured against the reference parser nine days earlier.
  These are NOT fixed. Fixing 1 and 2 needs list-container and column tracking,
  and fixing 3 needs block context, which is exactly the position ADR-0028 shows
  a line-based pass cannot fake. The honest posture is a narrow checker with its
  gaps written down, not a wider one that guesses. **"CommonMark-style" in the
  script header means the fence CLOSER rule specifically** (same character, run
  length at least the opener's, spaces and tabs only after it, which correctly
  avoids the `\s*$` over-match ADR-0028 measured); it does not claim parser
  parity, and an earlier draft borrowed that comparison too broadly.
- **What was fixed rather than declared**: the `~~~` variant and fences indented
  1-3 spaces inside list items, both of which were false POSITIVES that rejected
  valid markdown, plus a 3-backtick example inside a 4-backtick block.
- **The spelled-out ADR count is mapped only across twenty and thirty.** Past
  that the gate REPORTS rather than skipping, because a silent skip is the
  proxy-check pattern DEC-0016 bans, and it would go quiet exactly when the
  repo outgrew it.
- **Issue #61's GATE PROPOSAL is answered; the issue stays open, and the
  distinction is deliberate.** The answer to the proposal is "not as specified,
  and here is the measurement", plus the two binary checks its own status
  comment asked for. The issue carries two things this does not close: the
  unsupported-claim class itself, which remains review-caught, and the LLM-judge
  variant in alternative 4. No closing keyword appears in this ADR, the commit
  or the PR, deliberately — a squash merge takes the PR title as the commit
  subject and the commit messages as its body, so a keyword in any of them
  would close the issue regardless of intent.

## Alternatives considered

1. **Build the gate as issue #61 specified.** Rejected: measured at 2-3 of 20
   with roughly 1.2:1 noise, and it misses the defect the issue calls the worst
   because a backticked identifier on the line satisfies its citation escape.
2. **Ship the superlative variant anyway on the strength of 7.8:1.** Rejected
   by the measurement above. Worth recording as the near miss: the number was
   real, was computed in the wrong unit for the decision it was being used for,
   and would have blocked 60% of docs commits.
3. **Warn-only for absolutes.** Rejected, see decision 3.
4. **An LLM judge over changed prose.** Not rejected on merit, deferred: it is
   the same shape as the S-5 judge (ADR-0016) and should be decided with it,
   not bolted onto a shell gate. Nothing here forecloses it.
5. **Retrofit the checks across existing prose.** Not needed — both pass on the
   whole repo today. That is a property of the checks being structural; a claim
   gate would have needed an exemption list on day one, which was itself a
   signal.

## Amendment (2026-08-31): a third derived constant, the red-team corpus figures (issue #89)

The extension point the script header names ("another hand-copied derived
constant") was exercised. The external review of 2026-08-25 found the corpus
figures asserted in the present tense two corpus revisions stale: 51 cases and
92.5% in `docs/eval-methodology.md`, `docs/security-model.md` and
`docs/blog/adversarial-evaluation.md`, against a shipped 53 cases, 41
malicious, 37 detected (90.2%) since `db164e6` (2026-07-28). Building the gate
found more than the review had: two stale claims were spelled out rather than
numeric ("the three current known-misses"; "Three cases are *known /
misses*", wrapped across two lines, which is the shape a line-scoped grep
cannot see), and `docs/architecture.md`'s "≥50-case" was a TRUE lower bound
the first cut of the recogniser misread, so the gate's own first run on the
tree corrected the gate before it corrected a document. Nothing re-derived
any of these.

Decisions, in the shape of the two above:

1. **Re-derived from the baseline's rows, not its totals.**
   `scripts/check-corpus-numbers.mjs` counts category and verdict per row of
   `eval/redteam/baseline.json`. `totals` and `meta.corpusSize` are compared
   with the row-derived figures, and a disagreement is exit 2 rather than a
   finding: that is a data defect the redteam gate's `totalsMismatchDetail`
   owns, and a doc finding would send the fix to the wrong file. The read
   carries the redteam gate's envelope (symlink refused, `MAX_BASELINE_BYTES`
   cap).
2. **Scope is live docs by construction:** README.md, docs/*.md and
   docs/blog/*.md. ADRs and process/ are dated records and stay out. The
   stated cost: a new ADR carrying a stale number is reviewed, not gated.
3. **The exemption is an explicit marker pair**, `<!-- corpus-gate: skip -->`
   and `<!-- corpus-gate: resume -->`, balanced or exit 2, used once:
   security-model section 7's frozen Week-2 snapshot. This is the explicit
   ignore list the script header prefers over weakening a check, placed in
   the document so the exemption is visible beside the text it exempts.
   Same-line history qualifiers ("at E-2", "Week 3", a date) were rejected:
   a wrapped qualifier lands on the next line, and a live claim on a line
   that happens to mention Week 3 would be skipped silently, the proxy-check
   pattern DEC-0016 bans.
4. **The recognisers are enumerated and their limits stated** in the script
   header: size (`N-case`, `N cases`) and lower bounds (`≥N cases`, `≥N-case`,
   `>=N`, `at least N`) on a line that also says "corpus"; `D/M malicious`
   with or without spaces around the slash; bare malicious, detected and
   benign counts; the missed count as a numeral or as one..twelve with an
   optional `current` and `known-`; and rates on a line containing "detect"
   in the `NN.N%`, `NN.NN%` and `~NN%` forms, a space before the sign
   allowed. Link targets and bare URLs are stripped before matching and link
   text is not, because the row that shipped stale was link text. The rate is
   rounded half-up from the exact integer ratio: `(23 / 80 * 100).toFixed(1)`
   is "28.7" where the true value is exactly 28.75%, which would reject the
   correct figure and accept the wrong one. A bare integer percentage is
   deliberately unrecognised so the blog's hypotheticals ("92% to 94%",
   "≥ 90%") stay legal, and so is a size claim on a line that never says
   "corpus", because ordinary prose says "in 3 cases the model refused".
   Zero recognised claims across the whole scope is a finding, for the reason
   the ADR-count backstop exists.
5. **A separate file, in node.** The recognisers need word boundaries and
   global matching, which POSIX awk lacks and bash-plus-grep would spend a
   process per line on; node is on the runner image and the gate needs no
   install, so it runs in the same job as check-docs, after it.
   `src/ci-drift.test.ts` pins both the job and the order.

What it does not do, so the claim stays no wider than the check: it does not
judge prose (this ADR's central decision stands); it does not see a count
whose noun wraps to the next line, which is why the blog now states its
misses on one line; it does not see a size claim on a line that never says
"corpus"; and it does not restate the blocked/flagged split, because no live
document does. The dated figures remain where they were: ADR-0018 keeps 51
and 92.5% as the E-2 record, and the blog carries a note saying its figures
are live.

Eight defects in the first cut were found by executing the gate rather than
reading it, and they are recorded because they say what this class of gate
gets wrong: a float rate that rejects the correct figure at an exact half; a
spaced fraction that silently degraded to checking only the denominator; a
rate with a space before the sign that was not a claim at all; a
comma-grouped number read from its last group; a corpus-shaped substring
inside a URL read as prose; an unqualified "N cases" that made ordinary
sentences a build failure; a `docs/` path that was not a directory dropping
most of the scope while still exiting 0; and lone-CR files reporting every
finding against line 1. Seven are recogniser precision, one (the silent
scope drop) is the proxy-check pattern DEC-0016 bans, appearing inside the
gate written to enforce it.
