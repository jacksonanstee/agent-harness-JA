# E-1 Golden Task Runner — Design (review-validated)

- **Date:** 2026-07-08
- **Scope:** Week-3 E-1 only. E-2 (red-team corpus) and E-3 (regression gate)
  are out of scope but must be buildable on this design's outputs; E-4 out of
  scope entirely.
- **Review:** structured panel (skeptic / constraint-guardian / user-advocate,
  33 findings) + arbiter pass — APPROVED with three conditions, folded in
  below. Decision log at the end of this document.
- **Feeds:** ADR-0017 (to be written with the implementation PR) and the
  implementation plan.

## Goal

`npx agent-harness-ja eval` runs a directory of golden tasks through the real
harness and produces a scorecard (Markdown for humans, canonical JSON for
machines). The scorecard contract is what E-2/E-3 build on.

## Architecture

Two modules in the eval layer (top layer: may import harness + security;
nothing below may import it).

### `src/eval/scorecard/` — producer-agnostic scoring machinery

Split out from the runner so E-2's session-free red-team path (deterministic
sync `scan()` per ADR-0016 §7) reuses it without redesign.

- `Scorecard { schemaVersion: 1, meta, rows, totals }`.
- **Deterministic partition** — the only part a future baseline diff (E-3) may
  compare: `rows[]` sorted by id, each
  `{ id, pass, failureKind, reason }` with
  `failureKind: null | 'task-parse' | 'oracle-load' | 'session-error' |
  'oracle-error' | 'oracle-fail'` (infra flakes distinguishable from
  capability regressions).
- **Volatile partition** — informational, never diffed: per-row
  `{ costUsd, numTurns, durationMs, resultSubtype }` plus `meta` (created-at,
  harness version, model choices).
- `toMarkdown(scorecard)`: totals first, then the table; cells escape `|` and
  newlines; reasons truncated to one line. Full detail lives only in JSON.
- `toCanonicalJson(scorecard)`: sorted keys, rows sorted by id, trailing
  newline — byte-stable given identical inputs.
- **Determinism honesty:** golden scorecards come from live model runs and are
  not re-derivable byte-for-byte; they are informational artifacts. The
  committed-baseline CI gate (E-3) applies to the deterministic red-team arm
  only (ADR-0016 §7). This contract is normative here and in ADR-0017 — it has
  no dependency on unmerged branch docs.

### `src/eval/golden/` — the runner

- `createGoldenRunner(deps)`; `runner.run(taskDir, opts?): Promise<Scorecard>`.
  `opts` in v1 carries only `onProgress?: (line: string) => void` (the CLI's
  per-task progress hook); everything else is an injected dep. `totals` =
  `{ tasks, passed, failed, byFailureKind, passRate, totalCostUsd,
  unpricedTasks }`.
- Injected deps (house style):
  - `createTaskSession: (config) => Session` — the existing `Session` contract
    (`run(prompt): Promise<SessionResult>`). Unit tests inject fakes; the CLI
    wires real `createSession` at the composition root.
  - `redactSecrets?: (text) => RedactResult` — every string entering a
    scorecard row (oracle reason, error message, first line of a stack) is
    redacted, control-char/bidi-sanitized, and truncated before storage;
    fail-closed to `[REDACTION FAILED]`. Field allowlist: rows carry only the
    schema fields above — raw `resultText` never enters a scorecard.
  - `now?`, `generateId?` — injected clock/ids.
- Task discovery: `<taskDir>/*.task.md`, non-recursive in v1, ordinal sort
  (platform-independent row order).
- Sequential execution. Per-task error isolation for catchable failures — a
  failing task becomes a row with the right `failureKind`; the run continues.
- **Row-level vs run-level failures (arbiter condition 1):** anything scoped
  to a single task file (malformed frontmatter, unloadable oracle, session
  crash, oracle throw/false) is a per-task row — keyed by frontmatter `id`
  when extractable, else the file's relative basename (stable fallback).
  Anything about the run or the task *set* (missing/unreadable `taskDir`,
  duplicate ids across files, zero tasks found) is a run-level usage error,
  exit 2, no scorecard.
