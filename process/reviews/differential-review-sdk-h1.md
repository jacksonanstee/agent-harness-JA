# Differential Security Review — Module H-1 (SDK Session Adapter + CLI)

**Branch:** `feat/sdk-h1` vs `feat/memory-h5`
**Diff:** `git diff feat/memory-h5...feat/sdk-h1` (4 commits on branch: `20cad8a` feat, `f92efad` ci, `d2f99f3` docs, `78565f2` fix — 3-agent-review hardening)
**Reviewer:** differential-review (DEEP strategy, SMALL codebase)
**Date:** 2026-07-06
**Verdict:** ✅ **APPROVE-WITH-NITS**

---

## 1. Scope & Strategy

| Item | Value |
|---|---|
| Files changed | 18 (+3,696 / −28) |
| Production code under review | `src/session/session.ts` (257 LOC), `src/session/types.ts` (141), `src/cli.ts` (147), `src/session/index.ts`, `src/index.ts` |
| Config/CI under review | `.github/workflows/ci.yml`, `eslint.config.js`, `tsconfig.test.json`, `package.json` |
| Risk triage | **HIGH**: `session.ts` pre-tool deny bridge, `cli.ts` env/arg/terminal handling, `ci.yml`. **MED**: `types.ts`, tests, eslint config, package.json dep changes. **LOW**: ADR-0010, architecture.md, devlog, week-plan, `load.ts` BOM-escape cosmetic, `runtime.test.ts` one-line lint-comment removal. |
| Contracts read (direct deps) | `src/hooks/runtime.ts` (`fire()` semantics, deny-on-throw, sanitized reasons), `src/memory/store.ts` (`write()` upsert + validation), `src/skills/load.ts`, `src/router` types |
| Differential focus | (a) does the hardening commit `78565f2` actually close the prior 3-agent findings; (b) did the fix itself introduce new defects |

---

## 2. Empirical Verification

All run from repo root on `feat/sdk-h1`.

| Check | Command | Result |
|---|---|---|
| Lint | `npm run lint` (eslint 10 flat config) | ✅ clean |
| Typecheck (src + tests) | `npm run typecheck` (`tsc --noEmit && tsc -p tsconfig.test.json`) | ✅ clean — base tsconfig excludes `**/*.test.ts`; `tsconfig.test.json` removes that exclusion, so test files are now genuinely typechecked (verified the exclude override, not just the script) |
| Full suite | `npm test` | ✅ **145 tests, 6 files, all pass** (session = 12, cli = 10) |
| Sanitizer probe: ESC / C1-CSI / BS | node probe of `TERMINAL_UNSAFE` | ✅ `\x1b`, `\x9b`, `\x08` all stripped → ANSI/OSC injection blocked |
| Sanitizer probe: CR | node probe | ⚠️ `\r` (0x0D) **passes through** `TERMINAL_UNSAFE` (see N-1) |
| Sanitizer probe: session `CONTROL_CHARS` | node probe | ✅ strips CR/LF/TAB + C1 + U+2028/9 — persisted text cannot carry log-injection bytes |
| Truncation probe | node probe of `truncate()` slice at 200 | ⚠️ can split a surrogate pair; `JSON.stringify` output remains valid, parseable JSON (see N-6) |

## 3. Fix-Commit Scrutiny (`78565f2` — highest priority)

Every claimed remediation verified in the final tree; none is commit-message-only:

1. **session-start errors surfaced** — `session.ts` loops `startResult.errors` → `warn(...)`, matching post-tool/stop. ✅ Test at `session.test.ts:253`.
2. **Failure summary persisted, then rethrow** — `streamError` captured, `finally` fires `stop`, memory write includes `failed: streamError !== null`, `if (streamError !== null) throw streamError` runs **after** the write. ✅ Test at `session.test.ts:281`. New-defect check: the rethrow ordering is correct; the only mask risk is a *synchronously throwing* `memory.write` swallowing `streamError` (N-5, theoretical — inputs at this call site always satisfy `assertValidInput`; db errors return tagged `{ok:false}`).
3. **Exit code keyed on subtype** — `cli.ts`: `result.resultSubtype === 'success' ? 0 : 1`. Fail-closed: empty stream (no result message) → subtype `null` → exit 1; stream throw → rethrow → outer handler → exit 1. ✅
4. **Sanitize + truncate persisted text, 30-day staleAfter, no telemetry in memory** — `truncate()` = sanitize → 200-char cap; `SUMMARY_TTL_MS`; cost/usage/turns absent from the JSON. ✅ Tests at `session.test.ts:301,326`.
5. **Tool name sanitized entering `denied[]`; fail-closed on `fire()` throw** — `sanitizeText(input.tool_name ?? 'unknown')` before fire; `try/catch` around `fire('pre-tool')` converts a runtime failure into a **deny**, not an SDK-defined default-allow. ✅ This closes the deny-bypass-by-crash path.
6. **Terminal escape stripping in CLI; SDK export guard** — `sanitizeForTerminal` wraps `onText`/`onWarning`; `typeof sdk.query !== 'function'` → exit 2. ✅ (residual: N-1, N-2).
7. **CI least-privilege + build step** — `permissions: contents: read`, `push: [main]` + `pull_request` (not `pull_request_target`), no secrets referenced, pinned major-version actions, node 20/22 matrix. ✅ No token-abuse surface: a fork PR gets a read-only token and no secret access.
8. **eslint layering rule** — `no-restricted-imports` blocks `**/session*`/`**/cli*` from router/skills/hooks/memory; lint runs green so no current violation. ✅

