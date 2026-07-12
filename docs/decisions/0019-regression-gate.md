# ADR-0019: Deterministic red-team regression gate — fail on any drift vs a committed baseline (E-3)

- **Status:** Accepted
- **Date:** 2026-07-12
- **Requirements:** E-3 (MUST) — with a recorded deviation against the
  requirements table itself (§Decision 2)
- **Relates to:** ADR-0018 (red-team corpus — this gate closes its decision
  9 ship-window limitation; its decision 7 exit-code wording is amended by
  this PR), ADR-0017 (scorecard core — the differ lives beside
  `toCanonicalJson`), ADR-0016 (§7: the gate scores the deterministic
  heuristic arm only)

## Context

E-2's CI gate was `falseBlockCount === 0` alone. ADR-0018 decision 9 names
the consequence: a malicious case's verdict can soften from `block` to `ask`
— or the whole scanner's blocking posture can erode — while every PR stays
green, because detection-based pass/fail counts `ask` as detected and
`falseBlockCount` is unmoved. E-3 converts the committed scorecard into a
baseline and fails CI on any behaviour drift, closing that window.

**The load-bearing choice: fail on ANY drift, improvements included.** The
external best-practice survey (2026-07-10; promptfoo CI docs and
promptfoo-action, OpenAI cookbook regression example, Braintrust
baseline-experiment docs, LangSmith eval docs, Kinde CI-for-evals guide,
Jest snapshot doctrine, Semgrep `--baseline-commit`, gitleaks
`--baseline-path`, GitHub code-scanning PR triage, Betterer, Hamel Husain /
Arize on per-example error analysis) converges on per-row asymmetric diff
against a committed, explicitly-updated baseline — weakenings fail,
improvements warn (the "ratchet"). That asymmetric ratchet leaves a latent
hole this ADR refuses: **an unrecorded improvement makes the baseline
stale, and a later slide back to the old state diffs clean** — the
regression is invisible precisely because the improvement was tolerated.
Betterer works around this by auto-committing the ratchet file; our CI
cannot commit, so the honest equivalent is fail-on-any-drift: the committed
baseline must always byte-match reality. This also matches the operator's
DEC-0016 done-gate rule (pinned derived values re-derive and fail on
drift) and keeps the baseline PR-diff an always-current review surface.
The asymmetry lives in the *messaging* — each drifted row is classified — 
and in review scrutiny, not in the gate. Aggregate-only gating (the weakest
surveyed pattern) was rejected outright: offsetting flips net to zero.

## Decisions

1. **Gate rule: compare-by-default, one combined report, all checks run.**
   `cli redteam` (the same keyless command CI already runs) now: runs the
   corpus; applies the baseline-independent absolute gate
   (`falseBlockCount === 0` — a false block fails even if the baseline also
   recorded it); re-derives totals and `meta.corpusSize` independently from
   the fresh rows (a deliberate second implementation, not importing
   `runRedteam`'s totals code — the DEC-0016 backstop; mismatch = producer
   bug → `internal` → exit 2, because "update the baseline" cannot fix a
   producer bug); loads and validates the baseline as hostile input; then
   compares canonical strings. Byte-equal → pass. Byte-unequal but
   semantically equal after parse (hand-edited key order, CRLF that escaped
   git) → fail with the distinct message `baseline file is not canonical —
   regenerate with --update-baseline`. Any semantic drift → fail.

2. **The baseline is committed canonical JSON, not SQLite — a recorded
   deviation against the requirements table.** `process/01-requirements.md`'s
   E-3 row said "persisted in SQLite with a stable schema; regression
   detection compares runs," phrased before E-1/E-2 made the scorecard a
   byte-stable canonical-JSON artifact. A database table would add a
   dependency and a schema-migration surface to reproduce what
   `toCanonicalJson` already guarantees. The same PR amends the table and
   cross-references this ADR. The requirement's acceptance clause
   ("regression test detects a deliberately-broken baseline") is met by the
   corrupted-fixture tests in `src/eval/redteam/baseline.test.ts` (the
   independent totals re-derivation trips on a corrupted fixture and on a
   corrupted `corpusSize`) plus the e2e negative check (a flipped verdict
   fails with the classified report).

