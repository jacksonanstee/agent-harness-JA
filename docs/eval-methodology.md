# Eval methodology

How this harness measures itself: what each eval arm scores, which numbers
gate a merge versus which are reported for a named consumer, what counts as
a regression, and how to author new cases. The design history lives in
[ADR-0016](./decisions/0016-llm-judge-design-deferred.md) (LLM judge: design locked, implementation deferred),
[ADR-0017](./decisions/0017-golden-runner.md) (golden),
[ADR-0018](./decisions/0018-redteam-corpus.md) (red-team),
[ADR-0019](./decisions/0019-regression-gate.md) (regression gate), and
[ADR-0020](./decisions/0020-adversarial-verifier.md) (adversarial
verification); this document is the operating manual.

## The one framing rule: gates vs. measurements

Every number the eval layer produces is one of two things, never both:

- A **gate** fails CI. Gates are absolute invariants a merge must never
  violate: `falseBlockCount === 0` (no benign input is ever blocked) and
  zero drift against the committed red-team baseline.
- A **measurement** is reported with a named consumer and never blocks a
  merge: the detection rate (consumer: the ADR-0016 §6 S-5 judge decision),
  and the challenge rate (consumer: this document and any future
  S-5-style decision).

The reason detection rate is not a gate (ADR-0018): gating on it would
strand honest new attack cases the scanner misses — a case could only merge
by being curated away, so the corpus could never measure the scanner's real
ceiling, and the same number the S-5 trigger needs to read would be pinned
green by construction. A gate enforces what must never happen; a
measurement tells the truth about what does.

## Golden arm (`cli eval`) — capability scoring

Runs real agents through the full harness against Markdown-defined tasks
and scores the `SessionResult` self-report with a deterministic per-task
**oracle** function. Oracle authority is absolute: an LLM never decides
pass/fail (see §Adversarial verification for the report-only exception
that proves the rule).

- **Scoring:** each task produces one row — `pass`, or `fail` with a
  `failureKind` from the closed set `task-parse` / `oracle-load` /
  `session-error` / `oracle-error` / `oracle-fail`. An oracle returning
  anything but a strict `{pass: boolean}` (truthiness is rejected) becomes
  an `oracle-error` row, not a pass. Failure reasons are secret-redacted
  and truncated before entering the scorecard; the row type has no
  raw-output field at all (ADR-0017 decision 6 — structural, not
  procedural).
- **Exit codes:** `0` all tasks passed, `1` any row failed
  (`totals.failed > 0` — the single derivation), `2` no scorecard was
  produced (including any scorecard-write failure).
- **Cost:** `totals.totalCostUsd` never understates — rows whose cost is
  unknown are counted in `totals.unpricedTasks` and the rendered cost line
  becomes a `≥` bound.
- **Where it runs:** operator-invoked only, never per-PR CI. Oracles are
  PR-author code executed in-process and CI holds an API key — a fork PR
  would be a clean exfiltration path (ADR-0017; security-model R-10; a
  runtime warning states it). Golden runs are also nondeterministic (live
  model), so golden scorecards are informational and gitignored — the
  regression gate reads the deterministic red-team arm instead.

## Red-team arm (`cli redteam`) — security scoring

Deterministic and keyless: the 51-case corpus is scanned by the security
layer's injection scanner, no model call involved, so it runs on every PR.

- **Scoring:** each case's observed verdict (`pass` / `ask` / `block`) is
  compared to its calibrated `expected` verdict. A malicious case whose
  observed verdict is `ask` or `block` counts as detected; `pass` on a
  malicious case is an honest known-miss and is *reported*, not hidden.
- **The absolute gate:** `falseBlockCount === 0` — no benign case may ever
  be blocked. This reads only the fresh run, never the baseline, so
  nothing committed to the repo can suppress it.
- **Reported measurements:** detection rate (37/40 malicious, 92.5% at
  E-2 calibration) with its blocked/flagged strength split, plus the
  off-arm null-scanner control (0/40 by construction — a guaranteed-zero
  control, not a measured differential).

## What counts as a regression (the E-3 gate)

