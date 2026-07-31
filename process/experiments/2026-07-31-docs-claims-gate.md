# Can a CI gate catch this repo's prose defects? A measurement

**Date:** 2026-07-31
**Issue:** #61
**Deliverable:** a measurement, not a gate. The question was open, so the honest output is a number.
**Reproduce:** `python3 process/experiments/measure-lexical-checks.py` and `python3 process/experiments/measure-structural-checks.py`

## Why this was measured rather than built

Issue #61 proposed a `scripts/check-claims.sh` gate: flag any line containing a universal quantifier (*only*, *never*, *nowhere*, *anywhere*, *all three*, *independent*, *every*) unless the line carries a citation. Its stated rationale was that **every** documented defect contained such a quantifier, so the quantifier is "the shape of the failure".

A comment on the issue then self-tested the proposal against the six defects that motivated it, found it caught roughly two, and revised the disposition to "do not build as specified", asking instead for "a check with an actual binary property to test".

Between that comment and this experiment the repo produced fourteen more verified prose defects, which is enough to test the shape hypothesis properly rather than argue about it.

## Method

**Corpus.** `docs-defect-corpus.json`, twenty hand-labelled defects. Ground truth is high confidence: each was found by review, confirmed, and corrected in a named commit that is still reachable in this repository. Six come from issue #61's own write-up; fourteen from the 2026-07-31 sessions on issues #59 and #62. Each entry records the defective clause, its class, and whether the physical line it sat on carried a citation, which is what #61's rule keys on.

**Negatives.** Every prose line in `docs/` over 40 characters, 3,920 of them. These are only *presumed* correct, and that bounds every number below: this repo has repeatedly found defects in shipped prose, so some negatives are certainly mislabelled. The effect is that the measured negative fire rate is an **under**-estimate of the noise, not an over-estimate.

**Bias to declare.** The corpus was labelled by the same author who wrote most of the defects and who is evaluating the checks. The mitigation is that the corpus is committed with the defective text quoted verbatim and the correcting commit named, so anyone can re-label it and re-run.

## Result 1: the lexical checks do not work

| check | recall | fires on negatives |
|---|---|---|
| **#61 as specified** (quantifier AND no citation) | **2/20 (10%)** | **336/3920 (9%)** |
| quantifier list only (no citation escape) | 4/20 (20%) | 620/3920 (16%) |
| wider quantifier list | 6/20 (30%) | 916/3920 (23%) |
| superlative / uniqueness phrase | 2/20 (10%) | 50/3920 (1%) |
| uncited number in prose | 6/20 (30%) | 1012/3920 (26%) |

The gate as specified would flag **336 lines of shipped prose to catch 2 defects out of 20**.

Two things are worth more than the headline number:

**Recall did not scale with the corpus.** The issue's own self-test found it caught "roughly two" of six. At twenty it still catches two. It is picking up a small fixed set of defects that happen to be phrased with a quantifier, not a fraction of the defect population. That is the signature of a check keyed on phrasing rather than on defectiveness.

**Every variant trades recall for noise at roughly 1:1.** Widening the quantifier list takes recall from 10% to 30% and the negative rate from 9% to 23%. A check with real signal separates the two populations; these move together, which is what selecting on text volume looks like.

## Result 2: the shape hypothesis is falsified

Twenty defects. **Twenty distinct classes.** Not one class occurs twice:

```
false-uniqueness          wrong-scope              false-independence
overbroad-scope           missing-qualifier        false-consequence
wrong-number              wrong-quantity           wrong-date
unreproducible-transcript misattribution           intra-commit-count-disagreement
self-defeating-prescription false-absolute         overclaimed-closure
wrong-rationale           wrong-population         overgeneralisation
test-name-not-tested      stale-tense-after-own-edit
```

This is the finding that settles #61. The proposal rests on there being a shape to mechanise. At six defects a shape was arguable. At twenty there is no dominant failure mode at all, and the defects that reached `main` (`false-consequence`, `wrong-population`) are not in the class the quantifier rule targets.

The em-dash rule works because an em-dash is a binary syntactic fact. "Is this claim supported?" is a judgement, and no lexical proxy stood in for it here.

## Result 3: one structural check does work, and it is a different kind of gate

`measure-structural-checks.py` tests two commit-scoped checks that have the binary property the issue asked for.

**CHECK-S1, surviving phrase.** Fires when a distinctive phrase a commit **deleted** from one file still exists verbatim elsewhere in the tree afterwards.

| commit | hits | note |
|---|---|---|
| `7e67413` | 3 | true positive. Caught defect D08 exactly, naming all three files still carrying the wrong claim |
| 7 ordinary commits | **1 total** | the lone hit is a claim deliberately restated in two documents |

D08 is the case where a wrong quantity was corrected in a test comment and left standing in `ADR-0027`, `security-model.md` and `week-7.md`. S1 named all three.

Whitespace normalisation is load-bearing. An earlier line-oriented prototype missed D08 because the phrase spanned a 76-column wrap; collapsing whitespace before matching fixes it.

The single control false positive is `"message puts the same home directory into"`, surviving in ADR-0011 because R-16 and decision 17 deliberately restate the same argument. That is arguably not noise at all: a claim duplicated across two documents is exactly the thing that later goes stale in one of them, which is defect D12.

**CHECK-S2, intra-commit count disagreement, does not work.** It found nothing, including on the commit it was designed to catch. Reported because a negative result on a hypothesis this experiment raised itself is part of the output.

## What S1 actually catches, stated precisely

S1 does **not** detect false claims. It detects **incomplete corrections**: a claim fixed in one place and left standing in others. That is a narrower target than #61 aimed at, and it is a different point in the lifecycle. #61 wanted to gate the *authoring* of an unsupported claim. S1 gates the *fix*.

That target is worth having on this repo's own evidence. Across the 2026-07-31 sessions the recurring and most expensive pattern was not a bad claim reaching main; it was a **correction that did not finish**, and separately a corrective commit that introduced a fresh defect while strengthening something. D08 is the first; the tautology introduced by the round-one #59 fix, and the cannot-fail test introduced by the #62 fix, are the second.

## Recommendation

1. **Do not build #61 as specified.** Two catches for 336 flagged lines, and the hypothesis it rests on is falsified by its own repository's history.
2. **Re-title #61** from "add a check-claims pass for unsupported absolutes" to the finding: the defect population has no lexical shape, and this class is caught by review, not by CI. The docs-parity review already run as a default gate is the control that works. Issue #61's own comment reports it catching nine of ten on 2026-07-29; that figure is quoted from there and was not independently re-derived here.
3. **Build CHECK-S1 separately**, as its own scoped issue, because it is measured, cheap, has a genuine binary property, and targets a failure this repo demonstrably repeats. It should be scoped honestly as an incomplete-correction check and never described as a claims gate.

## Limits

- Twenty defects is a small corpus. The 10% and 9% figures should be read as "roughly one in ten" and not carried to a second significant figure.
- Negatives are presumed-correct rather than verified-correct, which understates the noise.
- Author bias is declared above and mitigated only by the corpus being committed and re-runnable.
- S1's control sample is seven commits. Its false-positive rate is "about one in seven ordinary commits" and nothing more precise.
- S1 was measured against exactly one true positive. Its recall over the incomplete-correction class is **not** established by this experiment, only its behaviour on the one case that motivated it.
