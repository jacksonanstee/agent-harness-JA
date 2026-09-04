# ADR-0017: Golden task runner — task format, oracle contract, scorecard schema (E-1)

- **Status:** Accepted
- **Date:** 2026-07-09
- **Requirements:** E-1 (MUST)
- **Relates to:** ADR-0016 §7 (CI gate stays deterministic — this ADR is the
  implementation that honors it)

## Context

E-1 (MUST) requires `npx agent-harness-ja eval` to run a configured set of
golden tasks and produce a Markdown scorecard, with a sample suite passing in
CI. The shape was resolved before implementation in
`process/designs/2026-07-08-e1-golden-runner.md` — a review-validated design
(structured skeptic/constraint-guardian/user-advocate panel, 33 findings, plus
an arbiter pass) — so this ADR is the durable record of that design as
shipped, not a proposal. E-2 (red-team corpus) and E-3 (regression gate) build
on the contract recorded here.

Two modules ship: `src/eval/scorecard/` (producer-agnostic scoring machinery
— schema, canonical JSON, Markdown rendering, row sanitization) and
`src/eval/golden/` (the runner, which consumes it). The split exists so E-2's
session-free red-team scoring can reuse `eval/scorecard` without redesigning
it around a session-shaped runner.

## Decisions

1. **Task format: `*.task.md` frontmatter + Markdown body as prompt.**
   Gray-matter frontmatter over a Markdown body that is the prompt verbatim.
   Frontmatter fields: `id` (required, `^[a-z0-9][a-z0-9-]{0,63}$` —
   Markdown/terminal-safe, YAML-number-proof), `descriptor` (optional,
   validated against the router's `TaskDescriptor` shape at parse time, so an
   invalid descriptor becomes a `task-parse` row rather than a mid-session
   `TypeError` misclassified as a session crash), `maxTurns` (optional
   integer ≥ 1, default 10), `skillsDir` (optional, resolved relative to the
   task file's directory, default `<taskDir>/skills`; containment is
   enforced in two stages after resolution. First, a lexical check — an
   absolute path or a `..` traversal that would resolve outside the task
   file's directory is a `task-parse` row, not a silently-honored path.
   Second, a realpath-based re-check: the lexical check alone is bypassable
   by a repo-committed symlink at the accepted path whose *target* escapes
   the task directory (e.g. `skills -> /etc`), since `src/skills/load.ts`'s
   `load()` calls `realpathSync` on the root and walks the target, not the
   lexical path. Both `skillsDir` and the task file's directory are
   realpath'd before the second comparison — the task directory itself may
   legitimately sit behind a symlink (e.g. macOS `/tmp` -> `/private/tmp`)
   — and a symlink whose target resolves *inside* the task directory
   remains allowed. A `skillsDir` that does not yet exist skips the
   real-path re-check (nothing to walk yet); `load()` already treats a
   missing directory as a non-fatal, empty load. So a task file cannot
   point the skills loader — lexically or via a committed symlink — at an
   arbitrary directory). Parsing hoists the
   skills loader's guards (`SAFE_MATTER_OPTIONS`, the fence-language guard,
   `MAX_FILE_BYTES`) into `src/internal/frontmatter.ts`, consumed by both
   skills and eval — task files carry the same anti-code-execution posture as
   skill files rather than opening a second, undocumented parsing channel.
   Validation is ajv (`additionalProperties: false`) with a
   `failingField()`-style helper that turns schema violations into an
   actionable `<field>: <detail>` row message instead of a raw ajv dump.

2. **Oracle contract: sibling `.mjs`, named export, strict verdict shape.**
   `<name>.oracle.mjs`, dynamic-imported via `pathToFileURL(abs).href`
   (Windows-safe). A named `oracle` export; boundary-validated at load time —
   it must be a function, and its return must satisfy
   `{ pass: boolean, reason?: string }` under a strict boolean check.
   **Truthy coercion is rejected**, not accepted: `{ pass: 'yes' }` produces
   an `oracle-error` row rather than a silent pass, because a broken oracle
   must never silently pass everything it's asked to judge.
   `oracle(result: SessionResult) => { pass, reason? }` is pure and
   deterministic — no model calls, no I/O. The package exports an `OracleFn`
   type so `.mjs` files can be JSDoc-typed
   (`@type {import('agent-harness-ja').OracleFn}`) without becoming
   TypeScript.

