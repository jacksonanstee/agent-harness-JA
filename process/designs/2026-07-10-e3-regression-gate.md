# E-3 — Deterministic Red-Team Regression Gate

Status: design (revised after 3-reviewer structured panel; arbiter pending)
Date: 2026-07-10
Depends on: E-2 red-team corpus (`src/eval/redteam/`, ADR-0018), E-1 scorecard core (`src/eval/scorecard/`, ADR-0017)
Feeds: closes ADR-0018 decision 9's ship-window limitation (block→ask softening becomes gated); week-plan Week-3 E-3 checkbox
Decision log: [2026-07-10-e3-regression-gate-decision-log.md](./2026-07-10-e3-regression-gate-decision-log.md)

## Problem

E-2's CI gate is `falseBlockCount === 0` alone. ADR-0018 decision 9 names the
consequence: a malicious case's verdict can soften from `block` to `ask` —
or the whole scanner's blocking posture can erode — while every PR stays
green, because detection-based pass/fail counts `ask` as detected and
`falseBlockCount` is unmoved. E-3 converts the committed scorecard into a
baseline and fails CI on any behaviour drift, closing that window.

The original week plan (2026-05) phrased E-3 as "SQL diff between latest and
baseline scorecards," and `process/01-requirements.md`'s E-3 row says results
are "persisted in SQLite with a stable schema." Both predate E-1/E-2's
canonical-JSON scorecard: the scorecard is now a byte-stable JSON artifact,
not a database table, so E-3 is a canonical-JSON row diff. ADR-0019 records
the deviation **against the requirements table itself** and the same PR
amends the table; the requirement's acceptance clause ("regression test
detects a deliberately-broken baseline") is met by the corrupted-fixture
test named in §Testing, and ADR-0019 says so explicitly.

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
   The asymmetry lives in the *messaging* (each drifted row is classified)
   and in review scrutiny, not in the gate.

## Baseline artifact

`eval/redteam/baseline.json` — committed at the repo top level next to
`eval/golden/`. Content = the canonical scorecard produced by the existing
`toCanonicalJson`, after normalization:

- dropped: `meta.createdAt`, `meta.harnessVersion` (volatile)
- kept: `schemaVersion`, `producer`, `meta.corpusSize`, `meta.armLabel`,
  all `rows`, all `totals`

**Exactly one normalization implementation exists**: a single exported
function in `src/eval/redteam/baseline.ts`, consumed by the compare path,
`--update-baseline`, and the e2e test; `baseline.test.ts` pins its output
with a fixture. The arm label becomes a shared exported constant
(`REDTEAM_ARM_LABEL`, in the redteam module) consumed by the CLI and every
test — today `'security-on'` is a string literal in `cli.ts` while
`drift.test.ts` uses a different label, a split-brain the e2e test would
otherwise have to hardcode a second time.

The E-3 PR also commits a **`.gitattributes`** pinning the baseline (at
minimum `eval/redteam/baseline.json text eol=lf`): with no `.gitattributes`,
a Windows contributor's `core.autocrlf=true` checkout would CRLF-mangle the
file and fail the byte compare locally on every run while CI stays green.
CRLF is **not** normalized away on load — that would weaken byte-equal
semantics; the fix is pinning the bytes in git.

Rows carry outcomes, never payloads (ADR-0018 decision 4), so committing the
baseline adds no new adversarial payload surface — but the baseline file
itself is repo-controlled input and is validated as hostile (§Baseline
load).

## Baseline load (hostile-input validation)

`docs/security-model.md`'s attacker model puts a malicious cloned repo in
scope, and `baseline.json` is the keyless gate command's first read of
repo-controlled data. Load order:

1. **Size cap before read**: `stat` first, refuse over the existing
   1 MB cap (`MAX_FILE_BYTES` pattern from `src/internal/frontmatter.ts`) →
   exit 2. Missing file → exit 2. Symlinked file or parent dir → exit 2
   (reuse the `refuseSymlinkedDir` pattern that already guards
   `writeScorecard`).
2. **Parse + full structural validation** against an exact field allowlist
   for envelope, meta, rows, and totals (ajv, the ADR-0017 precedent — not
   just `schemaVersion` + `producer`). Non-conforming shape → exit 2 with a
   clear message, never a mid-diff TypeError.
3. **Every baseline row id re-validated** against the same
   `^[a-z0-9][a-z0-9-]{0,63}$` charset `runRedteam` enforces on corpus ids →
   exit 2 on violation. The fresh side is guarded inside `runRedteam`; the
   baseline side comes from a file and **bypasses that guard**, so it gets
   its own check — this also excludes `__proto__`/`constructor` as ids.
