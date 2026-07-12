# Differential Security Review — E-3 Regression-Gate Milestone Gate

**Branch:** `feat/eval-e3-regression-gate` @ 2f2004e (vs `main`)
**Diff:** `git diff main...HEAD` — 20 commits, 29 files (+3,878 / −194): new hostile-input baseline loader + drift classifier (`src/eval/redteam/baseline.ts`), producer-agnostic all-own-fields row differ (`src/eval/scorecard/diff.ts`), `src/cli/` extraction (`shared.ts` + `redteam-command.ts`), compare-by-default gate with `--update-baseline` atomic write + symlink guards, committed canonical baseline (`eval/redteam/baseline.json`), eslint layering extension for `**/cli/**`, `.gitattributes` EOL pin, ADR-0019 + amendments.
**Reviewer:** differential-review (whole-branch milestone gate; the 3-agent panel already ran on the last session's commits — findings fixed in 1ea1ee9/2f2004e — so this pass targets the code commits `c6a7ac9..c501117` that predate that review's scope, plus a fresh adversarial pass on the whole gate)
**Date:** 2026-07-12
**Verdict:** ✅ **SOUND-WITH-NITS** — 0 CRITICAL / 0 HIGH / 0 MEDIUM; 1 new LOW (fails-closed) + 2 evaluated deferrals (both agreed). The killer scenario (gate exits 0 while behaviour drifted) is closed by construction. Nothing blocks the milestone.

---

## 1. Scope & Strategy

MEDIUM codebase, FOCUSED-adversarial. **Phase-0 triage** classified the 29 files; HIGH-risk read in full and probed empirically:

