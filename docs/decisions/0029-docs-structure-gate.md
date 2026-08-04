# ADR-0029: Gate documentation STRUCTURE, not documentation CLAIMS

- **Status:** Accepted
- **Date:** 2026-08-04
- **Requirements:** N-1 (verification posture); answers issue #61

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

Measured over the last 40 docs-touching commits, 15,233 added markdown lines.

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
- **Derived constants.** The ADR count and range are re-derived from the
  filesystem (`check-docs.sh`); the test count is re-derived by running the
  suite (`check-test-count.sh`, in the build job because it needs one). The
  README test count drifted on 2026-08-04 because two branches each measured
  themselves alone and one merged beside the other. **The gate caught a live
  instance the moment it was written**, which is the only evidence worth
  anything about a checker.

**3. Both fail the build. Neither warns.**

Issue #61 left this open. Warn-only is the pattern ADR-0015 rejected for shell
runners: a warning that never blocks is a claim of coverage without the
coverage. These two are cheap to satisfy (move a blank line; re-derive a
number), which is what makes failing affordable, and it is the same property
that made the no-em-dash rule survive.

**4. The docs gate is workflow-only, and deliberately absent from
`prepublishOnly`.**

ADR-0022 decision 4 makes the workflow-versus-`prepublishOnly` invariant
directional: the workflow may be stricter, never looser. `ci-drift.test.ts`
keeps `GATE_NAMES` and `PREPUBLISH_FLOOR` as separate literals precisely so a
workflow-only gate can be added without forcing equality. This is the first
gate to use that. The deploy path still runs it, because `publish.yml` calls
the same `gates.yml`.

`check-docs.sh` runs in the existing `docs-links` job rather than a new one:
it needs no install, so a broken table is reported in seconds, **and adding a
step avoids renaming a job**. Renaming would change the status-check context
and orphan the branch-protection required checks, which is a migration
disguised as a rename.

## Consequences

- **The claim class is now explicitly accepted as review-caught, not
  gate-caught.** That is a real residual. The 2026-07-29 defects would still
  ship today. What has changed is that the two structural classes underneath
  them will not, and that the claim gate is closed with numbers rather than
  left open as a plausible idea nobody has costed.
- **Coverage is narrow by construction.** These checks catch structure, not
  meaning. A table that is well-formed and wrong passes. Anyone reading the
  green as "the docs are checked" has read more into it than it says.
- **Two known limits, pinned by tests rather than left in prose.** Only ` ``` `
  fences toggle fence state, so a `~~~` block containing pipe-leading lines is
  scanned as prose; and indented fences inside list items are not tracked. Both
  have a test asserting the current behaviour, so teaching the gate either one
  turns a test red and makes the change deliberate.
- **The spelled-out ADR count is mapped only across twenty and thirty.** Past
  that the gate REPORTS rather than skipping, because a silent skip is the
  proxy-check pattern DEC-0016 bans, and it would go quiet exactly when the
  repo outgrew it.
- **Issue #61 is answered, not deferred.** The answer is "not as specified, and
  here is the measurement", plus the two checks it asked for at the end.

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
