# Differential Security Review — E-1 Golden Runner Milestone Gate

**Branch:** `feat/eval-e1-golden-runner` @ 48044ea
**Diff:** `git diff 7047544...48044ea` — 22 commits, 60 files (+5,096 / −51): new `src/eval/` subsystem (golden task parser/oracle loader/runner + scorecard pipeline), `cli.ts` eval command (+220), `src/skills/load.ts` guard hoist, eslint layering extensions, ADR-0017 + doc amendments, starter golden tasks
**Reviewer:** differential-review (whole-branch milestone gate — 3 parallel dimensions: filesystem containment/code-exec, CLI-composition/runner/scorecard seams, regression/coverage/docs; per-commit /review3 findings and ADR-0017 deferred items H1/M1/M2/M4 not re-litigated)
**Date:** 2026-07-10
**Verdict:** ✅ **APPROVE-WITH-NITS** — 1 MEDIUM (F-1, fixed on-branch before push) + 5 LOW (a 7th reported finding invalidated on verification); nothing blocks the milestone. See §7 Resolution.

---

## 1. Scope & Strategy

| Item | Value |
|---|---|
| Strategy | MEDIUM codebase / FOCUSED — deep read on `task.ts`, `oracle.ts`, `runner.ts`, `cli.ts` (eval paths), scorecard pipeline, `skills/load.ts` diff; git-blame on all removed pre-existing code; empirical probes |
| Focus | Seams per-commit review can't see: run-vs-eval composition parity, cross-commit sanitization coverage (which fields route through which cleaner), check-time-vs-use-time guarantees, prior-gate finding regression |
| Explicitly out of scope | ADR-0017 deferred findings H1/M1/M2/M4 (revisit-ifs recorded); documented residuals R-1..R-10 incl. oracle-as-code-execution (operator-invoked only, never CI); no-per-task-timeout and no-filesystem-assertion named limitations |

## 2. Empirical Verification

| Check | Method | Result |
|---|---|---|
| Full suite | `npx vitest run` | ✅ 30 files, **661 tests, all pass** (pre-fix baseline) |
| Containment prefix-boundary | scratch probe: task dir `…/p` + committed symlink → sibling `…/p-evil` | ✅ rejected — `startsWith(dir + sep)` + equality holds on both lexical and realpath stages |
| Committed-symlink escape (`skills → /etc`) | probe | ✅ rejected ("symlink escapes to /private/etc") |
| Benign in-dir symlink; macOS `/tmp → /private/tmp` | probe | ✅ allowed (realpath-both-sides) |
| Frontmatter `__proto__` injection | probe | ✅ rejected by `additionalProperties:false`; `Object.prototype` unpolluted |
| Bidi (RLO) in failed-parse row id | probe | ⚠️ reaches terminal + JSON artifact un-stripped — **F-1** |
| `escapeCell` 120-char boundary with astral char | probe | ⚠️ lone surrogate emitted (`isWellFormed() === false`) — **F-2**; the 500-char `cleanForScorecard` boundary IS guarded |
| Regular file at output-dir path | probe | ⚠️ `refuseSymlinkedDir` passes (tests only `isSymbolicLink`), `mkdirSync` throws non-`EvalUsageError` → exit 1 — **F-3** |
| tsconfig ES2024 residue (bump+revert c9d3d61) | `git diff main...HEAD -- tsconfig*.json`; grep `isWellFormed\|ES2024` | ✅ empty diff, zero hits |
| Layering rules fire | `src/layering.test.ts` | ✅ 12/12 incl. nested-globstar + eval→cli ban |

## 3. Findings

### F-1 — MEDIUM (CONFIRMED): failed-parse row `id` bypasses bidi/Trojan-Source stripping, reaching the operator's terminal and scorecard artifacts
**Files:** `src/eval/golden/task.ts:58-64,123-127` (245d338) · `src/eval/golden/runner.ts:124-130` (23cdffd) · `src/eval/scorecard/markdown.ts:7-12,28` (87c3fa9) · `src/cli.ts:72` (`TERMINAL_UNSAFE` lacks the bidi range)
The branch's bidi defense (`BIDI_CONTROLS` in `sanitize.ts`, a4f6080) is applied by `cleanForScorecard` to `reason` only. On any parse-failure path the row id falls back to the task file's **basename** — legal carrier of U+202E (RLO) on common filesystems — and `fail()`'s `sanitizeControlChars` strips C0/C1 but not bidi. The raw id then flows to per-task progress lines (stderr), `toMarkdown` (stdout), and the canonical JSON; `sanitizeForTerminal` doesn't cover the bidi range either.
**Attack scenario:** a cloned malicious repo commits a broken task file named `payroll<RLO>dm.task.md`; the eval run's own output becomes a terminal-spoofing primitive — exactly the class `cleanForScorecard` was built to stop, missed on the second sink.
**Fix:** route failure-row `id` through `cleanForScorecard` at `failRow` (success-path ids are regex-pinned `^[a-z0-9][a-z0-9-]{0,63}$`, already safe).

