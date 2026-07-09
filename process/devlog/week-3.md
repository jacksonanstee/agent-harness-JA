# Week 3 — Eval layer (2026-07-08 → planned 2026-07-19)

Planned scope: E-1 golden task runner, E-2 red-team corpus (≥50 cases),
E-3 deterministic regression gate, E-4 scorecard polish. Checkpoint: a
`cli eval` run produces a scorecard the regression gate can diff.

## 2026-07-08 (PM) — E-1 design locked

Design-first, same gate as the security modules: a full spec
(`process/designs/2026-07-08-e1-golden-runner.md`) went through a
three-reviewer panel (skeptic + constraint on Fable, user-advocate on
Sonnet — 33 findings) and an arbiter before any code. The catches that
changed the design:

- **CRITICAL:** committing scorecards containing raw `resultText` would
  have committed secrets the redaction layer exists to stop. Fix: injected
  `redactSecrets` on every scorecard string + a structural field allowlist
  (the row type simply has no raw-output field).
- "Committed golden baseline" contradicted both the gitignore posture and
  ADR-0016's determinism requirement — golden scorecards became
  informational; E-3's gate diffs the deterministic red-team arm instead.
  This also forced the useful split: `src/eval/scorecard/` is
  producer-agnostic, `src/eval/golden/` is one producer.
- Golden eval **never runs in per-PR CI**: oracles are PR-author code and
  CI holds an API key — a fork PR would be a clean exfiltration path.
  Operator-invoked only, stated in three places (ADR-0017,
  security-model R-10, a runtime warning).

## 2026-07-09 — E-1 implemented (subagent-driven development)

Morning: the approved spec became a 12-task TDD plan. Evening: all 12
tasks executed, each with an implementer + reviewer pair. 21 commits on
`feat/eval-e1-golden-runner`; 661 tests by end of day. Notables:

- Task format: `*.task.md` (ajv 2020-12, id regex-pinned) + sibling
  `*.oracle.mjs` returning a strict `{pass: boolean}` — truthiness is
  rejected, a lying oracle becomes an `oracle-error` row, not a pass.
- The frontmatter RCE/ReDoS guards from the Week-1 skills loader hoisted
  to `src/internal/frontmatter.ts` on their second consumer (pure move,
  proven by the untouched skills tests).
- Per-commit /review3 caught a HIGH skillsDir path-traversal, and the
  security *verifier* then caught that the fix itself was dodgeable by a
  repo-committed symlink — closed with a realpath containment re-check.
  Two review layers earning their keep on the same finding.
- A haiku-tier fixer smuggled in a project-wide ES2024 tsconfig bump to
  get one assertion compiling — reverted, and a lesson recorded: scope
  discipline is a model-tier property; fixes route to Sonnet.

## 2026-07-10 — Milestone gate, fixes-on-fixes, merged

The mandatory whole-branch differential review ran as three parallel
dimensions (containment/code-exec, run-vs-eval composition seams,
regression/coverage/docs), report at
`process/reviews/differential-review-e1-milestone.md`. Verdict
**APPROVE-WITH-NITS**: the seam checks came back clean — `eval` wires
every security callback `run` does, the guard hoist is byte-identical,
no Week-2 finding regressed — plus 1 MEDIUM and 5 LOW.

The MEDIUM was a Trojan-Source gap in a sink the per-commit reviews each
half-covered: `reason` was bidi-stripped, but a *failed-parse row id*
falls back to the task filename, and a hostile repo can commit a
filename carrying an RLO override straight to the terminal and the JSON
artifact.

The first fix (clean the id at row construction) drew three convergent
MEDIUMs from its own /review3 round: ids passed through the secret
redactor could be falsely rewritten; cleaning *after* the uniqueness
check let two bidi-distinct filenames alias to one row id; and the
duplicate-id error message itself interpolated the raw id. One
refinement resolved all three — **strip bidi at parse time, before
`assertUniqueIds`, and never redact ids** — collisions now fail loudly
before any API spend. Same round: `fallbackRowId`'s naive `.slice(0,64)`
joined the shared surrogate-safe truncation helper, `containSkillsDir`
fail-closes on non-ENOENT realpath errors, and every scorecard write
failure now maps to exit 2 (the contract's "no scorecard produced"),
not just symlink refusals. One reported finding died on verification:
the "stale" security-model test count is an explicitly frozen Week-2
snapshot — the report records the invalidation, the doc stands.

672 tests. PR #19 squash-merged (`202530e`). Live smoke against the API:
both starter golden tasks pass, exit 0, scorecard written, R-10 warning
fires, $0.04. E-1 done.

Deferred with named triggers (ADR-0017 Revisit-if): FailureKind
parameterization before E-2 widens it, `redactSecrets` as a required
dep, shared run/eval session factory, table-driven layering matrix.
Next: E-2 red-team corpus.
