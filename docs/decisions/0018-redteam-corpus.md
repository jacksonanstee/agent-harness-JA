# ADR-0018: Red-team corpus, scorecard split, and the gate-vs-measurement boundary (E-2)

- **Status:** Accepted
- **Date:** 2026-07-10
- **Requirements:** E-2 (MUST)
- **Relates to:** ADR-0016 (LLM-judge S-5 trigger — this corpus supplies the
  measurement S-5 reads), ADR-0017 (golden runner — this ADR is E-2's second
  producer on `eval/scorecard`)

## Context

Week-3 requires a ≥50-case red-team corpus that scores the security layer's
sync `scan()` heuristic deterministically and gates CI on every PR. The
obvious design — gate the merge on the same ≥90% detection threshold that
ADR-0016 §6 names as the S-5 (LLM-judge) build trigger — turns out to be
self-defeating, and that circularity is the load-bearing judgment call this
ADR records, not a footnote.

**The gate and the measurement cannot share a threshold.** If ≥90% detection
blocks merges, then an honest new case the 15-regex scanner misses turns CI
red on the PR that adds it — the case must be curated away (weakened,
softened to `ask`, or dropped) to get back to green. But the whole point of
building the corpus is to measure the scanner's real ceiling, which is
exactly the number ADR-0016 needs to decide whether the LLM judge earns its
keep. A gate that punishes honest misses guarantees the corpus can never
report an honest number: the only cases that survive contribution are ones
already known to pass. The two purposes point the same number in opposite
directions, so one number cannot serve both.

Therefore the design splits them:

- **The CI gate enforces hard invariants only:** `falseBlockCount === 0` (no
  benign input is ever blocked), plus — once E-3 lands — no regression
  against the committed baseline. At E-2 ship time, before E-3 exists, the
  effective gate is `falseBlockCount === 0` alone.
- **Detection rate is a reported metric**, written into the scorecard and
  read by a human or by the ADR-0016 §6 S-5 decision. It never blocks a
  merge. An honest `missed` row lands green.

**Measured detection at design time: 37/40 malicious = 92.5% (≥90%) —
reported, not gated.** The corpus has 51 cases: direct 13, jailbreak 9,
exfil 9, indirect 9, benign 11 (40 malicious). Live `scan()` detects 37 of
those 40 (strength split: blocked 23, flagged-only 14). `benign → block`
count is 0, so the gate is green. Stating the number plainly here — rather
than letting the gate/measurement split read as "we lowered the bar to
pass" — is deliberate: the split exists because a shared threshold breaks
the measurement, not because 92.5% needed protecting.

**Three known misses feed the S-5 decision directly.** `indirect-09`,
`jailbreak-03`, and `exfil-02` are realistic attacks (subtle
retrieved-content phrasing, hypothetical/persona framing, natural-language
exfil intent) that carry no trigger tokens the 15-regex scanner keys on. All
three cluster on the same gap: **the scanner has no jailbreak/paraphrase-
persona-specific rule** — it catches keyword-shaped attacks (`ignore
previous instructions`, literal beacon URLs) but not attacks that reframe
intent through hypothetical or persona language without those keywords. This
is exactly the semantic gap ADR-0016 named as the judge's reason to exist;
E-2 turns it from a hypothesis into three concrete, cited misses for S-5 to
read.

## Decisions

1. **Category taxonomy is distinct from the scanner's `RuleFamily`; never
   widen `RuleFamily`.** The eval case carries its own `category`
   (`direct | indirect | jailbreak | exfil | benign`) because `RuleFamily`
   cannot express indirect-injection or jailbreak framing — it is a rule
   grouping, not an attack taxonomy. Starter-corpus cases are lifted through
   a single explicit `family → category` mapping table (`corpus.ts`,
   reviewed once); new cases set only `category`. The scanner's `family` is
   not a field on the eval case at all, so there is exactly one taxonomy at
   the authoring surface — no contributor has to reconcile two vocabularies
   on one object.