4. Row pairing uses a `Map` (never a plain-object index), immune to
   prototype-key corruption regardless of guard 3.
5. The drift report is written through the CLI's existing
   `sanitizeForTerminal` like every other stdout path — two independent
   guards, preserving ADR-0018 decision 4's doctrine for this new input.

`schemaVersion` or `producer` mismatch → exit 2 (incompatible artifact,
regenerate deliberately), never a best-effort diff.

## Gate rule

`cli redteam` (the same keyless command CI already runs) becomes
compare-by-default. All checks run — no short-circuit — and produce **one
combined report**:

1. Run the corpus, build the fresh scorecard (unchanged).
2. **Absolute gate, baseline-independent:** `falseBlockCount === 0`. A
   false block fails even if the baseline also recorded it, and
   `--update-baseline` refuses to bake one in (§Update mechanics).
3. **Totals backstop (DEC-0016):** independently re-derive totals — and
   `meta.corpusSize` — from the fresh rows in `baseline.ts` (a second
   implementation, deliberately not importing `runRedteam`'s totals code,
   pinned by the corrupted-fixture test). Mismatch = producer/differ bug →
   report `internal` → **exit 2** ("update the baseline" cannot fix a
   producer bug, so this is infra, not gate failure).
4. Load + validate the baseline (§Baseline load), normalize the fresh
   scorecard, compare canonical strings. **Byte-equal → pass.**
5. Byte-unequal but **semantically equal after parse** (hand-edited key
   order, stray newline, CRLF that escaped git) → fail with a distinct
   message: `baseline file is not canonical — regenerate with
   --update-baseline`. Still fails (locked decision 2); it just says why,
   with an empty classification table replaced by that line.
6. **Any semantic drift → fail**, printing a per-row classification table:
   - `regression` — paired row (same id, same benign/malicious class) whose
     verdict weakened; or **a baseline id absent from the fresh run**, whose
     report line carries the rename hint: `absent from fresh run (removed,
     or renamed — renames are remove+add; if intentional, update the
     baseline)`.
   - `improvement` — paired row whose verdict strengthened.
   - `new-case` — fresh id absent from baseline, any outcome (an
     honestly-missed new case is drift only because the baseline must record
     it — never a demand to curate the case away).
   - `recalibration` — paired row whose verdict transition is not orderable:
     same verdict but another field changed (`expected`, `category` within
     the same class, `reason` enum rewording), or a `category` change that
     crosses the benign/malicious boundary (the strength order itself
     changes, so direction is a human judgment, per ADR-0018 decision 8).
   - `envelope` — meta/totals-shape drift with identical rows (e.g.
     `armLabel` change, a totals field added without a schemaVersion bump —
     the ADR-0018 decision-6 precedent shows this legitimately happens).
     Reported as its own line, not mislabeled `internal`.
   - Direction comes from a strength order per expected-class:
     malicious `block > ask > pass`; benign `pass > ask > block`.

Classification is messaging only; all drift fails. No allowlist, no
acknowledged-regressions file: the mechanism for shipping a deliberate
weakening is updating the baseline in the same PR, where the row-level diff
is visible to review. ADR-0018 decision 8's recalibration policy thereby
gains a mechanical surface (an `expected` edit forces a baseline drift the
PR must commit), and the `recalibration` class exists precisely so the
design's flagship scenario is classifiable by its own table.

## Output contract (pinned wording)

The drift report is plain text (readable in raw GitHub Actions logs),
ids-only, terminal-sanitized. Four elements are **pinned as stable
contract** (tests assert them; prose around them may evolve):

1. A machine-readable line, always printed:
   `GATE_FAILURE=<none|false-block|drift|false-block+drift|internal>` —
   ADR-0018 decision 7 already warns exit codes are meaning-bearing;
   this keeps the two exit-1 causes scriptable without parsing prose.
2. The exit-1 drift remedy line, printed after the classification table:
   `Baseline drift detected. Run \`npm run redteam -- --update-baseline\`,
   review the diff, and commit eval/redteam/baseline.json. (The gate fails
   on improvements too — see docs/decisions/0019.)`
3. When the **only** drift kind is `new-case`:
   `This failure is expected: you added N case(s) not yet in the baseline.
   No existing behaviour changed — update the baseline to record them.`
   — the honesty principle made legible at the exact moment it's tested.
4. The exit-2 missing-baseline message is context-neutral (§Consumer
   contract): `no baseline found at <path>; in the agent-harness-JA repo,
   run --update-baseline and commit the result; outside it, pass
   --baseline <path>`.

## Update mechanics