3. **Six-class drift taxonomy — messaging only; all drift fails.**
   Direction comes from a strength order per expected-class: malicious
   `block > ask > pass`; benign `pass > ask > block`.

   | Class | Meaning |
   |---|---|
   | `regression` | Paired row whose verdict weakened; **or a baseline id absent from the fresh run** (removed-case-fails rule — the report line carries the rename hint: renames are remove+add; if intentional, update the baseline) |
   | `improvement` | Paired row whose verdict strengthened |
   | `new-case` | Fresh id absent from baseline, any outcome — an honestly-missed new case is drift only because the baseline must record it, never a demand to curate the case away; when it is the *only* drift kind, the report says so explicitly |
   | `recalibration` | Paired row, verdict transition not orderable: same verdict but another field changed (`expected`, `category` within the same class, `reason` enum rewording), or a `category` change crossing the benign/malicious boundary — direction there is a human judgment (ADR-0018 decision 8) |
   | `envelope` | Meta/totals-shape drift with identical rows (e.g. `armLabel` change, a totals field added without a schemaVersion bump — the ADR-0018 decision-6 precedent shows this legitimately happens); its own line, never mislabeled `internal` |
   | `internal` | Totals backstop mismatch — producer/differ bug, exit 2, infra not gate failure |

   No allowlist, no acknowledged-regressions file: the mechanism for
   shipping a deliberate weakening is updating the baseline in the same PR,
   where the row-level diff is visible to review. ADR-0018 decision 8's
   recalibration policy thereby gains a mechanical surface — an `expected`
   edit forces a baseline drift the PR must commit.

4. **Row-determinism contract (binding).** Every field on a scorecard row —
   core (`id`, `pass`, `failureKind`) and redteam extensions (`category`,
   `verdict`, `expected`, `reason`) — must be deterministic and
   non-volatile: same corpus + same scanner ⇒ same bytes. Volatility is
   permitted only in `meta`, where the single normalization implementation
   (`normalizeForBaseline`) strips it (`createdAt`, `harnessVersion`
   dropped; everything else kept). Any future field added to a row type
   must satisfy this contract, or must instead live in `meta` and be added
   to the normalization's dropped list — with its pinning fixture updated —
   in the same change. Otherwise the gate degrades into spurious drift on
   every run, forcing reflexive `--update-baseline` and reintroducing the
   rubber-stamp failure mode this design exists to avoid. The normalization
   fixture pin in `baseline.test.ts` is the mechanical tripwire.

5. **The baseline is hostile input.** `docs/security-model.md`'s attacker
   model puts a malicious cloned repo in scope, and `baseline.json` is the
   keyless gate command's first read of repo-controlled data. Load order:
   size cap before read (1 MB, `stat` first), symlink refusal (file and
   parent), full structural validation against an exact field allowlist
   (ajv, the ADR-0017 precedent), every baseline row id re-validated
   against the same `^[a-z0-9][a-z0-9-]{0,63}$` charset `runRedteam`
   enforces (the fresh side is guarded inside `runRedteam`; the baseline
   side bypasses that guard, so it gets its own check — this also excludes
   `__proto__`/`constructor`), `Map`-based row pairing (never a
   plain-object index), and the drift report written through the CLI's
   existing `sanitizeForTerminal`. `schemaVersion` or `producer` mismatch →
   exit 2, never a best-effort diff.

6. **No new exit code; `GATE_FAILURE=` line scoped precisely.** Contract
   shape unchanged from ADR-0018 decision 7 (as amended): `0` gate green;
   `1` gate failure — false-block and/or drift, both reported in one run;
   `2` usage/infra. The machine-readable line
   `GATE_FAILURE=<none|false-block|drift|false-block+drift|internal>` is
   printed on every run that **reaches gate evaluation**. Usage and
   baseline-load failures (bad flag; missing/oversized/symlinked/malformed/
   schema-mismatched baseline) exit 2 *without* the line — their typed
   error message is the signal; `internal` is the one exit-2 case that does
   print it, because the run reached the gate machinery. The
   non-canonical-baseline branch prints `GATE_FAILURE=drift`. This keeps
   the two exit-1 causes scriptable without parsing prose. Update mode
   prints the line only on its refusal paths; a successful
   `--update-baseline` run is not a gate run and prints no line, exiting 0
   regardless of how the new baseline differs from the old (otherwise the
   remedy command would exit 1 in exactly the drift scenario it exists to
   resolve).

7. **Repo/CI consumer contract; Week-4 publish decision point.**
   `package.json` has a `bin` entry, so `redteam` is in principle an
   installed command — but the npm `files` list excludes `eval/`, and the
   package is unpublished (`0.1.0-pre`), so there are zero external
   consumers today. Compare-by-default ships now, declared a **repo/CI
   contract**: outside the repo the command exits 2 with a context-neutral
   message pointing at `--baseline <path>`. The Week-4 npm-publish item
   inherits a recorded decision point — ship the baseline in `files` with
   package-relative resolution, or document report-only usage.
   Package-relative resolution is **not** built now (YAGNI pre-publish).

8. **Branch protection MUST (operational, recorded).** Two concurrent
   baseline-updating PRs each regenerate the baseline from different
   states; a clean textual merge can produce a baseline that is not the
   canonical output of the merged code → post-merge `main` goes red with no
   PR to blame — the classic snapshot-file semantic conflict (the
   Jest-doctrine failure mode, carried over honestly). **`main` MUST have
   require-branches-up-to-date protection enabled from the moment the
   baseline lands** — an operational control, but a recorded MUST the E-3
   PR checklist verifies, not a suggestion a future multi-contributor phase
   can silently lack. Recovery from a slipped-through conflict is a
   one-command regenerate commit. Accepted limitation on a solo-maintainer
   repo today.