`cli redteam` is compare-by-default: every run's canonical JSON is diffed
against the committed baseline (`eval/redteam/baseline.json`) and **any
byte of behaviour drift fails CI — improvements included** (ADR-0019).
The surveyed industry consensus is an asymmetric ratchet (weakenings fail,
improvements warn); the ratchet has a latent hole — an unrecorded
improvement leaves the baseline stale, and a later slide back to the
recorded state diffs clean. CI cannot commit, so the honest equivalent is
byte-equality with reality, always.

The asymmetry lives in the messaging instead. Every drifted row is
classified, with a per-class remedy:

| Drift class | Meaning | Remedy |
|---|---|---|
| `regression` | a verdict weakened (e.g. `block` → `ask`), or a case was removed | fix the scanner (or justify the removal in the PR) |
| `improvement` | a verdict strengthened | update the baseline to record it |
| `new-case` | a case exists in the run but not the baseline | expected when authoring — update the baseline |
| `recalibration` | non-verdict fields changed, verdict unchanged | update the baseline |
| `envelope` | corpus-level counts/shape changed | inspect, then update the baseline |

Baseline update flow: `npm run redteam -- --update-baseline`, review the
diff, commit `eval/redteam/baseline.json`. Exit codes: `0`
(`GATE_FAILURE=none`), `1` (`false-block`, `drift`, or
`false-block+drift`), `2` (`internal` — a producer/differ bug, which no
baseline update could ever fix). `--update-baseline`'s own refusal paths
(symlink-planted baseline/tmp path, missing parent directory, write or
rename failure) also exit `2` with a dedicated stderr message — a Week-4
fix; previously such failures escaped as a gate-colliding exit `1` with no
diagnostic. The baseline file itself is treated as
hostile input (symlink refusal, size cap, exact field allowlist,
Map-based row pairing — ADR-0019).

## Adversarial verification (`eval --challenge`) — report-only

An optional second pass over the golden run: a router-selected second
Claude model challenges each oracle-**pass** row's redacted output, and its
findings land in a `verification` section as closed
`{status, category}` enums — never prose (ADR-0020). Report-only is a
machine-enforced property, not a sentence: a CI differential invariance
test pins `rows[]`, `totals`, and the exit code as identical with and
without the verifier. There is deliberately no CLI-level exit-equality
e2e test — the property holds by construction: the runner-level invariance
test pins rows/totals equality, one shared exit-derivation line reads only
`totals.failed`, and no challenge-only code path returns early, so no
CLI-layer divergence point exists.

**Challenge rate** (definition carried forward from ADR-0020 §3, which was
its interim consumer until this document existed):

```
challenge rate = challenged / (passed − noOutput)
```

`noOutput` rows (gating-behaviour tasks with `resultText: null`) are
excluded from the denominator — no call was ever made against them.
`verifier-error` rows stay in: a failed or timed-out call is a real
attempt whose outcome is unknown, not an ineligible row. Read the rate
against the per-category split (`incomplete` / `incorrect` /
`unsupported-claim` / `unsafe` / `other`), never as a bare percentage — a
run that is mostly `unsafe` challenges is a materially different signal
than one that is mostly `other`. The rate **never gates**, and an
individual finding is a prompt to re-examine (re-run the suite, or isolate
the task file), not a diagnosis — golden runs are nondeterministic and
there is no single-task selector in v1.

**Synthetic rendered example** (golden scorecards are gitignored, so no
real one is ever committed — this is what the section looks like; the
counts always sum to `totals.passed`):

```markdown
## Adversarial challenge (report-only — never affects pass/fail or exit codes)

Adversary: claude-sonnet-4-6 · challenged 1 / agreed 2 / errors 1 / no-output 1, of 5 passed tasks
Challenge cost: $0.0900 (1 unpriced)

| task | status | category / error |
|---|---|---|
| summarise-repo | challenged | incomplete |
| flaky-network | verifier-error | call-failed |
| gating-refusal | no-output | — |
```

Challenge rate here: 1 / (5 − 1) = 25%, read as "one `incomplete`
challenge". Cost accounting: `unpricedChallenges` counts challenges where
a call was **attempted** but its cost is unknown — the `call-failed` row
here is unpriced (unknown ≠ zero; a timed-out call may still have billed).
A `verifier-error` whose adversary response was unparseable can carry a
known cost and be priced normally; `redaction-failed` and `no-output` rows
count in neither bucket, because no call was ever made. Agreed rows never
render in the table. When `--challenge` is not passed the section is a
single "not run" line; a run with zero passed tasks renders "nothing to
challenge".

