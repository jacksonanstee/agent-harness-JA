# E-3 — Deterministic Red-Team Regression Gate

Status: design (pre-review)
Date: 2026-07-10
Depends on: E-2 red-team corpus (`src/eval/redteam/`, ADR-0018), E-1 scorecard core (`src/eval/scorecard/`, ADR-0017)
Feeds: closes ADR-0018 decision 9's ship-window limitation (block→ask softening becomes gated); week-plan Week-3 E-3 checkbox

## Problem

E-2's CI gate is `falseBlockCount === 0` alone. ADR-0018 decision 9 names the
consequence: a malicious case's verdict can soften from `block` to `ask` —
or the whole scanner's blocking posture can erode — while every PR stays
green, because detection-based pass/fail counts `ask` as detected and
`falseBlockCount` is unmoved. E-3 converts the committed scorecard into a
baseline and fails CI on any behaviour drift, closing that window.

The original week plan (2026-05) phrased E-3 as "SQL diff between latest and
baseline scorecards." That predates E-1/E-2's canonical-JSON scorecard; the
scorecard is now a byte-stable JSON artifact, not a database table, so E-3 is
a canonical-JSON row diff. Recorded as a plan-wording deviation in ADR-0019,
not a scope change.

## Locked decisions (user, 2026-07-10)

1. **Regression semantics: strict per-row weakening** — confirmed against an
   external best-practice survey (promptfoo, Braintrust/LangSmith, OpenAI
   evals, Jest snapshot doctrine, Semgrep/CodeQL/gitleaks baselines,
   Betterer). Per-row asymmetric diff against a committed baseline is the
   consensus pattern; aggregate-only gating is the weakest surveyed pattern
   (offsetting flips net to zero); detection-only leaves exactly the
   decision-9 blind spot open.
2. **Gate fails on ANY drift, improvements included.** The committed baseline
   must always byte-match reality. The surveyed asymmetric ratchet
   (weakenings fail, improvements warn) leaves a latent hole: an unrecorded
   improvement makes the baseline stale, and a later slide back to the old
   state diffs clean. Fail-on-any-drift closes the hole, matches the
   operator's DEC-0016 rule (pinned derived values re-derive and fail on
   drift), and keeps the baseline PR-diff an always-current review surface.
   The asymmetry lives in the *messaging* (each drifted row is classified
   improvement vs regression) and in review scrutiny, not in the gate.

## Baseline artifact

`eval/redteam/baseline.json` — committed at the repo top level next to
`eval/golden/` (repo eval assets live outside `src/`). Content = the
canonical scorecard produced by the existing `toCanonicalJson`, after a
normalization step that drops the two volatile meta fields:

- dropped: `meta.createdAt`, `meta.harnessVersion` (differ every run/version)
- kept: `schemaVersion`, `producer`, `meta.corpusSize`, `meta.armLabel`,
  all `rows`, all `totals`

Rows are already id-sorted and key-sorted by `toCanonicalJson`, so the file
is byte-stable across machines. Rows carry outcomes, never payloads
(ADR-0018 decision 4), so committing the baseline adds no new adversarial
surface to the repo or its rendered pages.

## Gate rule

`cli redteam` (the same keyless command CI already runs) becomes
compare-by-default:

1. Run the corpus, build the fresh scorecard (unchanged).
2. **Absolute gate first, unchanged:** `falseBlockCount === 0`. This gate
   never consults the baseline — a false block fails even if the baseline
   also recorded it.
3. Load `eval/redteam/baseline.json`, normalize the fresh scorecard the same
   way, compare canonical strings. **Byte-equal → gate passes.**
4. **Any drift → gate fails**, and the differ prints a per-row
   classification table before exiting:
   - `regression` — malicious detected→missed; malicious `block`→`ask`
     (strength softening); benign `pass`→`ask` (new false-flag); **a
     baseline id absent from the fresh run** (removing a detected case is
     the easiest silent-weakening vector — equivalent to deleting a failing
     test). Renames are remove+add; no fuzzy matching.
   - `improvement` — malicious `ask`→`block`, missed→detected, benign
     `ask`→`pass`.
   - `new-case` — fresh id absent from baseline (added case, any outcome —
     an honestly-missed new case is drift only because the baseline needs
     updating, preserving ADR-0018's honesty principle: it never demands the
     case be curated away, only that the baseline record it).
   - Direction comes from a strength order per expected-class:
     malicious `block > ask > pass`; benign `pass > ask > block`.
   - `totals` drift with identical rows (impossible unless the differ or
     producer is buggy) is reported as `internal` — see backstop below.
5. **Aggregate backstop:** independently of the string compare, the differ
   recomputes totals from the fresh rows and asserts they equal the
   scorecard's own `totals` (differ/producer-bug defense, DEC-0016 spirit —
   the gate is recomputable from the rows it diffs).

The classification is messaging only; all drift fails. Classification also
drives nothing else — no allowlist, no acknowledged-regressions file. The
mechanism for shipping a deliberate weakening is updating the baseline in
the same PR, where the row-level diff is visible to review (ADR-0018
decision 8's recalibration policy thereby gains a mechanical surface: an
`expected` edit now *forces* a baseline drift the PR must commit).

## Update mechanics

- `agent-harness-ja redteam --update-baseline` — runs the corpus and
  rewrites `eval/redteam/baseline.json` (normalized canonical JSON), then
  reports what changed vs the previous baseline using the same classifier.
  Local, deliberate, never run in CI (CI has no write path; the workflow
  step stays `node dist/cli.js redteam`).