9. **Golden gets no baseline; differ reuse is a recorded caveat.** The
   row differ (`src/eval/scorecard/diff.ts`) is producer-agnostic, generic
   over the concrete row type, and compares **all own fields** — pinned
   because the flagship decision-9 regression (`block→ask` softening)
   changes no core field (`pass: true, failureKind: null` on both sides;
   only the extension field `verdict` moves). A core-fields-only differ
   would fail the gate with an *empty* changed list. Golden reuse would
   need a field-projection parameter — ADR-0017 decision 3 forbids diffing
   golden's volatile fields (cost/turns) — and is **not built**. Golden
   scorecards stay gitignored, live-key, banned from per-PR CI (ADR-0017).

10. **A one-row change produces a two-hunk baseline diff — correct, not
    noise.** The drifted row and the totals move in lockstep (the totals
    are derived from the rows, and the backstop re-derives them
    independently). Reviewers should expect both hunks; a row hunk with no
    totals hunk (or vice versa) is itself suspicious.

## Consequences

### Positive

- ADR-0018 decision 9's ship-window limitation is closed: block→ask
  softening now fails CI on the PR that causes it, with a classified
  per-row report naming the exact transition.
- The detection *level* is still never gated (ADR-0018's honesty
  principle survives intact); the *delta* now always is. An honest new
  miss lands green after its baseline row is committed — the new-case
  message makes that loop legible at the exact moment it's tested.
- The baseline PR-diff is an always-current review surface: every
  behaviour change of the scanner is visible as a row-level diff in the PR
  that ships it, classified by direction.
- CI ordering makes the vitest e2e (`baseline-e2e.test.ts`), not the CLI
  step, the first failure surface (`npm test` runs before the red-team
  gate step) — and its assertion message is the same rendered
  classification report the CLI prints, so drift diagnosis in CI is never
  a raw multi-KB string diff.

### Negative / accepted

- Fail-on-any-drift means improvements block merges until the baseline is
  regenerated — one extra command (`npm run redteam -- --update-baseline`)
  on every behaviour-changing PR. Accepted: the alternative (ratchet) is
  the latent-stale-baseline hole named in §Context.
- Snapshot rubber-stamping remains the known failure mode of this whole
  pattern family: a contributor can run `--update-baseline` reflexively
  and commit whatever comes out. Mitigated, not eliminated, by the small
  canonical baseline (review-readable diffs), the classified report naming
  each change's direction, and the update command's own refusal paths
  (false-block and backstop failures cannot be baselined away).
- Concurrent baseline-updating PRs can go red post-merge (decision 8) —
  accepted with the branch-protection MUST as the control.
- The requirements table said SQLite; the shipped artifact is canonical
  JSON (decision 2). Recorded here and amended in the table rather than
  silently drifted.

## Alternatives considered

1. **Asymmetric ratchet (weakenings fail, improvements warn)** — the
   surveyed consensus. Rejected for the latent-stale-baseline hole: an
   unrecorded improvement leaves the committed baseline stale, and a later
   regression back to the recorded state diffs clean. Betterer solves this
   by auto-committing; CI here cannot commit.
2. **Aggregate-only gating** (fail if totals worsen). Rejected — the
   weakest surveyed pattern; offsetting flips net to zero and vanish.
3. **SQLite persistence with SQL diff** (the original requirements-table
   phrasing). Rejected as superseded: the canonical-JSON scorecard already
   guarantees byte-stable comparison; a database adds a dependency and
   migration surface for no additional detection power (decision 2).
4. **An acknowledged-regressions allowlist file.** Rejected — it recreates
   the ratchet's staleness problem in a second file and moves the review
   surface away from the baseline diff.
5. **Normalizing CRLF away on baseline load.** Rejected — it weakens
   byte-equal semantics; the fix is pinning the bytes in git
   (`.gitattributes`, `eval/redteam/baseline.json text eol=lf`).
6. **A new exit code for drift.** Rejected — ADR-0018 decision 7 already
   warns exit codes are meaning-bearing; the `GATE_FAILURE=` line
   distinguishes the two exit-1 causes without breaking the contract shape
   (decision 6).

## Revisit if

- The Week-4 npm-publish item lands — decision 7's recorded decision point
  fires: ship the baseline in `files` with package-relative resolution, or
  document report-only usage outside the repo.
- The repo gains a second regular contributor — decision 8's
  branch-protection MUST stops being a formality, and the concurrent-PR
  limitation deserves re-scoring.
- A future scorecard row field cannot satisfy the row-determinism contract
  (decision 4) and cannot live in `meta` — that would force a redesign of
  the normalization boundary rather than a quiet exception.
- Golden ever needs regression detection — build the field-projection
  parameter (decision 9), do not widen the all-own-fields differ in place.
- Reflexive `--update-baseline` rubber-stamping is ever observed in review
  — that is the signal to add friction (e.g. a required justification
  trailer), per the same escalation path as ADR-0018 decision 8.