- `redteam --update-baseline` — runs the corpus and rewrites the baseline
  (normalized canonical JSON), then reports what changed vs the previous
  baseline using the same classifier. Local and deliberate; never run in CI
  (the workflow step stays `node dist/cli.js redteam`).
  - **Refuses** (no write, exit 1) when `falseBlockCount > 0` — the absolute
    gate cannot be baselined away locally only to fail in CI anyway.
  - **Refuses** (no write, exit 2) when the totals backstop fails — update
    mode must never bake an internally-inconsistent scorecard into the
    baseline (that would make "fix it or update the baseline" a
    non-terminating loop).
  - Default path's parent (`eval/redteam/`) must already exist → else exit 2
    "run from the repo root" (no `mkdir -p` on the default path; running
    from a subdirectory must not silently write a nested nonsense file).
  - Write is temp-file-then-rename (no truncated JSON on interruption) and
    symlink-refused like every other write path.
  - Otherwise the command behaves normally (still writes the timestamped
    `--out` scorecard, still prints the markdown summary) — update mode is
    the normal run plus a baseline write.
- `--baseline <path>` — optional override of the default path (named
  constant beside `EVAL_OUT_DIR`), used by tests and by outside-repo
  invocations (§Consumer contract).

## Exit codes

Contract shape unchanged (ADR-0018 decision 7): `0` gate green; `1` gate
failure — false-block and/or drift, both reported in one run, distinguished
by the pinned `GATE_FAILURE=` line; `2` usage/infra — bad flags, missing/
oversized/symlinked/unparseable/non-validating/schema-mismatched baseline,
and totals-backstop (`internal`) failure. No new exit code.

## Consumer contract

`package.json` has a `bin` entry, so `redteam` is in principle an installed
command — but the npm `files` list excludes `eval/`, and the package is
**unpublished** (`0.1.0-pre`; publishing is a Week-4 item), so there are
zero external consumers today. Decision: compare-by-default ships now, and
`redteam`'s compare mode is declared a **repo/CI contract** in ADR-0019.
Outside the repo the command exits 2 with the context-neutral message
(§Output contract 4) pointing at `--baseline <path>`. The Week-4
npm-publish item inherits a recorded decision point: ship the baseline in
`files` with package-relative resolution, or document report-only usage.
Package-relative resolution is **not** built now (YAGNI pre-publish).

## Code placement

- `src/eval/scorecard/diff.ts` — producer-agnostic, id-keyed row differ,
  **generic over the concrete row type** (`R extends ScorecardRowCore<K>`)
  and comparing **all own fields** of each row, returning
  `{ identical, added[], removed[], changed[] }` with the changed field
  names. This is pinned because the flagship decision-9 regression
  (`block→ask` softening) changes **no core field** — `pass: true,
  failureKind: null` on both sides; only the extension field `verdict`
  moves. A core-fields-only differ would fail the gate with an *empty*
  changed list. `diff.test.ts` includes an extension-field-only change as
  a named case. Reuse caveat (ADR-0019): golden reuse would need a
  field-projection parameter — ADR-0017 decision 3 forbids diffing golden's
  volatile fields — and is not built.
- `src/eval/redteam/baseline.ts` — normalization (single implementation),
  hostile-input load/validation (§Baseline load), the strength-order
  classifier (all six classes), the independent totals re-derivation, and
  the drift-report renderer.
- **CLI extraction**: `cli.ts` is at ~750 lines against the 800 hard cap;
  E-3's flag parsing + compare wiring + exit mapping would cross it. The
  redteam command wiring moves to `src/cli/redteam-command.ts` (the
  composition root grows from one file to a folder; the eslint layering
  config's cli band is updated to `src/cli*` in the same commit, keeping
  the eval→cli import ban intact). `cli.ts` keeps parsing dispatch only.
- Golden gets **no** baseline: gitignored, live-key, banned from per-PR CI
  (ADR-0017). Only redteam wires the differ.

## Interaction with existing pieces

- `drift.test.ts` (non-gating diagnostic) stays: it compares live verdicts
  to `expected` (case-calibration drift); E-3 compares live scorecard to
  baseline (behaviour drift). Complementary; the diagnostic remains the
  early-warning channel that never fails the build.
- One new vitest e2e asserts the committed baseline matches live
  `runRedteam()` output after normalization. **CI ordering makes this test,
  not the CLI step, the first failure surface** (`npm test` runs before the
  Red-team gate step), so the e2e's failure message MUST be the same
  rendered classification report (`expect(drifts, renderDriftReport(...))
  .toEqual([])` shape) — otherwise CI's drift diagnosis in exactly the
  designed-for scenario would be a raw multi-KB vitest string diff and the
  classification table would never be seen.