- **Documented v1 limitations:** no per-task wall-clock timeout (`QueryFn` has
  no abort channel; mitigated by default `maxTurns: 10`, mirroring `run`);
  process-hostile oracles (`process.exit`, infinite loop) are not containable
  in-process; an interrupted (SIGINT) run writes no partial scorecard.

## Task format

- `<name>.task.md`: gray-matter frontmatter + Markdown body = the prompt.
- Parsing reuses the hardened house pattern by hoisting the skills loader's
  guards (`SAFE_MATTER_OPTIONS`, fence-language guard, `MAX_FILE_BYTES`) to
  `src/internal/frontmatter.ts`, consumed by both skills and eval (precedent:
  S-4's `settings.ts` hoist at the second consumer). Skills tests must pass
  unmodified — proof of pure move.
- ajv schema, `additionalProperties: false`, `failingField()`-style actionable
  errors:
  - `id` (required): string matching `^[a-z0-9][a-z0-9-]{0,63}$` —
    Markdown/terminal-safe, YAML-number-proof.
  - `descriptor` (optional): validated against the router `TaskDescriptor`
    shape at parse time, so an invalid descriptor is a `task-parse` row, not a
    mid-session `TypeError` misclassified as a session crash.
  - `maxTurns` (optional int ≥ 1, default 10).
  - `skillsDir` (optional): resolved relative to the task file's directory;
    default `<taskDir>/skills`; missing-dir semantics verified against the
    skills loader during implementation.

## Oracle contract

- Sibling `<name>.oracle.mjs`, dynamic-imported via `pathToFileURL(abs).href`
  (Windows-safe). Named export `oracle`; boundary-validated: must be a
  function, and its return must satisfy `{ pass: boolean }` with a strict
  boolean check — truthy coercion is rejected as an `oracle-error` row (a
  broken oracle must never silently pass everything). Optional
  `reason?: string`.
- `oracle(result: SessionResult) => { pass, reason? }` — pure, deterministic,
  no model calls, no I/O.
- **Named limitation:** v1 oracles judge the `SessionResult` surface only —
  final text, `resultSubtype`, `denied[]`, usage — not filesystem side effects
  or tool traces. Gating-behavior tasks (assert `denied[]` contains an
  expected denial) are first-class and are the harness-differentiating case.
  Side-effect inspection (a workspace handle) is a designed-for future
  increment. ADR-0017 records that self-report-only judging limits what golden
  tasks can honestly claim.
- Authoring support: the package exports an `OracleFn` type; docs show the
  JSDoc `@type {import('agent-harness-ja').OracleFn}` pattern for `.mjs`.
- ESM cache note: same-path re-import within a process returns the cached
  module — irrelevant for the one-shot CLI, recorded for future watch modes.

## Security stance

- Oracle execution is arbitrary in-process code from the (in-scope,
  potentially malicious) cloned repo, bypassing every SDK-hook gate. Recorded
  in three places: ADR-0017; `docs/security-model.md` (new residual-risk row
  R-10 plus §2 boundary wording); and at runtime — one `warning:` line to
  stderr before the first oracle import (the `composeSecurity()` pattern).
- **Golden eval never runs in per-PR CI.** It needs `ANTHROPIC_API_KEY` and
  executes PR-author-controlled oracle code; a fork PR plus a CI secret is an
  exfiltration primitive. The only every-PR eval gate is E-3's deterministic
  heuristic arm (keyless, no untrusted oracles).
- Scorecard write path refuses a symlinked output directory (lstat before
  write) — a malicious repo must not redirect the write.
- Task `.md` parsing carries the same anti-code-execution guards as skills
  (the `src/internal/frontmatter.ts` hoist) so task files are not a second,
  undocumented code-execution channel.

## Environment isolation

- The CLI `eval` command wires memory + telemetry to an **in-memory SQLite
  database** per run — eval never contaminates the operator's real
  `.harness/telemetry.db` (both stores already support `:memory:`).
- User/project security settings still apply: eval measures the harness under
  the local security posture. Consequence — scorecards are comparable only
  under equivalent settings — is documented; a settings fingerprint in `meta`
  is a listed revisit-if, not v1.

## CLI

- `eval [taskDir]`, default `./eval/golden` — matches the README's bare
  `npx agent-harness-ja eval` quick-start. The repo's own golden tasks live in
  top-level `eval/golden/` (not `src/` — tsc emits no `.md`/`.mjs`; the
  published npm package ships no tasks).
- Pre-flight to stderr before the first live call: task count + the
  oracle-execution warning. Per-task progress line as each completes:
  `[n/N] <id> … pass|fail ($cost)`.
- stdout: the Markdown scorecard, through `sanitizeForTerminal`.
- JSON written to `.harness/eval/scorecard-<ts>.json` where `<ts>` is
  filesystem-safe (`YYYY-MM-DDTHH-mm-ssZ` — no colons; arbiter condition 2).
  This is scratch output and stays under the existing `.harness/` gitignore;
  committed baselines are E-3's concern at a stable in-repo path E-3 defines.
- **Exit codes (the contract users and E-3 script against):** `0` = ran, all
  tasks passed; `1` = ran, at least one row failed; `2` = run-level usage or
  config error (see row-vs-run rule above). Matches the existing `run`
  convention (outcome-keyed 0/1, config errors 2).
- `costUsd: null` rows: totals render `≥ $X (n tasks unpriced)` — never a
  silently understated sum.
- No `--max-tasks`/budget flag in v1 (pre-flight count + sequential execution
  + bounded default `maxTurns` cap the blast radius; listed as revisit-if).

## Layering enforcement

- eslint: `**/eval/**` **globstar** patterns (the existing `**/eval/*` style
  misses nested imports) added to every non-eval files block, including a new
  `src/session/**` block; explicit composition-root exemption for
  `src/cli.ts`.
- `src/index.ts` exports the eval public API (runner factory, scorecard types,
  `OracleFn`) for programmatic consumers.
- `src/layering.test.ts` gains nested-path cases (`../eval/golden/index.js`).

## Documentation amendments (all in the implementation PR)

- `docs/architecture.md`:
  - `eval/golden` signature → `run(taskDir, opts?): Promise<Scorecard>`.
  - Oracle wording → `.mjs` module (JSDoc-typed), not "TypeScript module".
  - "reports the stack in the scorecard" → redacted, truncated failure reason.
  - Add the `eval/scorecard` module spec.
  - `eval/red-team` "Depends on" → `eval/scorecard` (arbiter condition 3).
- `docs/security-model.md`: R-10 residual-risk row + §2 boundary wording.
- `process/05-week-plan.md`: tick E-1; clarify "CI runs eval on every PR"
  means the deterministic red-team arm only.
- `README.md`: verify the quick-start `eval` line against the shipped default.
- New `docs/decisions/0017-golden-runner.md`: task format, oracle contract,
  scorecard schema + partitions, exit codes, security stance, limitations,
  revisit-ifs.

## Non-functional

- TDD throughout; ≥80% coverage; all unit tests deterministic (fake sessions,
  injected clock/ids). Live verification is the Week-3 checkpoint smoke, not a
  unit test.
- One PR off main.

## Decision log

Findings: S# = skeptic, C# = constraint guardian, U# = user advocate.
Dispositions verified by the arbiter pass (APPROVED; conditions 1–3 folded in
above).

| # | Finding | Disposition | Resolution |
|---|---------|-------------|------------|
| 1 | C1 secret leak into scorecard (CRITICAL) | Accepted | Injected `redactSecrets`, field allowlist, fail-closed sentinel, no raw `resultText` |
| 2 | S1a/C7 design cited a doc that exists only on an unmerged branch | Accepted | Contract is normative in this design + ADR-0017; no branch-doc dependency |
| 3 | S1b/C4/S12 "committed baseline" not re-derivable from live runs | Accepted | Deterministic/volatile schema partition; golden = informational; baseline gate = E-3 red-team arm only (ADR-0016 §7); canonical JSON; `schemaVersion` |
| 4 | S3 E-2 not buildable on a session-shaped runner | Accepted | Split `eval/scorecard` (producer-agnostic) from `eval/golden` |
| 5 | S2 oracle sees only the model's self-report (CRITICAL) | Accepted as limitation | v1 judges `SessionResult` incl. `denied[]` (gating tasks first-class); workspace inspection = future increment; documented honestly |
| 6 | C2/S13 layering globs don't actually enforce; cli must import eval | Accepted | `**/eval/**` globstar in all blocks + new session block + cli exemption + nested-path tests |
| 7 | C3/U4/S6 oracle code-exec documented only in the ADR | Accepted | security-model.md R-10 + §2, stderr warning, golden-eval-never-in-per-PR-CI |
| 8 | S6 fork-PR key exfiltration via CI oracles | Accepted | Same CI policy as #7; E-3 gate runs keyless/deterministic |
| 9 | U1 `.harness/` gitignore vs "committed baseline" | Accepted | Per-run JSON = scratch (gitignored); baseline path = E-3's stable in-repo path |
| 10 | U2/S11 exit-code contract unstated | Accepted | 0 all-pass / 1 any-fail / 2 usage-error |
| 11 | U3/S8 frontmatter validation gaps | Accepted | ajv + `additionalProperties: false` + `failingField()` + dup-id exit 2 + parse-time descriptor validation + id pattern |
| 12 | S9 task.md as a second undocumented code-exec channel | Accepted | Hoist `SAFE_MATTER_OPTIONS`/fence guard/`MAX_FILE_BYTES` to `src/internal/frontmatter.ts`; skills tests pass unmodified |
| 13 | S5 single pass/fail conflates infra flakes with regressions | Accepted | `failureKind` enum in the deterministic partition |
| 14 | S4/C5 no per-task timeout; hostile oracles uncontainable | Accepted as limitation | No abort channel in `QueryFn`; default `maxTurns` 10; documented; revisit-if: abort support |
| 15 | S7 operator DB contamination + settings variance | Partial | In-memory DB per run (fixes contamination); settings variance documented; fingerprint = revisit-if |
| 16 | C8/S10 import contract (Windows URL, export/shape validation, cache, typing) | Accepted | `pathToFileURL`, strict boundary validation, ESM-cache note, exported `OracleFn` + JSDoc pattern |
| 17 | U6/S11/C10 CLI default vs README; tasks can't live in `src/` | Accepted | `eval [taskDir]` default `./eval/golden`; repo corpus at `eval/golden/`; npm ships no tasks |
| 18 | U5/C6/S14 Markdown/terminal injection via reason cells | Accepted | Escape + truncate in `toMarkdown`; `sanitizeForTerminal` on stdout; control/bidi stripping on file output |
| 19 | U7/S15 cost visibility before/during a live run | Partial | Pre-flight count + per-task progress + honest null-cost totals; budget flag = revisit-if |
| 20 | U8 totals buried below the table | Accepted | Totals render first |
| 21 | S12 symlinked output dir = attacker-directed write | Accepted | lstat/no-follow check before scorecard write |
| 22 | C9/S13 architecture.md amendments larger than claimed | Accepted | Signature, oracle wording, stack wording, module spec, red-team dependency line |
| 23 | S15 platform-dependent discovery order | Accepted | Ordinal sort |
| 24 | S4 SIGINT partial-scorecard semantics | Rejected (v1) | One-shot CLI, no consumer until E-3; interrupted-run spend is lost and documented; revisit with E-3 |
| 25 | S8 `skillsDir` relative-to-what ambiguity | Accepted | Relative to the task file's dir; default `<taskDir>/skills`; missing-dir semantics verified during implementation |

Arbiter conditions: (1) row-vs-run failure rule — folded into the runner
section; (2) filesystem-safe scorecard timestamp — folded into the CLI
section; (3) `eval/red-team` dependency amendment — folded into the doc list.