3. **Scorecard schema v1: deterministic vs volatile partitions.**
   `Scorecard { schemaVersion: 1, meta, rows, totals }`. The **deterministic
   partition** — the only part a future baseline diff (E-3) may ever compare
   — is `rows[]` sorted by id, each row
   `{ id, pass, failureKind, reason }` with
   `failureKind: null | 'task-parse' | 'oracle-load' | 'session-error' |
   'oracle-error' | 'oracle-fail'`. `reason` is diffable only for producers
   whose reasons are themselves deterministic (the red-team arm); golden
   reasons derive from live model/SDK output, so a golden baseline diff must
   compare `{ id, pass, failureKind }` only. The **volatile partition** —
   informational, never diffed — is per-row
   `{ costUsd, numTurns, durationMs, resultSubtype }`
   plus `meta` (created-at, harness version, model choices).
   `toCanonicalJson(scorecard)` sorts object keys and rows by id and ends with
   a trailing newline (byte-stable given identical inputs); `toMarkdown`
   renders totals first, then the row table, escaping `|` and newlines and
   truncating reasons to one line — full detail lives only in the JSON.

4. **Exit codes and the row-vs-run rule.** `0` = ran, every row passed;
   `1` = ran, at least one row failed; `2` = run-level usage or config error,
   no scorecard produced — matching the existing `run` convention
   (outcome-keyed 0/1, config errors 2). The dividing line: anything scoped to
   a single task file (malformed frontmatter, an unloadable oracle, a session
   crash, an oracle throw or `false` verdict) is a **per-task row**, keyed by
   the frontmatter `id` when extractable, else the file's basename as a
   stable fallback. Anything about the run or the task set as a whole
   (missing/unreadable `taskDir`, duplicate ids across files, zero tasks
   found) is a **run-level usage error** — exit 2, no scorecard.

5. **Sequential execution, per-task error isolation.** Tasks discovered via
   `<taskDir>/*.task.md` (non-recursive in v1) run one at a time in ordinal
   filename order, which keeps row order platform-independent. A failing task
   becomes a row with the appropriate `failureKind`; the run continues rather
   than aborting. This — plus the pre-flight task count and the default
   `maxTurns` cap — bounds blast radius without a `--max-tasks`/budget flag in
   v1 (listed below as a revisit-if).

   **Corrected 2026-09-04 (issue #95):** the default was never a cap.
   `DEFAULT_MAX_TURNS` applies only when the frontmatter omits `maxTurns`; a
   task could set any value and the runner passed it to the SDK unclamped,
   and the pre-flight count was reported, never enforced. Both are bounded
   now; see the amendment at the end of this ADR.

6. **Security stance.** Oracle execution is arbitrary in-process code from
   the (in-scope, potentially malicious) cloned repository — it bypasses
   every SDK-hook gate the harness otherwise relies on. This is recorded in
   three places, deliberately: this ADR; `docs/security-model.md` (residual
   risk R-10 plus §2 in-scope wording); and at runtime, one `warning:` line
   to stderr before the first oracle import (the existing
   `composeSecurity()` warning pattern). **Golden eval never runs in per-PR
   CI**: it needs a live `ANTHROPIC_API_KEY` and executes PR-author-controlled
   oracle code, so a fork PR plus a CI secret is an exfiltration primitive.
   The only every-PR eval gate is E-3's keyless deterministic red-team arm
   (ADR-0016 §7 — sync `scan()`, no untrusted oracles). Every string entering
   a scorecard row (oracle reason, error message) passes through
   `cleanForScorecard`, which runs the injected `redactSecrets` first
   (fail-closed to the sentinel `[REDACTION FAILED]` if the redactor itself
   throws), then strips control/bidi characters, then truncates; the row
   schema is a structural field allowlist, so raw `resultText` cannot enter a
   scorecard regardless of what an oracle returns. The scorecard write path
   refuses a symlinked output directory (`lstat`, no follow, before write) so
   a malicious repo cannot redirect where results land.

7. **Determinism honesty.** Golden scorecards come from live model runs and
   are not re-derivable byte-for-byte; they are informational artifacts, not
   a byte-stable baseline. The committed-baseline CI regression gate (E-3)
   applies only to the deterministic red-team arm (ADR-0016 §7) — this is
   normative here, in `docs/architecture.md`, and in
   `process/05-week-plan.md`, with no dependency on unmerged branch docs.

## Named limitations

- **Self-report-only judging.** v1 oracles see only the `SessionResult`
  surface — final text, `resultSubtype`, `denied[]`, usage — never filesystem
  side effects or tool traces. Gating-behavior tasks (assert `denied[]`
  contains an expected denial) are first-class on this surface and are the
  harness-differentiating case a golden suite should carry. Side-effect
  inspection (a workspace handle passed to the oracle) is a designed-for
  future increment, not a gap papered over as "future work" with no shape.
- **No per-task wall-clock timeout.** `QueryFn` exposes no abort channel to
  hang a timeout off. The default `maxTurns: 10` (mirroring `session.run`) is
  the only bound in v1 — a pathological task can still run long, but it
  cannot run forever without also exhausting its turn budget.
  **Corrected 2026-09-04 (issue #95):** the default is a fallback, not a
  bound; the per-task bound is the schema's `maximum` of 100 turns, added by
  the amendment at the end of this ADR. The wall-clock limitation stands.
- **Process-hostile oracles are uncontainable in-process.** An oracle that
  calls `process.exit()` or spins an infinite loop cannot be stopped by
  anything running in the same process. This is exactly why oracle execution
  carries an explicit operator-facing warning and must never be reachable
  from CI.
- **An interrupted (SIGINT) run writes no partial scorecard.** Spend already
  incurred on completed tasks is lost with the process. Accepted for v1 — a
  one-shot CLI with no baseline consumer yet — and documented rather than
  silently swallowed.

## Deviations from the design

The design (`process/designs/2026-07-08-e1-golden-runner.md`) is implemented
as specified except for four points that surfaced during implementation:

1. **`generateId` runner dependency omitted.** The design listed an injected
   `generateId?` alongside `now?`. Nothing in v1 consumes a generated id —
   rows are keyed by frontmatter `id` or file basename — so the unused
   dependency was dropped rather than shipped as dead surface.
2. **`harnessVersion` injected rather than imported.** `meta.harnessVersion`
   is supplied by the caller (the CLI composition root) instead of the runner
   reading `package.json` directly, keeping it consistent with the other
   injected deps (`createTaskSession`, `redactSecrets`, `now`) and avoiding a
   build-time coupling from inside `src/eval` to the package's own version
   file.
3. **Surrogate-pair truncation guard** (commit `7809651`). As specified,
   `cleanForScorecard` truncates at `MAX_REASON_LENGTH`; the initial
   implementation could cut mid-surrogate-pair, corrupting the tail character
   into an unpaired low surrogate. The fix checks whether the UTF-16 code
   unit at the truncation boundary is a high surrogate (`0xD800`–`0xDBFF`)
   and, if so, cuts one code unit earlier so the pair is never bisected. This
   strengthens the design's sanitization invariant (`cleanForScorecard`
   output is always well-formed text) rather than changing it; it was found
   during task review, not specified up front.
4. **`parsed.data as unknown as TaskFrontmatter` double cast**
   (`src/eval/golden/task.ts`). ajv's `compile<T>` infers `T` structurally
   from `schema.json` against `JSONSchemaType<T>`. Because
   `descriptor.properties.{shape,sensitivity}` use bare `enum` without a
   `type`, that inference collapses to a synthetic `{ [x: string]: {} }`
   rather than `unknown`, which TypeScript then refuses to cast directly to
   `TaskFrontmatter` (TS2352, insufficient overlap). Routing through
   `unknown` is behaviorally identical to the design's intent — the value has
   already been validated against the schema the compile-time `KeysMatch`
   guard pins to this type — and is a cast forced by the schema shape, not a
   semantic change. `src/skills/load.ts`'s schema has no bare `enum` fields
   and doesn't need the double cast.

## Consequences

### Positive

- E-2's red-team corpus can build directly on `eval/scorecard` without
  redesigning scoring around a session-shaped runner.
- The deterministic/volatile partition makes E-3's regression gate
  well-defined before E-3 is written: it diffs `rows[]` and nothing else.
- Golden eval's security posture is stated in three independent places (this
  ADR, `security-model.md`, a runtime warning) rather than assumed from one.