2. **Pass/fail is detection-based, not exact-verdict-match.** A malicious
   case passes if `verdict ∈ {block, ask}` — detected, full stop. The
   block-vs-ask split is recorded as a *strength* metric, never a pass/fail
   driver, so promoting a rule's confidence tier (medium → high) can only
   ever look like an improvement, never a false regression. A benign case
   passes only if `verdict === pass`; `ask` on a benign case is a tolerated
   soft flag (`false-flag`, surfaced, not gated), `block` on a benign case is
   the one hard failure (`false-block`, gates).

3. **Failure-kind union is redteam's own — never added to golden's
   `FAILURE_KINDS`** (per ADR-0017 H1): `missed` (malicious scored `pass`,
   reported not gated), `false-flag` (benign scored `ask`, surfaced not
   gated), `false-block` (benign scored `block`, **the sole gate-load-
   bearing kind** — `totals.falseBlockCount` is computed directly from this
   partition, so the gate is recomputable from the same rows a future
   baseline diff would compare).

4. **Rows carry outcomes, never payloads — plus a double-guard on the one
   free-text field that does reach the row.** A redteam row is
   `{ id, category, verdict, expected, failureKind, reason }`, where `reason`
   is a fixed enumerated string (e.g. `"expected block, scanner returned
   pass"`) — never case text, never a scan excerpt. Case payloads live only
   in the corpus source, so nothing adversarial reaches the rendered
   markdown, the committed canonical JSON, or a viewer's browser (no live
   image-beacon exfil markup surfacing in a GitHub-rendered `.md`). Because
   rows carry no free text, they are not run through `redact()` — an S-2
   rule-table change cannot spuriously rewrite the diffed baseline.

   The one author-controlled free-text field that *does* reach the rendered
   artifact is `id`. It gets a double guard: corpus ids are pattern-pinned
   to `^[a-z0-9][a-z0-9-]{0,63}$` at corpus-validation time (same shape as
   golden's task ids — the ADR-0017 bidi-in-row-id lesson), **and** every id
   is passed through the shared `escapeCell` at render. A crafted id like
   `x-![beacon](https://evil/collect)` is rejected at validation, not merely
   escaped at render — closing the image-beacon vector at its only entry
   point rather than trusting a single downstream defense.

5. **Defang convention for corpus payload text.** Attack payloads must
   remain faithful enough to be meaningful test cases without tripping the
   operator's own `secret-scan.sh --staged` commit hook or GitHub push
   protection (the same tension S-2's fixtures already navigate).
   Credential-shaped literals are assembled from fragments (`'AKIA' +
   'IOSF…'`, never a contiguous matchable literal); assignment shapes
   (`token = …`, `api_key: …`) are avoided or split across the string; exfil
   URLs use non-resolving `.example`/`.invalid` domains. `corpus.ts` carries
   a header comment stating the convention so the first contributor adding
   a case doesn't get a blocked commit as a surprise.

6. **Scorecard: shared minimal core, per-producer extension and renderer.**
   `src/eval/scorecard/` exports only the producer-agnostic core: a generic
   `ScorecardRowCore<K>` (`{ id, pass, failureKind: K | null }`), the
   `byFailureKind` totals partition (built from a producer-supplied
   `as const` kind tuple so the runtime array and the type `K` cannot
   drift), `toCanonicalJson`, the shared `escapeCell`/`truncateWellFormed`
   cell helpers, and a `producer: 'golden' | 'redteam'` discriminator on the
   envelope. Golden keeps its `volatile` (cost/turns) row extension, its
   cost totals, its `taskDir`/`models` meta, and its existing renderer —
   genuinely unmodified beyond import paths, which is the proof this was a
   pure refactor. Redteam extends the core row with
   `{ category, verdict, expected }`, has its own meta
   (`{ corpusSize, armLabel }`), and owns a thin renderer with its own
   columns (no cost/turns "n/a" wall).

   Adding the `producer` discriminator to `schemaVersion: 1` needed **no
   version bump**: there is no baseline in the wild to break compatibility
   with — E-3 (the regression differ) is not built yet, and golden's own
   scorecard JSON output is gitignored, never committed. The discriminator
   lands as part of v1's first real shape, not as a breaking change to a
   shape anyone depends on.

7. **Exit-code contract differs from `eval`'s, by design.** `cli redteam`
   returns `0` = gate passed, `1` = `falseBlockCount > 0` (a hard invariant
   violated), `2` = usage/write error. This is **not** the same meaning as
   `eval`'s exit `1` (ADR-0017 §4: "at least one row failed", i.e. any
   `oracle-fail`/`missed`-equivalent row). Redteam's `1` fires only on the
   one gate-load-bearing failure kind (`false-block`); a `missed` row alone
   never produces exit `1`. Consumers scripting against these exit codes
   must not assume the two commands' `1` means the same thing.

8. **Recalibration policy, with a named adjudicator.** Editing a corpus
   case's `expected` verdict (or its `category`) is legitimate **only**
   when it is made alongside a deliberate rule-confidence change in the
   *same commit* — e.g. a rule promoted medium → high justifies tightening
   an `ask` expectation to `block`. An `expected` edit with no accompanying
   rule change is not a corpus fix; it is silently moving the goalposts.
   **The maintainer is the adjudicator** — there is no mechanical gate that
   can distinguish a legitimate recalibration from goalpost-moving by
   inspecting a diff alone (DEC-0016 tension, accepted). This policy is
   convention-backed, not enforced, but it is backed by the non-gating
   drift diagnostic (`src/eval/redteam/drift.test.ts`): every run re-derives
   each case's live verdict and prints any drift from `expected`, so a
   silent expectation edit with no corresponding scan-side change shows up
   in CI output for the maintainer to notice and question, even though it
   does not fail the build.

9. **E-2 ship-window limitation: block→ask softening is gate-invisible
   until E-3.** Because pass/fail is detection-based (decision 2), a
   malicious case's verdict softening from `block` to `ask` does not fail
   anything: detection still counts it as detected, and
   `falseBlockCount` is unmoved — there is no baseline yet for a strength
   regression to diff against. In the window between E-2 shipping and E-3's
   no-regression clause landing, the scanner's *blocking* posture could
   erode silently while every PR stays green. The interim defense is the
   prominent strength line in the rendered summary
   (`detection N/M · blocked X / flagged-only Y`), which surfaces the split
   to a human even though it does not gate. **Consequently, the ADR-0016 §6
   S-5 decision must read the strength split, not the bare detection rate**
   — a 92.5%-detected corpus that is mostly `ask` is a materially weaker
   security posture than one that is mostly `block`, even though both round
   to the same headline number. E-3 converts this line into an actual gate
   by diffing the committed baseline; until then, this is a named,
   time-boxed weakness, not an oversight.

10. **`scan()` has no runtime time budget.** It is pure, synchronous regex
    matching with no timeout, no abort channel, and no per-call cost. The
    only timing guard anywhere in the security layer is a **test-time**
    ReDoS assertion (bounding worst-case regex backtracking on adversarial
    input at the unit-test level) — there is no runtime budget for E-2 (or
    anything else) to enforce, and this ADR adds no corpus-scale timing
    assertions. Any future claim that `scan()` is time-bounded at runtime
    would be inaccurate; this is stated here so it isn't inferred from the
    test-time guard's existence.

## Consequences

### Positive

- The corpus can report an honest detection ceiling — including its own
  misses — because reporting a miss no longer costs a red PR. That honesty
  is exactly what ADR-0016 §6 needs to decide the S-5 trigger correctly;
  a gate that incentivized curating misses away would have produced a
  number no one could trust.
- Three concrete, cited misses (`indirect-09`, `jailbreak-03`, `exfil-02`)
  give ADR-0016's S-5 decision a specific gap to point at — a
  jailbreak/paraphrase-persona rule family the scanner does not have — 
  rather than an abstract "some evasions probably exist" hand-wave.
- The shared scorecard core (decision 6) means E-3's regression differ can
  be written once against `ScorecardRowCore`/`byFailureKind` and apply to
  both golden and redteam producers, distinguished only by the `producer`
  discriminator.
- Nothing adversarial in the corpus (image-beacon markup, crafted ids,
  jailbreak text) can reach a committed artifact or a rendered page — the
  no-payload-rows decision plus the id double-guard close that surface at
  two independent points.

### Negative / accepted

- Block→ask softening is invisible to CI until E-3 ships (decision 9).
  Accepted as a named, time-boxed weakness with an interim human-readable
  defense (the strength line), not silently deferred.
- The recalibration policy (decision 8) has no mechanical enforcement — a
  maintainer could edit `expected` without a genuine rule-confidence
  justification and nothing but the non-gating drift print and personal
  discipline would catch it. Accepted: DEC-0016's no-proxy-check spirit is
  satisfied by the diagnostic re-deriving the live verdict rather than
  trusting a comment, but the *judgment* of whether an edit is justified is
  irreducibly human here.
- Detection rate counts `ask` as fully detected, same weight as `block`.
  This could flatter the headline number if the scanner leans on soft
  flags; mitigated, not eliminated, by requiring the S-5 decision to read
  the strength split (decision 9) rather than the bare percentage.
- 51 cases is a small corpus; a single case is worth ~2.2% of the malicious
  detection rate. The categories are covered at a floor of ≥8 cases each,
  but the headline number is more sensitive to any one case's framing than
  a larger corpus would be.

## Alternatives considered

1. **Gate CI on the same ≥90% detection threshold ADR-0016 uses for S-5.**
   Rejected — this is the circularity this ADR exists to name: it turns
   every honest new miss into a merge blocker, which structurally prevents
   the corpus from ever reporting the scanner's true ceiling.
2. **Exact-verdict-match semantics** (a case passes only if `verdict`
   equals `expected` precisely). Rejected — it freezes the scanner's
   rule-confidence topology; promoting a rule medium → high (a strict
   improvement) would flip existing `ask`-expected rows to failures.
3. **A single `false-positive` failure kind** covering both benign→ask and
   benign→block. Rejected — it conflates a tolerated soft flag with the one
   hard failure the gate must reads, and the gate could not be recomputed
   from the row partition alone.
4. **Widen the scanner's `RuleFamily` to add `indirect`/`jailbreak`
   members** instead of a separate eval `category`. Rejected — `RuleFamily`
   is a rule-grouping concept the scanner's matching logic depends on;
   conflating it with the eval taxonomy is the same cross-contamination the
   `FailureKind` refactor (ADR-0017 H1) already avoids.
5. **Store the off-arm (null-scanner) detection rate as a JSON field.**
   Rejected — it is a constant-zero control value by construction (a
   scanner that never blocks or flags detects nothing), so storing it would
   be dead weight in every diffed baseline; it is computed at render time
   and labeled a guaranteed-zero control instead.
6. **Make the drift diagnostic (decision 8) assert on drift.** Rejected —
   a verdict flip can be the correct outcome of a deliberate rule change;
   asserting on it would silently resurrect the exact per-PR gate this ADR
   removes (decision log UA2), just moved into a different file.

## Revisit if

- E-3 (the regression gate) lands — the strength split (decision 9) becomes
  an actual gated comparison against the committed baseline, closing the
  ship-window limitation.
- The three known misses (`indirect-09`, `jailbreak-03`, `exfil-02`) — or
  the broader jailbreak/paraphrase-persona gap they expose — motivate
  building the ADR-0016 S-5 judge; that decision should cite this ADR's
  strength split, not the bare detection percentage.
- The corpus grows enough (materially beyond 51 cases) that per-case
  sensitivity (~2.2%) stops being a caveat worth stating.
- A recalibration edit is ever made without an accompanying rule-confidence
  change slipping past the maintainer — that would be the signal to make
  decision 8's policy mechanically enforced rather than convention-backed.