| File | Risk | Why |
|---|---|---|
| `src/eval/redteam/baseline.ts` | HIGH | hostile-input loader (size cap, symlink refusal, ajv allowlist, id charset), drift classifier, independent totals backstop, drift renderer |
| `src/cli/redteam-command.ts` | HIGH | gate precedence table, `--update-baseline` atomic write, symlink guards, exit-code contract |
| `src/eval/scorecard/diff.ts` | HIGH | all-own-fields row differ (the gate's comparison core; Map pairing) |
| `src/cli/shared.ts` | MEDIUM | moved write helper + `sanitizeForTerminal` + `readPackageVersion` |
| `eslint.config.js` | HIGH | layering config — a silently-loosened import bar is a security regression |
| `.github/workflows/ci.yml` | HIGH | gate wiring (unchanged on branch; verified default-path invocation) |
| `src/cli.ts` diff | MEDIUM | extraction move-only proof |
| tests (`baseline.test.ts`, `redteam-command.test.ts`, `baseline-e2e.test.ts`, `diff.test.ts`, `layering.test.ts`) | — | fail-closed negative coverage |
| ADR-0019 | — | read in full |

**Read in full:** all files above + `docs/decisions/0019-regression-gate.md`.
**Not read line-by-line (honesty):** the design docs (`process/designs/2026-07-10-e3-*.md` + decision-log + 801-line implementation plan), the ADR-0018/security-model/requirements/week-plan/README **diffs** (skimmed via `--stat` + commit messages), `runner.ts`/`markdown.ts`/`corpus.ts` (unchanged from E-2), and the 484-line `eval/redteam/baseline.json` **contents** — its correctness was verified empirically (byte-match + size) rather than by eyeball. `drift.ts` (the non-gating E-2 diagnostic) reviewed only via its test diff.

## 2. Empirical Verification

| Check | Result |
|---|---|
| `npm run typecheck` (tsc + tsc -p tsconfig.test.json) | ✅ clean |
| `npm run lint` (eslint src) | ✅ clean |
| `npm run build` | ✅ clean |
| `npm test` | ✅ **40 files, 784 tests** pass |
| Default gate run `node dist/cli.js redteam` (committed baseline) | ✅ exit 0, `GATE_FAILURE=none` — proves committed baseline byte-matches the live run + totals backstop passes |
| Symlinked baseline (`--baseline link→real`) | ✅ exit 2, `refusing baseline: file … is a symlink`, **no** `GATE_FAILURE=` line |
| Symlinked parent dir | ✅ exit 2 (test-covered) |
| ANSI-malformed baseline (`{\x1b[31mEVIL`) | ✅ exit 2, `failed to parse as JSON` — **zero** ESC bytes in output; V8 snippet suppressed |
| Oversized baseline (1,000,001 B) | ✅ exit 2, `exceeds 1000000 bytes` — capped **before** read |
| Non-canonical (reordered keys, semantically equal) | ✅ exit 1, `baseline file is not canonical`, `GATE_FAILURE=drift` |
| `--update-baseline` tmp-symlink attack (`baseline.json.tmp → victim`) | ✅ exit 2, victim `precious` untouched, baseline not created (test-covered) |
| id=`constructor` drift | ✅ paired via Map, classified `regression`, no prototype corruption |
| id=`__proto__` / beacon-shaped id (`x](http://evil)`) | ✅ ajv charset-rejects (test-covered) |
| Hostile `reason` value (`SECRET_LEAK_marker_\x1b[31m`) in drift | ✅ report echoes **only** field-name `reason`, never the value — `echoes marker? false` |
| dup-id baseline through `loadBaseline` | ⚠️ ajv accepts (no uniqueItems) → diffRows treats dup as `removed` → exit 1 (**fails closed**) — LOW-1 |
| eval → cli import (`grep 'from ../../cli' src/eval/`) | ✅ none; new `layering.test.ts` proves the `**/cli/**` bar |
| eval barrel reachability | ✅ `CORPUS`(51) + `REDTEAM_ARM_LABEL`(`security-on`) + `loadBaseline` all re-exported |
| Move-only proof of `ba79533` | ✅ 152 removed cli.ts lines ↔ 162 added shared/redteam lines; only 3 intentional deltas (see §4) |

## 3. Findings

### The killer scenario — gate bypass — is closed by construction (CLEAN)

Exit 0 in compare mode requires **all three**: `loaded.raw === freshCanon` (byte-equal to the live run's canonical output), `falseBlockCount === 0`, and `internalDetail === null`. The two absolute signals are read from **`freshNorm.totals`** (`redteam-command.ts:175`, `:200`), never from the baseline — so a crafted baseline **cannot** suppress a false-block or a totals-backstop mismatch (both remain gate failures even against a byte-matching baseline: `gateOutcome`'s falseBlock check is independent of drift). Byte-equality to fresh canonical means the baseline literally records current behaviour; the only "sneak" — semantically-equal but non-canonical bytes (CRLF/key-reorder) — is caught as `nonCanonical → GATE_FAILURE=drift` (`:152–158`, empirically confirmed). **There is no input that yields exit 0 while behaviour drifted.** This is the load-bearing property and it holds.

### The drift report cannot echo attacker bytes (CLEAN — stronger than E-2's F-4)

The only attacker-influenced token reaching the terminal is a row **`id`**, which is (a) ajv-charset-restricted to `^[a-z0-9][a-z0-9-]{0,63}$` on the baseline side (`baseline.ts:78`) — no ANSI/bidi/markdown-image bytes possible — and (b) passed through `sanitizeForTerminal` in the CLI (`redteam-command.ts:163`, defense-in-depth). Every other finding `detail` is a static string or an **enum-safe** verdict/failureKind (`verdict weakened: block → ask`); free-text `reason`/`category` values are surfaced only as **field names** (`fields changed with verdict unchanged: reason`), never values — confirmed empirically with a marker-laced reason. Parse-error messages deliberately drop the V8 snippet (`baseline.ts:168–172`), verified: an ANSI-laden malformed file produces zero ESC bytes downstream.

### LOW-1 (new) — ajv baseline schema does not assert row-id uniqueness

`baseline.ts:71–87`. `rows` has no `uniqueItems`/uniqueness-by-`id` constraint, so a hand-crafted/merge-mangled baseline with duplicate ids validates. Impact is **fail-closed**: `diffRows` builds `freshById` from the (unique) live rows and `delete`s on first match, so the second dup pairs against `undefined` → `removed` → `regression` → exit 1 (empirically confirmed). No bypass, no crash, no echo. The committed baseline's id-uniqueness invariant rests on the real runner producing unique ids **plus** the byte-canonical match, not on the loader. Recommendation: optional — either accept (documented fails-closed) or add a uniqueness check if the loader is ever reused for a non-runner-produced artifact. Not a milestone blocker.

### LOW-2 (deferred: `reason` unbounded in ajv schema) — AGREE with deferral

`baseline.ts:84` types `reason` as bare `{ type: 'string' }` with no `maxLength`. Evaluated: the `reason` value is **never rendered** (only its field-name appears in drift detail — proven empirically) and is bounded by the 1 MB whole-file cap enforced before parse. It participates solely in the canonical byte comparison and in field-name-level drift detection. There is no terminal-echo or resource vector. The deferral is correct; not worth re-flagging even as LOW.

### LOW-3 (deferred: baseline path literal triplicated) — AGREE with deferral

`DEFAULT_BASELINE_PATH` (`redteam-command.ts:24`), the hardcoded `'eval/redteam/baseline.json'` in `baseline-e2e.test.ts:20`, the `cli.test.ts` pin, and `.gitattributes`. Evaluated: the eval-layer e2e test is **lint-barred from importing the CLI constant** (the `**/cli/**` no-restricted-imports rule — itself a verified security control), so the duplication is forced by the layering boundary, not laziness; the test's own comment says exactly this. Deduping would require sinking the constant into a lower shared layer purely to satisfy a test pin — over-engineering. Deferral justified.

## 4. Clean (negative coverage & move-only proof)

- **eslint layering TIGHTENS, never loosens** (`eslint.config.js`): every occurrence of `**/cli`/`**/cli.js` gained a sibling `**/cli/**`, extending the existing import bar to the new `src/cli/` subdirectory across all four rule blocks + the eval-specific block. `layering.test.ts` adds a live proof that `src/eval` importing `../../cli/shared.js` is rejected. The gate's layer isolation cannot be weakened by the extraction.
- **`ba79533` is move-only.** 152 removed `cli.ts` lines reconcile against 162 added `shared.ts`/`redteam-command.ts` lines with exactly three intentional deltas: (1) `readPackageVersion` path depth `../package.json`→`../../package.json` — **correct** for the new directory and independently pinned by the new `shared.test.ts` (`readPackageVersion() === package.json.version`); (2) `USAGE` gains `[--update-baseline] [--baseline <path>]`; (3) local `ParseResult`→`RedteamParseResult` type. Behaviour-preservation is proven by `src/cli.test.ts` importing the re-exported symbols from `./cli.js` unchanged (the branch keeps pure-move re-exports in `cli.ts`). 784 tests green.
- **CI wiring unchanged & default-path** (`ci.yml:29` `node dist/cli.js redteam`): uses the committed `DEFAULT_BASELINE_PATH`; `npm test` runs first, so `baseline-e2e.test.ts` is the first failure surface with the same classified report the CLI prints (ADR-0019 §Positive) — not a raw KB-scale JSON diff. Manifest ⊇ CI honoured.
- **`--update-baseline` cannot bake in a bad state**: refuses on false-block or totals-backstop mismatch (`redteam-command.ts:193`) before writing; write is `rm -f tmp` (never follows a link) → `writeFileSync(..., { flag: 'wx' })` (O_CREAT\|O_EXCL, refuses a raced-in symlink) → atomic `rename` (replaces a dest symlink rather than writing through it); file/tmp/parent all symlink-guarded first. TOCTOU residue is acknowledged in-code and out of the static-clone threat model.
- **Prototype safety**: `diffRows` pairs via `Map` (immune to `__proto__`/`constructor` ids — confirmed); ajv `additionalProperties: false` at every level rejects a `__proto__`/`constructor` **key**; the id **value** charset rejects `__proto__` (though `constructor` is a valid id — Map, not charset, is what protects pairing, exactly as ADR-0019 d5 states).
- **Independent totals backstop** (`totalsMismatchDetail`) is a genuine second implementation (does not import runner totals code — DEC-0016), re-derives every total + `byFailureKind` + `meta.corpusSize`, and routes a mismatch to `internal`/exit 2 (a producer bug `--update-baseline` cannot fix).
- **Row-determinism tripwire**: the `_metaExhaustive` compile-time guard (`baseline.ts:40`) forces any new `RedteamMeta` field to be explicitly classified kept-or-volatile; the normalization fixture pin in `baseline.test.ts` catches volatility leaks into rows.

## 5. Verdict & Confidence

**SOUND-WITH-NITS.** 0 CRITICAL / 0 HIGH / 0 MEDIUM; 1 LOW (fails-closed, optional) + 2 evaluated deferrals (both agreed, neither worth re-flagging). The gate is fail-closed and bypass-proof by construction, the loader treats the baseline as hostile input on every axis probed, the drift report is structurally incapable of echoing attacker-controlled bytes, and the `src/cli/` extraction is a verified behaviour-preserving move that tightens (never loosens) the layering bar.

**Confidence:** HIGH on the security-critical paths — loader, gate precedence, CLI atomic write, differ, eslint layering, CI wiring — all read in full and empirically probed (symlink/oversize/ANSI/non-canonical/dup-id/constructor/hostile-reason). MEDIUM on the prose-reconciliation surface (ADR-0019 read in full; ADR-0018/security-model/requirements/README amendments reviewed via diff-stat + commit messages, not line-by-line — the prior 3-agent panel already covered doc-precision on those and its fixes are on-branch). The committed `baseline.json` was validated empirically (byte-match via the exit-0 default run + 10,995 B size) rather than line-by-line.

No changes required to clear the milestone. LOW-1 is a discretionary hardening the maintainer may accept as-is.