### Negative / accepted

- Oracles remain arbitrary in-process code with no containment. This is a
  deliberate scope boundary (operator-invoked only, never CI), not a deferred
  fix.
- v1 golden tasks cannot assert on filesystem side effects, only on the
  model's self-report — a real but bounded limitation until a workspace
  handle ships.
- SIGINT during a run loses that run's spend. Accepted because nothing
  consumes a partial scorecard yet.
- The skillsDir containment guarantee is parse-time only: tasks are all
  parsed (and contained) up front, but `skills/load.ts` does not re-validate
  root containment when each task later loads its skills, so a root swapped
  to an escaping symlink between parse and load would be walked. The only
  in-process actors able to win that race are an oracle (already arbitrary
  code — R-10) or sandbox/permission-gated model writes, so this adds no
  privilege beyond documented residuals (E-1 differential review, F-4).

## Alternatives considered

1. **Single `eval/golden` module, no scorecard split.** Rejected — E-2's
   red-team path is session-free; without the split it would either
   duplicate scoring machinery or awkwardly depend on the session-shaped
   runner.
2. **Oracle sees filesystem/tool-trace state, not just `SessionResult`.**
   Rejected for v1 — no workspace handle exists to hand the oracle safely;
   deferred as a named limitation and revisit-if rather than half-built.
3. **Run golden eval in per-PR CI.** Rejected — needs a live
   `ANTHROPIC_API_KEY` in CI and executes PR-author-controlled oracle code, so
   a fork PR becomes a straightforward exfiltration path. E-3's deterministic
   heuristic arm is the every-PR gate instead (ADR-0016 §7).