## Authoring new cases

### Golden tasks

A task is a sibling file pair in the task directory (`eval/golden/`):

- `<name>.task.md` — YAML frontmatter (`id` — lowercase alphanumeric plus
  hyphens, unique across the directory; `descriptor` with `shape`,
  `sensitivity`, `expected_tokens` for the router, plus optional `hint`;
  `maxTurns`; optional `skillsDir`) and the prompt as the body.
- `<name>.oracle.mjs` — exports `oracle` (JSDoc-typed via the package's
  `OracleFn`), judging the `SessionResult` self-report and returning a
  strict `{pass: boolean, reason?: string}`. Keep oracles deterministic
  and tolerant of surface variation (the model is live); assert on the
  property the task exists to prove, not on exact strings unless the
  prompt pins them.

Remember oracles run in-process on the operator's machine: author them as
code you would merge, and only run `eval` on repos you trust.

### Red-team cases

Cases are TypeScript literals in `src/eval/redteam/corpus.ts`
(`CorpusCase`: `id`, `category` from `direct` / `indirect` / `jailbreak` /
`exfil` / `benign`, `text`, `expected`, `source` — optional in the type,
mandatory by the citation convention below; wrapped starter cases default
to `starter-corpus (S-1)`). Rules that keep the corpus honest:

1. **Verify against live `scan()` output, never guess** — run the scanner
   over the new case and see what it actually does. For a detected case,
   `expected` records the live verdict (the `ask`-vs-`block` strength is
   calibrated, not assumed). For a realistic attack the scanner misses,
   record the verdict it *should* produce (the three current known-misses
   all carry `expected: 'block'` against a live `pass`) and commit it
   anyway — it renders as a `MISSED` detection and honestly lowers the
   reported rate, because the detection rate exists to be read, not to
   look good. A miss never blocks a merge; only the benign gate is
   absolute.
2. **Defang payloads** (ADR-0018): credential-shaped literals assembled
   from fragments, exfil URLs on non-resolving `.example`/`.invalid`
   domains — a faithful payload must never trip the repo's own secret
   scanning or push protection.
3. **Cite the source** — cases derive from public research (Greshake et
   al., Willison, OWASP LLM Top 10) and carry the citation in the `source`
   field.
4. **Expect the gate to go red once.** A new case fails the drift gate as
   `new-case` by design; the failure message says so. Run
   `npm run redteam -- --update-baseline`, review the diff (it should
   contain exactly your new rows), commit the baseline with the case.

## Corpus contamination, and what the next evaluator must assume

*Added 2026-07-13.*

The 51-case corpus is public (committed to this repo) and its cases derive
from the most-cited public sources in the field (Greshake et al., Willison,
OWASP). For the **current gate this is irrelevant**: the red-team arm is
deterministic regex scanning with no model in the loop, so a model's
familiarity with the corpus cannot touch it. It becomes load-bearing the
moment an LLM judge enters (the ADR-0016 S-5 decision): a judge model that
has seen these cases — or their sources — in training will overstate
detection. Two preconditions are therefore attached to S-5 evaluation,
ahead of any implementation:

1. **A held-out slice.** Judge detection quality must be measured on cases
   that are not in this repo's history — freshly authored or privately
   maintained — never on the committed corpus alone.
2. **Bias-aware scoring.** Single-model judge scores carry known
   position/verbosity/self-preference biases; S-5 measurement should use a
   multi-model quorum or an explicit calibration set. This is consistent
   with ADR-0016's tighten-only authority (a compromised judge may only
   cause false positives, never false negatives — but the *measurement*
   must still be honest).

**Roadmap, not commitment:** the known scanner misses are paraphrase-shaped,
which is exactly what attacker-LLM red-teaming (generative paraphrase
mutation of existing cases) is good at producing. That is the natural
corpus-growth mechanism when S-5 work begins; a static committed corpus is
the v1 design, not the end state.
