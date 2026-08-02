# Defect register for the withdrawn #61 docs-claims experiment

**Withdrawn:** 2026-08-02 | **Issue:** #61 (left open and unanswered) | **PR:** #66, closed unmerged
**Preserved:** `2026-07-31-docs-claims-gate.md` (body unaltered), `docs-defect-corpus.json`, both measurement scripts
**Provenance:** the corpus cites commits that were squash-merged and branch-deleted. They are pinned by `provenance/61-corpus/*` tags so a fresh clone can verify them.

## Why it was withdrawn rather than repaired

The experiment asked whether this repository's prose defects have a shape a CI gate could catch, and concluded they do not. An adversarial methodology review returned **CONCLUSION_UNSAFE on all three lenses**, and verification upheld **27 findings**. The problems are methodological rather than editorial, so patching the prose would have dressed up a broken measurement.

The author labelled the corpus, wrote most of the defects in it, and was recommending against a proposal he would otherwise have had to build. That bias was declared in the original document. Declaring it did not prevent it operating, and every material error runs in its favour.

## Result 1: the measurement was not valid

- **Mismatched units.** Recall was scored on short hand-extracted `clause` fragments; the negative fire rate on whole physical lines. The two columns of the headline table were never comparable, so no ratio between them means anything.
- **Asymmetric labelling.** `line_has_citation` was hand-assigned for positives but regex-scored for negatives. They disagree on 4 of the 14 locatable defects. `D19`'s hand label contradicts the experiment's own `CITE` regex, and correcting that one entry moves the headline from **2/20 to 3/20**.
- **Measured outside the specified scope.** Issue #61 scopes its gate to *added lines only, diffed against the merge base*. The document never mentioned the restriction and measured noise across all 3,920 lines of existing prose. In scope it is roughly 7.3% of added lines, median 6 per docs-touching commit.
- **A false universal carried the dismissal.** "Every variant trades recall for noise at roughly 1:1" is false against the table printed nine lines above it. Four rows sit near 1.2:1; the superlative/uniqueness row is **7.8:1**. That row meets the sentence's own stated criterion for real signal, and the document never mentions it again. The two checks are disjoint, union 4/20, never computed. The dropped row catches `D01`, the defect issue #61's own comment calls the worst of 2026-07-29, and it catches it precisely because it lacks the citation escape hatch that comment blamed for the miss.

## Result 2: it pointed the opposite way from what was claimed

"Twenty defects, twenty distinct classes, not one repeated" was billed as the finding that settled the issue. It is an artefact of single-labeller granularity. Collapsed into families:

| family | count |
|---|---|
| **overclaim** | **6/20 (30%)** |
| quantitative | 5/20 (25%) |
| attribution | 4/20 (20%) |
| scope | 3/20 (15%) |
| evidence | 2/20 (10%) |

The largest family is **overclaim**, which is close to the shape issue #61 hypothesised. Splitting it into six differently-named singletons is what produced "no dominant failure mode at all". This result does not support the conclusion drawn from it, and may support the opposite one.

## Result 3: contaminated controls and selective reporting

- Two of the seven "ordinary commits" are the squash-merges of the very PRs containing the true positives. One shipped corpus defect `D06` to `main`. One is addition-only, so `CHECK-S1` cannot fire on it by construction.
- **Granularity mismatch.** Both true positives are intra-branch commits; all seven controls are squash-merges. Squashing erases exactly the add-then-delete churn S1 detects, demonstrated by `D08`'s phrase being absent from its own squash-merge's diff.
- The real evidence base is **one true positive and three to four informative controls, presented as seven**.
- **An unreported failed trial.** The script declares two true positives; the second returns zero hits. The document expressly promised to report negative results, and reported `CHECK-S2`'s negative while omitting `CHECK-S1`'s.
- "Caught defect D08 exactly, naming all three files" conflates two things: the run produced three distinct phrase hits, only one of which is D08.
- The low control rate is produced mainly by an undocumented `if ph in added_blob: continue` filter, not by the whitespace normalisation the document credits.

## Known defects in the preserved corpus

`docs-defect-corpus.json` is kept because a labelled corpus is reusable. It is **not clean**:

- 8 of 20 entries violate the corpus note's own ground-truth invariant: `D01` to `D05` quote text from issue #61 that never existed as repo prose, `D10` was never corrected and is still shipped, and `D07` and `D17` name the wrong commit.
- `D19`'s `line_has_citation` is wrong by the project's own regex.
- The 14 defects added by the author come from a different process stage, in-flight self-correction, than issue #61's original 6, and are roughly three times poorer in the target class. Mixing the two sources confounds any comparison between them.

## Known defects in the preserved scripts

- `measure-structural-checks.py` calls `git()` without checking `returncode`, so an unresolvable commit yields empty output and the check silently reports zero instead of failing.
- `phrases()` returns a set and `check_s1` breaks on the first surviving shingle, so reported phrases are non-deterministic across runs. The control false positive quoted in the original write-up is not reliably reproducible.
- The row labelled "#61 as specified" is not as specified: it drops the issue's adjacent-line citation escape.

## What survives

**Issue #61 is left open and unanswered.** What can be said honestly is narrower than either the issue or the experiment claimed: the rule as specified caught 2 or 3 of 20 depending on a labelling correction, one unexamined lexical variant looked materially better on the same corpus, and nobody has yet measured either in the scope the issue actually specifies.

If it is picked up again, the method has to change before the question can be answered: match units between positives and negatives, score the citation field by the same rule on both sides, pre-register the class taxonomy before labelling, draw uncontaminated controls at matched granularity, and have someone other than the labeller check the labels.

## The finding that outlived the experiment

An experiment written specifically to test whether this repository makes unsupported claims was itself built on unsupported claims, and needed adversarial review to find them.

That is the sixth consecutive round in which the defect landed in prose and claims rather than in behaviour, and in which a corrective or analytical artefact carried the very defect class it was about: a fix that added a tautology to the test it was hardening, a fix that shipped an assertion that could not fail in the commit advertising mutation evidence, and now a measurement of overclaiming that overclaimed. The test suite was green throughout, every time.

The rule that follows, and the reason this register exists rather than a quiet deletion: **an artefact that measures, strengthens or corrects something is not evidence about itself.** It needs the same independent check as the thing it examines, and its author is the worst-placed person to supply it.