- `--baseline <path>` — optional override of the default path (test
  ergonomics; CI uses the default).
- Missing or unparseable baseline → exit 2 with "run --update-baseline and
  commit the result." The E-3 PR itself commits the first baseline, so CI is
  never baseline-less.
- `schemaVersion` mismatch between baseline and fresh scorecard → exit 2
  (incompatible artifact, regenerate deliberately), never a silent
  best-effort diff.

## Exit codes

Unchanged contract shape (ADR-0018 decision 7): `0` gate green, `1` gate
failure — `falseBlockCount > 0` **or** baseline drift, the message says
which (both mean "your change did this; fix it or update the baseline") —
`2` usage/infra error, now including missing/unreadable/incompatible
baseline. No new exit code.

## Code placement

- `src/eval/scorecard/diff.ts` — producer-agnostic, id-keyed row differ over
  `ScorecardRowCore`: pairs rows by id, returns
  `{ identical, added[], removed[], changed[] }` with the changed fields.
  Knows nothing about verdict strength. This is the "written once, applies
  to both producers" piece ADR-0018's consequences anticipated.
- `src/eval/redteam/baseline.ts` — redteam-specific: normalization
  (volatile-meta strip), baseline load/validate (schemaVersion, producer
  discriminator must be `redteam`), the strength-order classifier
  (regression/improvement/new-case), and the drift-report renderer (plain
  text, ids only — ids are already charset-guarded, ADR-0018 decision 4).
- `src/cli.ts` — flag parsing (`--update-baseline`, `--baseline`), compare
  wiring, exit-code mapping. Composition root only.
- Golden gets **no** baseline: its scorecards are gitignored, live-key, and
  banned from per-PR CI (ADR-0017). The differ core is reusable; only
  redteam wires it. Recorded in ADR-0019.

## Interaction with existing pieces

- `drift.test.ts` (non-gating diagnostic) stays: it compares live verdicts
  to `expected` (case-calibration drift); E-3 compares live scorecard to
  baseline (behaviour drift). Complementary, and the diagnostic remains the
  early-warning channel that never fails the build.
- One new vitest e2e asserts the committed baseline byte-matches a live
  `runRedteam()` over the real corpus — so `npm test` catches drift even
  before the CI redteam step runs (deliberate duplication: the unit suite
  and the CLI gate fail together, and the test is the differ's own
  regression test against the real artifact).
- ADR-0016 §7 unchanged: the gate still scores the deterministic heuristic
  arm only.

## Documentation

- **ADR-0019** — leads with fail-on-any-drift vs asymmetric-ratchet
  reasoning (the latent-stale-baseline hole), cites the best-practice survey
  sources, records the "SQL diff" plan-wording deviation, the
  removed-case-fails rule, and the no-new-exit-code decision.
- **ADR-0018 amendments** — decision 9's Revisit-if fires: status note that
  E-3 closed the ship-window limitation; decision 8 gains a note that
  recalibration edits now mechanically surface in the baseline diff.
- Week-plan E-3 checkbox + checkpoint paragraph updated (the checkpoint's
  "once E-3 lands" clause becomes present tense).
- `docs/eval-methodology.md` remains a separate week-plan item (E-3 ships
  the ADR; the methodology doc consolidates E-1..E-4 afterwards).

## Out of scope

- E-4 adversarial verification (separate item).
- Golden-scorecard baselines (banned from per-PR CI; ADR-0017).
- Any change to corpus content, scan rules, or detection semantics.
- Mechanical enforcement of ADR-0018 decision 8's *justification* judgment
  (still human; E-3 only makes the edit visible).

## Testing (TDD)

- `diff.test.ts` (scorecard core): equal sets, added, removed, changed
  fields, id-pairing stability under reorder, empty rows.
- `baseline.test.ts` (redteam): volatile-strip normalization (createdAt/
  harnessVersion dropped, everything else kept — pinned by fixture);
  classifier direction table (every verdict transition × malicious/benign →
  regression/improvement classification); removed-id → regression; added
  missed case → new-case (not regression); schemaVersion/producer mismatch →
  typed error; totals-recompute backstop trips on a corrupted fixture.
- CLI: `--update-baseline` writes normalized canonical bytes; compare path
  exit codes (0 equal, 1 drift, 1 falseBlock-with-equal-baseline edge, 2
  missing baseline, 2 bad flag); drift report reaches stdout before exit.
- E2E: committed `eval/redteam/baseline.json` byte-matches live
  `runRedteam()` output after normalization.

## Research provenance

Best-practice survey run 2026-07-10 (WebSearch subagent; sources: promptfoo
CI docs, promptfoo-action, OpenAI cookbook regression example, Braintrust
baseline-experiment docs, LangSmith eval docs, Kinde CI-for-evals guide,
Jest snapshot doctrine, Semgrep `--baseline-commit`, gitleaks
`--baseline-path`, GitHub code-scanning PR triage, Betterer, Hamel Husain /
Arize on per-example error analysis). Consensus: per-row asymmetric diff
against a committed, explicitly-updated baseline; aggregate-only gates
criticized; snapshot rubber-stamping is the known failure mode (mitigated
here by small canonical baselines + review-visible diffs); Betterer's
auto-ratchet motivates the fail-on-any-drift choice since CI cannot commit.