4. **Accept truthy oracle returns (`{ pass: 'yes' }` passes).** Rejected — a
   broken oracle that returns a truthy non-boolean must never silently pass
   every task it judges; the strict boolean check turns that failure mode
   into an explicit `oracle-error` row instead.

## Revisit if

- A settings fingerprint is needed in `meta` once scorecards must be compared
  across differing security postures (v1 documents the variance but does not
  encode it).
- ~~A `--max-tasks` or spend-budget flag is needed once golden suites grow
  large enough that sequential execution plus pre-flight count is
  insufficient mitigation.~~ **FIRED 2026-09-04, issue #95: `--max-tasks`
  shipped with a default of 100 (amendment at the end of this ADR). The
  spend-budget half stays open, re-listed as its own bullet below.**
- A spend-budget flag (dollars, not tasks) is needed once a pack inside the
  task limit can still cost more than an operator would accept; `--max-tasks`
  bounds count, not price.
- The SDK grows an abort channel on `QueryFn` — implement per-task
  wall-clock timeout support then.
- Partial-scorecard-on-SIGINT semantics become worth building, in step with
  E-3 (there is no consumer for a partial scorecard until a baseline exists
  to compare it against).
- Side-effect oracles are needed — extend the oracle contract with a
  workspace handle beyond `SessionResult` at that point.
- `failingField()` gets a third copy site (skills loader, golden task parser,
  plus one more) — extract it to `src/internal`, per the project's
  two-copies-is-a-pattern rule for hoisting shared guards.
- E-2 needs new failure kinds — parameterize the scorecard kind set instead
  of widening the shared `FAILURE_KINDS` enum (deferred from the E-1 review's
  architecture pass, finding H1).
- A second runner composition appears (beyond the golden runner) — make
  `redactSecrets` a required dep, or an explicit `'none'` opt-out, so omitting
  it becomes a type error instead of a silent no-redaction default (deferred
  from the E-1 review, finding M1).
- `run`/`eval` session wiring drifts apart — extract a shared task-session
  factory inside the composition root (`src/cli.ts`) rather than letting the
  two call sites diverge (deferred from the E-1 review, finding M2).
- The layering rules keep growing — move to a table-driven (layer × forbidden
  target) matrix in `src/layering.test.ts`; note that flat-config
  `no-restricted-imports` blocks override rather than merge across config
  objects, which is pre-existing behavior worth documenting explicitly at
  that point (deferred from the E-1 review, finding M4).

## Amendment (2026-09-04, issue #95): golden packs are bounded, and the "default cap" wording was wrong

Two bounds landed, one per layer the 2026-08-25 external review named (triage
row 7f, `process/reviews/external-review-2026-08-25-triage.md`):

- `src/eval/golden/schema.json` now gives `maxTurns` a `maximum` of 100 beside
  its `minimum` of 1. A task above it is a per-task `task-parse` row naming
  the field (decision 4's dividing line: a single-file problem is a row, not a
  run-level error) and the rest of the pack runs. The value is ten times the
  default and well above every shipped example (the fixtures use 1 to 3, the
  init template 5, the adversary 1). It is a sanity bound on a
  repository-controlled file, to be raised here by amendment if a real pack
  ever needs it, not routing policy. `run --max-turns` is typed by the
  operator per invocation and stays unbounded.
- `run()` takes `maxTasks` (default `DEFAULT_MAX_TASKS`, 100) and refuses a
  pack with more task files than that as a run-level usage error: exit 2, no
  scorecard, after discovery and before any file is parsed or any session
  exists. The runner owns the default so a library caller is bounded too; the
  CLI's `--max-tasks <n>` only parses an override, with the rule `run`'s
  integer flags use restated here in full: digits only, `parseInt`,
  `Number.isSafeInteger` (above 2^53 `parseInt` rewrites the digits), a floor
  of 1, and plain reassignment so the last value wins. An explicit larger
  value is the operator saying so, which is the design.

What this corrects. Decision 5 and the wall-clock limitation both called
`DEFAULT_MAX_TURNS` a cap. It was a fallback applied only when the
frontmatter omitted the field; a task could set `maxTurns: 100000` and
`createSession` passed it to the SDK unclamped, and the pre-flight task count
was written to stderr and never enforced. Both sentences keep their text and
carry a dated correction in place.

What this does not do. There is still no spend budget (dollars, not tasks)
and no per-task wall-clock timeout; both stay in Revisit if. The two bounds
compose only as a ceiling of `maxTasks` times 100 turns, which is a count,
not a price. Neither bound is a security boundary: R-10 already accepts
arbitrary in-process oracle code from the same pack, so a hostile pack can do
worse than run long. The bound is cost and wall-clock hygiene against
mistakes and low-effort abuse.