### F-2 — LOW (CONFIRMED): `escapeCell`'s 120-char truncation re-introduces the surrogate-pair bisection 7809651 fixed
**File:** `src/eval/scorecard/markdown.ts:7-12` (87c3fa9)
7809651 guarded the 500-char boundary in `cleanForScorecard` and ADR-0017 deviation #3 claims "output is always well-formed text" — but `toMarkdown` truncates the already-cleaned reason again at 120 chars with a naive `slice`, cutting mid-pair. Impact cosmetic (markdown is stdout-only, not the diffed artifact). **Fix:** one shared well-formed-boundary truncation helper used by both sites.

### F-3 — LOW (CONFIRMED): non-symlink write failures exit 1, violating ADR-0017 §4's "no scorecard ⇒ exit 2"
**File:** `src/cli.ts:501-516` (cfb8082)
The write block maps only `EvalUsageError` → 2; `ENOTDIR` (regular file committed at `.harness/eval`), `EACCES`, `ENOSPC` rethrow to the generic exit-1 handler — after spend, with no scorecard, on the code reserved for "ran, ≥1 row failed". Contract-honesty, not a breach. **Fix:** any failure in the write block ⇒ stderr + exit 2 (by definition no scorecard was produced).

### F-4 — LOW (PLAUSIBLE): parse-time skillsDir containment is not use-time-stable
**Files:** `src/eval/golden/task.ts:97-116` + `src/skills/load.ts:215-249`
Containment is proven once, up-front for all tasks; `load()` at each task's execution re-resolves the root but never re-validates containment. A root swapped to a symlink between parse and load walks the target. Only in-process actors can win the race — an oracle (already R-10, arbitrary code) or sandbox/permission-gated model writes — so this is **largely subsumed by R-10**, recorded because the 48044ea design comment reads as a stronger guarantee than check-time-only. **Fix:** one sentence in ADR-0017/R-10 noting the guarantee is parse-time.

### F-5 — LOW (CONFIRMED, not exploitable): `containSkillsDir` fail-opens on non-ENOENT realpath errors
**File:** `src/eval/golden/task.ts:101-110`
The bare `catch {}` assumes "doesn't exist yet" but also swallows EACCES/ELOOP/dangling-symlink, skipping the realpath re-check. Backstopped: the identical path makes `load()`'s own `realpathSync(root)` fail closed (empty skills + recorded error) in the same process. Robustness nit — narrow to ENOENT/ENOTDIR to match the comment's intent.

### F-6 — LOW (coverage): post-SDK branches of `runEval` have no pinning tests
**File:** `src/cli.ts:377-525` (ee66a77)
Untested: runner-thrown `EvalUsageError`→2; exit 1-vs-0 from `totals.failed`; JSON-write-before-stdout ordering (the cfb8082 contract); the post-mkdir `refuseSymlinkedDir` re-check at its call site; R-10 warning emission (zero test hits). Constituent units ARE pinned, and `cli.test.ts:285-289` documents why the symlink path can't be driven through `main()` under vitest threads. A future refactor reordering stdout above the JSON write would break ADR-0017 decision #4 with no red test.

### F-7 — INVALID on verification (was LOW docs): "572 tests" claim is not stale
**File:** `docs/security-model.md:243-247` — the section header explicitly frames the numbers as "a frozen snapshot at Week-2 close (2026-07-08), not live values", and that framing pre-exists on main. The reviewer flagged the count without the framing sentence. No change made.

## 4. Run-vs-eval security callback parity (traced line by line — CLEAN)