- **Concurrent baseline-updating PRs** (accepted limitation, ADR-0019):
  two PRs each regenerate the baseline from different states; a clean
  textual merge can produce a baseline that is not the canonical output of
  the merged code → post-merge main goes red with no PR to blame. Classic
  snapshot-file semantic conflict (the Jest-doctrine failure mode carried
  over honestly). Mitigation: enable require-branches-up-to-date protection;
  recovery is a one-command regenerate commit. Solo-maintainer repo today.
- ADR-0016 §7 unchanged: the gate still scores the deterministic heuristic
  arm only. ADR-0018's "detection rate is never gated" gains a required
  clarifying sentence in the amendment: the *level* is never gated; the
  *delta* now always is (an honest new miss lands green **after** its
  baseline row is committed — the new-case message makes the loop legible).

## Documentation

- **ADR-0019** — leads with fail-on-any-drift vs asymmetric-ratchet
  reasoning (the latent-stale-baseline hole), cites the best-practice
  survey; records: the requirements-table SQLite deviation + acceptance
  mapping; the repo/CI consumer contract + Week-4 publish decision point;
  the removed-case-fails rule; the no-new-exit-code decision; the
  concurrent-PR limitation; the golden-reuse caveat; a note that a one-row
  change produces a two-hunk baseline diff (row + totals moving in
  lockstep — correct, not noise).
- **ADR-0018 amendments** — decision 9's Revisit-if fires (E-3 closed the
  ship-window limitation); decision 8 notes recalibration edits now surface
  mechanically; the level-vs-delta sentence above.
- **`process/01-requirements.md`** — E-3 row amended (SQLite → committed
  canonical-JSON baseline), deviation cross-referenced to ADR-0019.
- **`docs/security-model.md`** — one entry: the keyless gate command now
  reads repo-controlled data (`baseline.json`); hostile-baseline handling
  per §Baseline load.
- **USAGE string** gains `redteam [--out <dir>] [--update-baseline]
  [--baseline <path>]`; **README** gains a `redteam` quick-start line
  parallel to `eval`'s; **`package.json`** gains
  `"redteam": "node ./dist/cli.js redteam"` (the remedy text in §Output
  contract uses it).
- **`.gitattributes`** committed (baseline `text eol=lf`).
- Week-plan E-3 checkbox + checkpoint paragraph updated ("once E-3 lands"
  becomes present tense).
- `docs/eval-methodology.md` remains a separate week-plan item.

## Out of scope

- E-4 adversarial verification (separate item).
- Golden-scorecard baselines (banned from per-PR CI; ADR-0017).
- Any change to corpus content, scan rules, or detection semantics.
- Mechanical enforcement of ADR-0018 decision 8's *justification* judgment
  (still human; E-3 only makes the edit visible).
- Package-relative baseline resolution (Week-4 publish decision).

## Testing (TDD)

- `diff.test.ts` (scorecard core): equal sets, added, removed, changed
  fields, **extension-field-only change (verdict moves, core fields
  identical)**, id-pairing stability under reorder, `__proto__` as an id
  (Map pairing), empty rows.
- `baseline.test.ts` (redteam): normalization fixture pin (volatile fields
  dropped, everything else kept); classifier table — every verdict
  transition × benign/malicious → regression/improvement, plus the
  `recalibration` cases (expected-only change, reason rewording,
  cross-class category change), `envelope` (armLabel/totals-shape drift),
  removed-id → regression with rename hint, added-missed → new-case;
  hostile-baseline fixtures: bad id charset, `__proto__` id, oversized
  file, symlinked path, malformed shape, schemaVersion/producer mismatch —
  each → the right typed error; independent totals re-derivation trips on
  a corrupted fixture (and on a corrupted `corpusSize`).
- CLI: `--update-baseline` writes normalized canonical bytes atomically;
  refuses on false-block (exit 1, no write) and backstop failure (exit 2,
  no write); missing parent dir → exit 2; compare-path exit codes (0 equal;
  1 drift; 1 falseBlock-with-equal-baseline; 1 both-with-single-combined-
  report; 2 missing baseline; 2 bad flag); non-canonical-but-semantically-
  equal → the §Gate-rule-5 message; pinned `GATE_FAILURE=` line and remedy
  wording (§Output contract) asserted literally; drift report reaches
  stdout before exit and is terminal-sanitized.
- E2E: committed `eval/redteam/baseline.json` matches live `runRedteam()`
  after normalization, with the classifier's rendered report as the
  assertion message.

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
