# E-2 — Red-Team Corpus & Deterministic Scorecard

Status: design (review-validated — 4-agent structured review, disposition APPROVED)
Date: 2026-07-10
Depends on: E-1 golden runner (`src/eval/scorecard/`, `src/eval/golden/`), S-1 injection scanner (`src/security/injection/`)
Feeds: E-3 regression gate (diffs this design's canonical scorecard), ADR-0016 S-5 trigger (consumes the reported detection rate)

## Problem

Week-3 requires a ≥50-case red-team corpus (E-2) that scores the security
layer deterministically and gates CI on every PR (ADR-0016 §7 — the gate
scores the sync `scan()` heuristic arm, never a live model). E-1 shipped a
producer-agnostic scorecard; E-2 is its second producer. The corpus must
prove the injection scanner does real work, feed the ADR-0016 decision on
whether to build the LLM judge, and be safe to author and commit in a public
repo.

## Locked scope

- **Scanner-only.** Every case scores a sync `scan()` verdict. No
  secret-redaction cases (S-2 has its own corpus), no full-session cases.
- **`cli redteam` subcommand** — deterministic, keyless, CI-invoked. Distinct
  from `cli eval` (live, spends money, executes repo oracle code, R-10).

## Core decision: the gate is not the measurement

A CI merge-gate and the ADR-0016 §6 S-5 trigger cannot share the ≥90%
detection threshold. If ≥90% detection blocks merges, then an honest new case
that the 15-regex scanner misses turns CI red and must be curated away to
merge — so the corpus can never legitimately measure the scanner's ceiling,
which is the exact number ADR-0016 needs to decide whether to build the judge.
The two purposes point the same number in opposite directions.

Therefore:

- **The CI gate enforces hard invariants only:** `falseBlockCount === 0`
  (no benign input is blocked) and — once E-3 lands — no regression vs the
  committed baseline. At E-2 ship time the effective gate is
  `falseBlockCount === 0` alone.
- **Detection rate is a reported metric**, written to the scorecard and read
  by a human / the S-5 decision. It never blocks a merge. An honest `missed`
  row lands green.
- The ≥90%/<50% figures are stated in ADR-0018 as the measured-at-design-time
  values, not encoded as a blocking assertion anywhere in the test suite.

This split is the load-bearing engineering judgment of E-2; ADR-0018 leads
with it (§ADR below) so it reads as rigor, not as lowering a bar.

## Semantics (aligned with the existing S-1 corpus)

Per-case pass/fail is detection-based, not exact-verdict-match:

- **Malicious case** passes if `verdict ∈ {block, ask}` (detected). The
  block-vs-ask split is recorded as a *strength* metric, not a pass/fail
  driver — so promoting a rule medium→high never turns an improvement into a
  regression.
- **Benign case** passes if `verdict === pass`. `ask` = soft flag (tolerated,
  surfaced); `block` = hard fail (gates).

Failure-kind union (redteam's own, per ADR-0017 H1 — never added to golden's):

- `missed` — malicious scored `pass` (reported, not gated)
- `false-flag` — benign scored `ask` (surfaced, not gated)
- `false-block` — benign scored `block` (**the one gate-load-bearing kind**)

Detection rate is computed over **malicious cases only**, rendered with raw
counts: `46/50 (92%)`.

## Scorecard: shared minimal core + per-producer extension

The E-1 refactor (ADR-0017 H1 trigger) is scoped honestly — the golden-shaped
parts do not move into the shared core:

- **Shared core** (`src/eval/scorecard/`): generic
  `ScorecardRow<K extends string> = { id, outcome, failureKind: K | null }`,
  the `byFailureKind` totals partition over a producer-supplied `as const`
  kind tuple (`K` derived as `typeof TUPLE[number]` so array and type cannot
  drift), `toCanonicalJson`, a `producer: 'golden' | 'redteam'` discriminator,
  and the shared cell helpers `truncateWellFormed` + `escapeCell` (the latter
  hoisted from golden's renderer).
- **Golden** keeps its `volatile` (cost/turns) row extension, its cost totals,
  its `taskDir`/`models` meta, and its `# Golden eval scorecard` renderer —
  genuinely unmodified beyond import paths (the pure-refactor proof).
- **Redteam** extends the core row with `{ category, verdict, expected }`, has
  meta `{ corpusSize, armLabel }`, and owns a thin renderer (below).

`FAILURE_KINDS` moves out of shared `scorecard/types.ts` into
`src/eval/golden/` (it is golden's vocabulary).

## Rows carry outcomes, never payloads

Redteam rows contain **no case text and no scan excerpts**. A row is
`{ id, category, verdict, expected, failureKind, reason }` where `reason` is a
fixed enumerated explanation (`"expected block, scanner returned pass"`).
Payloads live only in the corpus source. Consequences:

- Nothing adversarial reaches the rendered markdown, the committed canonical
  baseline, or a viewer's browser (no live image-beacon exfil markup in a
  GitHub-rendered `.md`).
- Redteam rows are **not** run through `redact()` — they carry no free text —
  so an S-2 rule-table change cannot spuriously rewrite the diffed baseline.

## Corpus

`src/eval/redteam/corpus.ts` exports `CORPUS: readonly CorpusCase[]` (named
`CorpusCase`, not `RedTeamCase`, to avoid colliding with the security barrel's
type in the one layer that legally imports it).

- Wraps `STARTER_CORPUS` (imported from the `src/security/injection` barrel —
  eval→security is layering-legal and tested) through a single explicit
  `family → category` mapping table, reviewed once.
- `category` (`direct | indirect | jailbreak | exfil | benign`) is the eval
  taxonomy — distinct from the scanner's `RuleFamily`, which cannot express
  indirect-injection or jailbreak. New cases set only `category`.
- Adds ≥19 new cases to reach ≥50, filling week-plan families: indirect
  injection (Greshake-style tool-output payloads), jailbreak (starter
  under-covers), exfil, and benign near-misses (the false-positive guard).
  Every new case carries `source` provenance (Greshake et al. 2023, Willison,
  OWASP LLM Top 10).
- **Defang convention** (header comment + ADR-0018): credential-shaped
  literals are assembled from fragments, assignment shapes avoided or split,
  exfil URLs use non-resolving `.example`/`.invalid` domains — so authoring a
  faithful payload does not trip the operator's `secret-scan.sh --staged`
  commit hook or GitHub push protection.

## Runner

`src/eval/redteam/runner.ts`, dependency-injected like golden's:

- `scan` fn injected. The **security-off arm** is a null scanner returning
  `pass` for every case (a compile-time baseline, run as a second pass).
- Rows are fully deterministic — no `volatile`, no clock, no I/O.
- Computes: `falseBlockCount`, detection rate (malicious only, with counts),
  the block-vs-ask strength split, and — at render time, labeled a
  null-scanner baseline — the off-arm rate (definitionally 0; not a stored
  JSON field).

## CLI + CI

- `cli redteam [--out <dir>]` dispatched **before** the `ANTHROPIC_API_KEY`
  guard (keyless, like `telemetry-export`), added to the `USAGE` string. Runs
  both arms, writes the canonical JSON (on-arm = the E-3 baseline) and the
  redteam markdown to stdout. No R-10 warning (no repo code executes).
- Exit contract: `0` = gate passed, `1` = invariant violated
  (`falseBlockCount > 0`), `2` = usage/write error. The meaning of `1` differs
  from `eval`'s row-based exit; ADR-0018 documents the difference.
- CI gains one post-build step: `node dist/cli.js redteam`.

## Redteam markdown (leads with the gate)

Totals-first, like golden. The summary block, before the table:

```
# Red-team scorecard
- **Gate: PASS** — false-blocks: 0
- **Detection (security on):** 35/38 malicious (92%)  ·  strength: blocked 30 / flagged-only 5
- **Baseline (security off, null scanner):** 0/38 — guaranteed-zero control
- **Corpus:** 50 cases (direct 12 · indirect 10 · jailbreak 8 · exfil 8 malicious = 38 · benign 12)
```

Row outcomes are labeled so exit 0 never sits above a wall of the word
`FAIL`: malicious rows read `detected` / `MISSED`; benign rows read `ok` /
`flagged` / `BLOCKED`. Only `false-block` rows render in an alarming style —
the gate-load-bearing kind is the one a reader's eye is drawn to. A footer
names the E-3 baseline-diff command as where verdict deltas surface.

## Drift diagnostic (non-gating)

A test re-derives each case's current `scan()` verdict and prints any drift
from its `expected` field (re-derivation satisfies DEC-0016's no-proxy-check
spirit). It does not fail CI — a verdict flip can be a legitimate response to
a deliberate rule-confidence change. ADR-0018 names the maintainer as
adjudicator and states the recalibration policy: editing `expected`/`category`
is legitimate only alongside a deliberate rule change in the same commit.

## ADR-0018

Records: the gate-vs-S-5-trigger circularity argument (leads, with the
measured detection rate stated plainly); category-vs-RuleFamily separation;
detection-based semantics; the failure-kind union; the rows-carry-no-payload
decision; the defang convention; the shared-core/per-producer split + the
`producer` discriminator; the exit-code difference from `eval`; the
recalibration policy; and the factual note that `scan()` has no runtime time
budget (only the existing test-time ReDoS assertion).

## Out of scope (separate week-plan items)

`docs/eval-methodology.md` (how scoring works, authoring new cases) and E-3
(the regression diff itself). E-2 ships the diffable artifact and the
`falseBlockCount === 0` gate; E-3 adds the no-regression clause.

## Testing (TDD)

- Corpus: size ≥50; every case internally consistent (benign→expected pass,
  malicious→expected block/ask); category coverage across all five families.
- Runner: each failure kind produced from a synthetic scanner; `falseBlockCount`
  correct; detection computed over malicious only; deterministic rows.
- Renderer: gate-first summary; outcome labels (no bare `FAIL`); `false-block`
  marked; shared `escapeCell`/`truncateWellFormed` applied.
- CLI: keyless dispatch before the key guard; exit 0/1/2 paths; canonical JSON
  written before stdout (the E-1 exit-2 contract precedent).
- Golden: existing scorecard tests unchanged beyond import paths (refactor proof).
- The existing S-1 `corpus.test.ts` stays untouched (keeps gating the scanner
  unit at its 31 cases).
- Non-gating: the drift diagnostic; a documenting check that prints the
  measured detection rate (no hardcoded ≥90% assertion in the blocking suite).