| Callback | `run` | `eval` | Notes |
|---|---|---|---|
| permission hook (pre-tool) | ✅ | ✅ identical, per-task | same `composeSecurity` source |
| sandbox hook (pre-tool) | ✅ | ✅ identical | registered after permissions in both (attribution order preserved) |
| injection scan | ✅ | ✅ | — |
| secret redaction (session) | ✅ | ✅ | — |
| secret redaction (scorecard rows) | n/a | ✅ CLI always injects | M1 optionality adjudicated in ADR-0017 |
| memory persistence | ✅ real store | ✅ in-memory, per-run, discarded | documented (ADR-0017 #15) |
| telemetry | ✅ | ✅ in-memory | never touches operator's real DB |
| `onText` stdout | ✅ | ⛔ omitted | documented (`cli.ts:469` — stdout reserved for scorecard) |
| R-10 oracle warning | n/a | ✅ stderr before first import | ADR-0017 §6 |

**No security callback wired for `run` is silently dropped for `eval`.**

## 5. Regression & structural checks (clean)

- **Removed code (~51 deletions), all accounted for:** `load.ts` guards (`MAX_FILE_BYTES`, `FENCE_LANGUAGE`, `SAFE_MATTER_OPTIONS`, `hasUnsafeFenceLanguage`, `refuseNonYaml` — all from security commit 59946b3) hoisted **byte-identical** to `src/internal/frontmatter.ts` (060a46d), re-imported by both consumers. No weakening of the production `run` path; remaining deletions additive import/union widenings. ✅
- **Layering:** effective eslint restrictions are strict supersets of main's per config-object (flat-config replace semantics checked block by block); `src/security/**`'s single-star `**/eval/*` strengthened to globstar; `src/session/**` gains net-new bans; eval→cli ban pinned by test. No pre-existing restriction silently disabled. ✅
- **Oracle surface:** path derived from **filename**, never frontmatter `id` (no import redirection); verdict boundary strict-boolean (truthy rejected); fresh object literal (no prototype pollution); error messages route redact→strip→truncate before rows. Task `id` never interpolated into a filesystem path; scorecard filename is clock-derived. ✅
- **Runner isolation:** fresh session/evaluator/sandbox/hook-runtime per task; every failure class becomes a typed row and the run continues; partition `Σ byFailureKind === failed` structurally sound; oracle-error rows keep session model + cost (82bc820 intact). ✅
- **Canonical JSON:** typed keys only, `Object.fromEntries` own-properties, `__proto__`-as-value inert. ✅
- **Week-2 gate F-1 (command-match normalization):** fixed at the merge-base itself; branch diff over `src/security|session|hooks|router|memory|telemetry` is **empty**; eval does no command matching of its own. No regression. ✅
- **Week-2 gate F-2 (unredacted persisted reasons):** unwidened — eval memory is per-run in-memory; `denied[]` reaches oracles by design but enters persisted scorecards only via `cleanForScorecard`, and the row schema is a structural allowlist. ✅ (This branch's F-1 is the *pattern's* recurrence at a new sink — id, not reason.)

## 6. Docs-vs-code

All checkable claims in ADR-0017, security-model.md, architecture.md, README, week-plan verified against code (exit contract, two-stage containment incl. `/tmp` nuance, id regex, `OracleFn` export chain, lstat-no-follow pre-flight, R-10 wording, type-only security import in scorecard, never-a-raw-stack). Only drift: F-7's stale test count. ✅

## 7. Resolution (applied on-branch before push)

| Finding | Action |
|---|---|
| F-1 MEDIUM | fixed — after a /review3 round on the first fix attempt (see below), bidi stripping landed at **parse time** in `task.ts`'s `fail()`, before `assertUniqueIds`; `failRow` passes ids through untouched; regression tests: RLO filename, bidi-distinct alias collision (fails loud pre-spend), secret-shaped id never redacted |
| F-2 | fixed — shared well-formed truncation helper used by both boundaries; boundary test |
| F-3 | fixed — write-block failures uniformly map to exit 2; unit-tested via extracted helper |
| F-5 | fixed alongside F-4's doc note — catch narrowed to ENOENT/ENOTDIR |
| F-4 | documented — ADR-0017 note: containment guarantee is parse-time, use-time race subsumed by R-10 |
| F-6 | partially closed by F-3's extraction (write path now unit-testable, 3 tests); remaining gaps documented as accepted (vitest-threads limitation already recorded at `cli.test.ts:285-289`) |
| F-7 | no change — invalid on verification (count is an explicitly frozen Week-2 snapshot) |

**/review3 round on the fixes** (code-reviewer/sonnet + security-reviewer/fable + architect/fable): the first F-1 fix (`clean(id)` in `failRow`) drew three convergent findings — (a) MEDIUM: routing ids through the secret redactor falsely rewrites a schema-valid, secret-shaped id; (b) MEDIUM: cleaning after `assertUniqueIds` lets two bidi-distinct hostile filenames alias to one row id; (c) MEDIUM: the duplicate-id error message itself interpolated the raw bidi rowId to the terminal. All three resolved by one refinement: strip bidi at parse time (`task.ts` `fail()`), never redact ids. Also fixed from that round: `fallbackRowId`'s `.slice(0,64)` surrogate bisection (now `truncateWellFormed`). Architect: structure sound, `truncateWellFormed` placement and `writeScorecard`-in-cli both correct; two LOW consistency notes accepted as-is (clock-injection idiom, composition-root export growth — extraction trigger: a 4th persistence helper).

Post-fix verification: `npx tsc --noEmit` clean, `npx eslint .` clean, `npx vitest run` → **30 files, 672 tests, all pass** (661 baseline + 11 regression tests).

## 8. Coverage limits

Three-dimension parallel review with empirical probes; oracle/model *content* attacks on scorecards covered via the sanitization pipeline only (no live SDK runs — golden tasks not executed against the API in this review). Deferred items H1/M1/M2/M4 and residuals R-1..R-10 taken as adjudicated, not re-derived.