## 4. Contract Analysis (HIGH files vs consumed contracts)

- **Deny bridge vs `runtime.fire()`**: `fire('pre-tool')` returns `denied:true` with `reason` already sanitized by `reasonOf()` (`runtime.ts:49-51`) — so the `permissionDecisionReason` handed to the SDK and the `denied[]` reason persisted to memory are control-char-clean on *both* the normal-deny and the fire-throw paths (the latter sanitized again in `session.ts`). Deny is awaited before returning to the SDK; no ordering window in which the tool can run pre-verdict.
- **Memory write vs `store.write()`**: id `session-${sessionId}`, `type:'project'`, string content — always passes `assertValidInput`; SQL fully parameterized (verified in H-5 review, unchanged here). Upsert semantics mean a repeated SDK `session_id` overwrites the prior summary (N-9, by design for resume).
- **Skills → system prompt**: `buildSystemPrompt` interpolates `skill.name`/`skill.description` from `load.ts`, which validates/sanitizes frontmatter (H-3 review). A hostile skill file is a *local-file* trust boundary the user already controls.

## 5. Adversarial Scenarios (Phase 5)

| Attack | Path | Outcome |
|---|---|---|
| ANSI/OSC injection via model text or tool-poisoned output | model text → `onText` → terminal | ✅ Blocked — ESC, C1 (0x80–0x9F incl. 0x9B CSI), BS stripped (probed) |
| CR line-overwrite spoofing | same path | ⚠️ Partially open — `\r` preserved (N-1) |
| Tool-name / deny-reason log injection into memory or stderr | `tool_name`/handler-throw reason | ✅ Blocked — sanitized in both runtime and session |
| Deny bypass by crashing the hook runtime | make `fire()` reject | ✅ Fails closed — catch → deny with sanitized reason |
| Memory poisoning via crafted result text | model output → session summary | ✅ Mitigated for control chars + size (200 cap); *semantic* prompt-injection of future memory consumers remains — acknowledged Week-2 redaction seam in ADR-0010 (N-10) |
| CI token abuse via fork PR | `pull_request` workflow | ✅ `contents: read`, no `pull_request_target`, no secrets in workflow |
| Terminal injection via SDK-supplied `session_id` | `[harness] ... memory=session-<id>` line | ⚠️ Not sanitized (N-2) — requires a hostile/broken SDK stream, low likelihood |

## 6. Findings

No CRITICAL, HIGH, or MEDIUM findings.

- **N-1 (LOW, high confidence)** — `src/cli.ts:27` `TERMINAL_UNSAFE` preserves CR (`\x0D`). Model/tool-poisoned text streamed via `onText` can use `\r` to overwrite earlier characters on the same terminal line, making displayed output differ from actual output (spoofing, not code exec). Probed and confirmed. Fix: add `\x0D` to the class (LF/TAB stay).
- **N-2 (LOW, medium confidence on impact)** — `src/cli.ts:129-133` the `[harness]` summary line interpolates `result.memoryEntryId` (derived from the SDK-provided `session_id`, typed only as `string`) without `sanitizeForTerminal`. Defense-in-depth gap; exploitation requires a hostile SDK stream.
- **N-3 (LOW)** — `src/session/session.ts:150` `postToolCallback` has no try/catch around `fire('post-tool')`, unlike the pre-tool path. `fire()` only throws on programmer error (event/payload mismatch), but if it did, hook-callback rejection behavior becomes SDK-defined. Symmetry fix is one try/catch.
- **N-4 (LOW)** — `src/session/session.ts:118-121` the fire-failure deny path echoes the raw (sanitized) internal `error.message` to the SDK/model as `permissionDecisionReason` — minor internals leak to the model context. Consider a fixed string plus `warn()` of the detail.
- **N-5 (LOW, theoretical)** — `src/session/session.ts:213-236` if `memory.write` ever threw synchronously (validation path), it would mask `streamError` on the failure path. Unreachable with current inputs; a try/catch would make the rethrow unconditional.
- **N-6 (LOW, cosmetic — probed)** — `truncate()` `slice(0,200)` can split a surrogate pair, persisting a lone surrogate before the `…`. `JSON.stringify`/`JSON.parse` round-trip stays valid; only display fidelity affected.
- **N-7 (LOW)** — `src/cli.ts:63` `--max-turns 5abc` parses as 5 (`parseInt` prefix semantics) instead of erroring. Input-validation laxity, no security impact.
- **N-8 (INFO)** — `session-start` fires with `harnessSessionId` but `stop` fires with `sdkSessionId` when available — hook consumers correlating a run across events see two different ids.
- **N-9 (INFO)** — memory id `session-${sessionId}` upserts: a resumed/replayed SDK session id silently replaces the prior summary (full-replace per H-5 semantics). Acceptable for Week 1; telemetry (Week 2) should own durable history.
- **N-10 (INFO, accepted risk)** — persisted `resultText` is model output; future memory *readers* must treat it as untrusted (semantic prompt-injection). ADR-0010 records this as the Week-2 redaction seam — keep it on the Week-2 gate.
- **N-11 (INFO)** — `denied[]` entries are sanitized but reasons are not length-capped; bounded in practice by `maxTurns` (default 10).

## 7. Verdict

✅ **APPROVE-WITH-NITS.** The hardening commit genuinely closed all six prior findings with no fix-introduced regressions found. The deny path fails closed, sanitization is consistent across the session/CLI boundary (one residual: CR), memory writes are validated/parameterized/truncated, and CI is least-privilege. All nits are LOW/INFO; N-1 and N-3 are one-line fixes worth folding into the next commit, none blocks merge.
