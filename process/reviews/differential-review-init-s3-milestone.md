# Differential Security Review: `feat/init-s3` (S3 milestone gate)

- **Date:** 2026-07-14
- **Scope:** `git diff main...HEAD` on branch `feat/init-s3` (3 commits: `55d1ac2` feat, `dcfacb1` review fixes, `11be9f1` verify residual)
- **Base:** main `5652d30`
- **Reviewer:** milestone differential gate (whole-branch integrated + regression lens)
- **Strategy:** FOCUSED. 122 TS files in repo (MEDIUM), but the diff is surgical: 5 source files, all in the CLI composition root (`src/cli/**`, `src/cli.ts`), plus tests and docs. No auth, crypto, network, DB, or value-transfer surface touched.
- **Prior review this session:** full 3-agent `/review3` (code=sonnet, security+arch=Fable) on the feature commit, then an adversarial verify pass (Fable, 8 live PoCs) on the fix commit. This gate is the integrated whole-branch view those per-commit passes do not provide.

## Change summary

Adds `agent-harness-ja init [dir]`, a fail-closed scaffolder that writes a six-file starter project (README, .gitignore, deny-rules `.harness/settings.json`, one skill, one golden task, one oracle) from compiled string-constant templates. Wires it into `parseArgs`/`main`. Also enriches the two existing missing-key messages, adds a USAGE line, and (from the adversarial verify) sanitizes the shared parse-error sink.

## Risk classification (per changed source file)

| File | Risk | Rationale |
|---|---|---|
| `src/cli/init-command.ts` | HIGH | Filesystem writes driven by an operator-supplied path; symlink/collision/injection surface |
| `src/cli.ts` | MEDIUM | New dispatch branch + parse-error and missing-key output sinks |
| `src/cli/init-templates.ts` | MEDIUM | Ships a security policy as scaffold content (must be tightening-only) |
| `src/cli/eval-command.ts` | LOW | Message text only, exit code unchanged |
| `src/cli/shared.ts` | LOW | USAGE string append |

## Findings

**No new findings.** All issues surfaced by the per-commit reviews are fixed and integrated; the differential/regression lens surfaced nothing additional. Detail below.

### Verified-secure at the integration level

1. **Dispatch is additive; existing commands are unregressed.** `init` is checked after telemetry/eval/redteam and before the `parseRunArgs` fallthrough (`cli.ts:87-92`); in `main()` it returns before the `ANTHROPIC_API_KEY` gate (`cli.ts:224-227`), correct because init is keyless by design. Live-smoked: empty-arg, `bogus`, and `redteam` behave exactly as on main. No existing parse path or exit code changed.

2. **Symlink guard and write loop target identical entries.** `findSymlinkedComponents` (`init-command.ts:113-129`) walks `.` plus every path prefix of all six `INIT_TARGET_PATHS` with `lstatSync`; the write loop (`init-command.ts:175-179`) touches exactly those leaves and their intermediate dirs. The guard uses `join(resolve(dir), …)` and the loop uses `join(dir, …)`, which resolve to the same filesystem location, so there is no path the loop writes that the guard did not check. Re-verified live against the code reviewer's original PoC: pre-planted `.harness` symlink → exit 2, victim dir empty, zero writes.

3. **The two write guards compose with no gap.** Symlink guard catches symlinked intermediates and dangling leaves (invisible to `existsSync`, which follows links); collision guard (`init-command.ts:161-172`) catches real-file leaf collisions; a symlinked-dir *target* passes the `statSync` is-directory gate but is caught as component `.` by the symlink guard. No input satisfies neither guard while still redirecting or overwriting.

4. **All operator-influenced output is terminal-sanitized.** Every sink that echoes `dir` or argv now passes `sanitizeForTerminal` (`TERMINAL_UNSAFE`: strips ESC/C1/U+2028-2029, preserves `\t`/`\n`): the four `runInit` sinks plus the shared parse-error path in `main()` (`cli.ts:208`), the last added after the adversarial verify found it echoed argv verbatim (reachable via `init *` glob). Blast radius of that one-line change is every command's parse errors; it is pure hardening (no legitimate error text carries control chars) and idempotent. Live-verified ESC to space.

5. **Scaffolded policy is structurally tightening-only.** `INIT_SETTINGS_JSON` is deny-only (`WebFetch`, `WebSearch`) with no `defaultDecision`; the security lane verified against the real evaluator that a project layer with no `defaultDecision` cannot widen a user layer (cross-layer max-severity, sticky deny). The templates were untouched by the fix commits. Semantic tests bind the scaffold to the real skill/settings/task/oracle loaders.

6. **TOCTOU consciously scoped out, not overclaimed.** The check-then-write race between the guards and the write loop is documented in the code (`init-command.ts:105-112` docstring) and ADR-0021 revisit-if R4 (names the non-interactive/shared-tmp context that would make it exploitable). Consistent with the pre-existing `refuseSymlinkedDir` posture for scorecards. The commit and ADR do not claim the race is closed.

### Residual limitations (accepted, recorded)

- **npx form is npm-npx-only.** `renderInvocation` prints `npx agent-harness-ja` only when the resolved cli path contains an `_npx` segment (`init-command.ts:44`); `pnpm dlx`/`yarn dlx` fall through to the absolute-path form. Cosmetic (the printed command is still runnable), documented in ADR-0021 decision 6. Not a security issue.
- **Ancestor-symlink of the operator's `dir`** is not refused (only `dir` and below). A symlinked parent redirects the whole tree together, which is the operator's own target choice, and matches the existing scorecard guard's scope.

## Test coverage

Elevated confidence, not elevated risk: the branch adds 42 tests (init-command 24, init-templates 9→ with the review additions, cli.test.ts +1). The template tests validate against the *real* production loaders (`validate`, `parsePermissionSettings`/`parseSandboxSettings`, `parseTaskFile`, `loadOracle`) plus a live `git check-ignore`, so schema drift fails CI. Regression tests cover the symlink PoC, escape injection, npx, the climb boundary, and the computed collision remedy. Full suite 899 green; lint/typecheck/build/links/redteam all green.

## Verdict

**APPROVE.** The branch leaves a coherent, fail-closed surface. The security-relevant behaviour (operator-path writes, terminal output, shipped policy) is guarded, the guards compose without gaps, existing commands are unregressed, and every accepted limitation is documented in code and ADR rather than hidden. Clear to proceed to S4 (npm publish), which remains independently ADR-gated (version bump, prepublishOnly, OIDC provenance, pack review, `engines >=20.10`).
