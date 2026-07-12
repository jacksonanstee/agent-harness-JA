# Differential Review — E-4 Adversarial Verifier (milestone gate)

- **Branch:** `feat/eval-e4-adversarial-verifier` @ `8fd826d` (nit fixes landed after review at `dfca9d4`)
- **Base:** `main` @ `277cdea` (merge-base)
- **Date:** 2026-07-12
- **Method:** three parallel review dimensions (Fable-inherit), full-branch diff (19 commits, 29 files, +3,780/−358) plus live-source and git-history probes. Ran after the per-task SDD review gates and the whole-branch `/review3` (0 CRIT; 1 HIGH + 1 MEDIUM found, fixed, and verifier-confirmed at `b0ca8c6`/`07e0b9e`/`8fd826d`).

## Verdict: SOUND-WITH-NITS

Zero CRITICAL / HIGH / MEDIUM findings across all three dimensions. Fifteen LOW findings; the six worth fixing were fixed same-session (`dfca9d4`), the rest are recorded below as accepted.

## Dimension 1 — Regression / behavior preservation (PASS)

All seven checks passed, with mechanical evidence rather than assertion:

1. **CLI extraction is a verified pure move vs main.** `composeSecurity`, `SettingsLoadError`, `hookRecordToTelemetryInput` bodies byte-identical between main's `cli.ts` and `cli/shared.ts` (doc-comment location note is the only text change). `parseEvalArgs`/`runEval` identical except the additive `--challenge` branches. `cli.test.ts` logic unmodified; four `parseEvalArgs` tests re-homed to `eval-command.test.ts` with equal-or-stronger assertions.
2. **Plain `eval` is bit-for-bit main behavior.** No verifier dep → `verification` key structurally absent → canonical JSON byte-identical; exit codes, R-10 warning, write-before-stdout contract unchanged.
3. **redteam / E-3 baseline untouched.** Zero diff under `src/eval/redteam/` and `cli/redteam-command.ts`; `baseline.json` byte-identical; redteam has no `createGoldenRunner` dependency.
4. **Phase-1 runner semantics unchanged**; `redactSecrets ?→required` verified supplied at every production and test call site.
5. **Markdown delta is exactly the spec-pinned state-1 line.**
6. **CI workflow untouched; 784→831 tests (later 835) with no assertion deletions** (all removed test-file lines are import/relocation).
7. **session/security/memory/telemetry/hooks/router/skills/internal: zero diff.**

Accepted LOWs: type-only re-export narrowing on the bin module (`EvalArgs`, `SecurityComposition`, `ComposeSecurityDeps` no longer re-exported from `cli.ts`; zero consumers — noted in PR body); `EvalArgs` gained a required field (no external constructors); trailing-newline cosmetic; `[--challenge]` now in every USAGE error (correct).

## Dimension 2 — Seam & composition trace (SOUND)

All six end-to-end traces clean; seam-relevant suites re-run green (85/85).

- **--challenge flow re-derived hop-by-hop:** one finding per pass row, so section totals always sum to `totals.passed`; `verification.totalCostUsd` never folds into golden `totals` (no double count); `unpricedChallenges` = attempted-call-with-unknown-cost, consistent across runner, ADR-0020 §5, and the rendered cost line. `route()` statically cannot throw for the pinned descriptor; the throw guard (`challengeOutput`) plus `createVerifier`'s own fail-open make phase 2 double-walled.
- **onProgress seam carried:** the existing `runEval` stderr consumer prints the new phase-boundary lines; stdout stays scorecard-only; runner never touches stdio.
- **Invariance is end-to-end by composition:** runner-level rows/totals equality (invariance test) + the single shared exit-derivation line reading only `totals.failed` + no challenge-only early return that can diverge. No CLI-level exit-equality e2e test exists — closed by construction, worth one sentence in `docs/eval-methodology.md` (deferred to Week-3 close).
- **Canonical JSON determinism preserved;** `cleanForScorecard` correctly bypassed by the section (ids charset-pinned upstream, enums closed, model id escaped at render).
- **Composition-root hygiene:** keyless plain eval identical to main; single SDK import; `--challenge` needs no extra env.
- **adversaryModelId single-source** (one `route()` result end to end) — the T2 dual-source note is resolved in code.

Accepted LOWs: ADR §10.4 unpriced shorthand (fixed `dfca9d4`); `≥` cost-marker style divergence (challenge cost copy is spec-pinned — kept); unreachable arm of the accounting guard (kept deliberately: it defends against a Verifier *returning* `no-output`); third module-scope ajv compile on CLI load (marginal); `cli.ts` re-export comment overclaim (fixed `dfca9d4`).

## Dimension 3 — Adversarial delta + docs parity (PASS)

**Attack-surface delta vs main, each with verified ceiling:**

| Surface | Ceiling |
|---|---|
| Malicious repo → `taskPrompt` → adversary (unredacted by design, documented) | Enum noise + wasted spend; oneOf parse + post-validation enum + de-fang (maxTurns 1, deny-all PreToolUse) + per-call nonce hold |
| Hostile `Verifier`/`AdversaryFn` via deps | Noise never authority — throw guard confirmed; nothing keys off returned `finding.taskId` (runner-side pairing); exit reads only `totals.failed`, invariance-tested |
| New egress channel (redacted output → same-provider adversary) | redact-before-egress enforced; redaction failure → no call |
| `--challenge` spend | N ≤ passed-tasks-with-output; warning informational; strictly dominated by phase-1 spend main already had |

Findings (all LOW, report-noise ceiling): unescaped `status`/detail cells in the verification table (hostile-Verifier row spoofing — **fixed `dfca9d4`**, cells now escaped + test); non-finite `costUsd` rendering garbage (**fixed `dfca9d4`**, `Number.isFinite` guards in runner accumulation and `buildAdversary`); unbounded N (accepted + documented).

**Docs parity:** fix-wave-touched surfaces (ADR §5 retention wording, security-model entry, architecture signatures) verified against HEAD; no doc claims "verifier never throws" beyond the accurately-scoped `createVerifier` comment. Two stale quantitative claims found and **fixed `dfca9d4`**: ADR §5's call-site miscount (true numbers: 14 sites, ~12 omitting; `identityRedact` introduced in the migration commit) and the design doc's retention sentence (superseded-at-implementation note added pointing to ADR-0020 §5). Requirements E-4 row is consistent with what T11 delivers (live operator run + CI-enforced fake-adversary invariance test).

## Fixes landed from this review

`dfca9d4` — escape verification `status`/detail cells (+hostile-string test), `Number.isFinite` cost guards (+3 TDD tests), ADR §5 count correction, design-doc supersession note, ADR §10.4 unpriced precision, `cli.ts` re-export comment. 835/835 tests, lint/typecheck/build clean, redteam gate exit 0.

## Deferred (accepted, non-blocking)

- CLI-level exit-equality sentence for `docs/eval-methodology.md` (Week-3 close item).
- Type-only re-export narrowing on `cli.ts` (PR-body note).
- Trailing newline / USAGE cosmetics; ajv module-scope compile; `≥` marker style.
- Pre-existing ledger minors from per-task reviews (recorded in `.superpowers/sdd/progress.md`), none elevated by any whole-branch pass.
