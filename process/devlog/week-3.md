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

## 2026-07-10 — E-2 red-team corpus (design → SDD → merge, one session)

Design-first through the multi-agent panel again, then an external
Gemini adversarial pass, then executed via subagent-driven development
(9 TDD tasks, a spec+quality review after each, a whole-branch
differential-review gate at the end). Merged as PR #20 (`066687d`).

The load-bearing decision surfaced in review, not up front. My first
design gated CI on ≥90% detection — but that is the exact number
ADR-0016 §6 reads to decide whether to build the LLM judge. Gate on it
and an honest new attack the scanner misses can't merge until it's
curated away, so the corpus could never measure the scanner's real
ceiling. The two purposes point the same number in opposite directions.
So the gate enforces one hard invariant — `falseBlockCount === 0`, no
benign input ever blocked — and detection is *reported*, measured at
37/40 = 92.5%, stated plainly rather than lowered to pass. E-3 adds the
no-regression clause; until then the gate is thin by design, documented
as a time-boxed window in ADR-0018.

Security posture the panel shaped: scorecard rows carry *outcomes, never
payload text*. A row is `{id, category, verdict, expected, failureKind,
reason}` with `reason` a fixed enumerated string, so a committed
red-team payload (a Greshake exfil beacon, a DAN prompt) never reaches
the rendered markdown or the canonical JSON — no live image-beacon
markup in a GitHub-rendered artifact, and no trip of the repo's own
secret-scan hook. Corpus payloads are defanged (fragment-assembled
credential shapes, non-resolving `.example`/`.invalid` domains). The 51
cases wrap the 31-case S-1 starter corpus through a family→category map
and add ~20 new indirect/jailbreak/exfil cases; every `expected` verdict
was calibrated from live `scan()` output, never guessed. Three cases are
honest known-misses — realistic attacks with no trigger tokens — and
they expose that the scanner has no jailbreak-persona rule, a finding
that feeds the S-5 decision.

The scorecard refactor (ADR-0017 H1) split the golden-specific scorecard
into a producer-agnostic core (`ScorecardRowCore<K>`, a `producer`
discriminator, a shared `byFailureKind` helper) with per-producer
renderers; golden's renderer moved out of the core. The whole-branch
gate verified no golden regression and caught two ADR claims worded
stronger than the code enforced (the id guard was test-only; the count
helper could silently NaN) — the fix made the code match the claims: a
runtime id validator and a hardened counter.

CI then caught what local checks didn't. Every subagent verified with
bare `tsc --noEmit`, which excludes test files; CI runs `npm run
typecheck` (`+ tsc -p tsconfig.test.json`), which strict-checks them
under `noUncheckedIndexedAccess`. Latent strict-null errors in the test
files passed every local gate and only failed in CI. Lesson recorded:
the verification command a subagent runs must be the project's real gate
script, never a looser proxy. Fixed, both legs green, 706 tests.

Next: E-3 deterministic regression gate — it diffs this scorecard's
`producer: redteam` canonical JSON and fails CI on drift, converting
E-2's thin gate into a real one.

## 2026-07-12 — E-3 regression gate (design → 12-task SDD → merge)

E-3 shipped as PR #21: `cli redteam` is now compare-by-default against a
committed canonical-JSON baseline (`eval/redteam/baseline.json`), and CI
fails on *any* behaviour drift — ADR-0018 decision 9's named window
(block→ask softening invisible to the gate) is closed on schedule.

The load-bearing design choice, made before any code and recorded in
ADR-0019: **fail on any drift, improvements included.** The surveyed
consensus (promptfoo, Braintrust, Semgrep/gitleaks baselines, Jest
snapshot doctrine, Betterer) is an asymmetric ratchet — weakenings fail,
improvements warn. The ratchet has a latent hole: an unrecorded
improvement leaves the committed baseline stale, and a later slide back
to the recorded state diffs clean. Betterer papers over it by
auto-committing; our CI can't commit, so the honest equivalent is
byte-equality with reality, always. The asymmetry lives in the
*messaging*: every drifted row is classified (regression / improvement /
new-case / recalibration / envelope) with a per-class remedy line, so a
red gate tells the contributor exactly which kind of red it is — an
honestly-added missed case gets "update the baseline to record it",
never "curate the case away."

The baseline itself is treated as hostile input (the attacker model puts
a malicious cloned repo in scope, and this file is the keyless gate's
first read of repo-controlled data): symlink refusal, stat-before-read
size cap, an exact ajv field allowlist, id-charset revalidation, and
Map-based row pairing. Review earned its keep twice here. The overnight
build's own gate caught a CRITICAL in the update path — `writeFileSync`
through an unchecked `${path}.tmp` follows a repo-committed symlink, a
deterministic arbitrary-file overwrite, fixed with O_EXCL and a tmp-path
symlink check. And the final review panel caught the docs *overclaiming*
the defenses: the id charset was credited with excluding
`constructor` — it doesn't (`^[a-z0-9][a-z0-9-]{0,63}$` matches it
fine); the real prototype-key immunity is the Map pairing, and the docs
now attribute it honestly, with a rule for future code: index rows by
Map, never by plain object.

The milestone differential review (whole branch vs main) came back
SOUND-WITH-NITS with the killer scenario — a crafted baseline making the
gate exit 0 while behaviour drifted — closed by construction: the
absolute `falseBlockCount === 0` gate and the independent totals
backstop read only the fresh run, never the baseline, so nothing an
attacker commits can suppress them.

Process note, recorded in lessons: resuming the plan at "Task 9 done"
revealed the task was half-landed — the commit message claimed the task,
the commit contained one of its three files. Commit messages lie by
omission; when resuming a plan, diff the task's file list against
`git show --stat` before trusting the checkbox.

Merged squash to main (`bbffd01`), 784 tests, both CI legs green under
the new branch protection (require-branches-up-to-date, itself an
ADR-0019 MUST — two concurrent baseline-updating PRs can merge cleanly
into a baseline neither generated). Live smoke on merged main: exit 0,
`GATE_FAILURE=none` — the committed baseline byte-matches reality, which
is the steady state the gate exists to hold.

Next: E-4 adversarial verification (design-first) and
`docs/eval-methodology.md` close the week.

## 2026-07-13 — E-4 adversarial verifier (design panel ×2 + Gemini → 11-task SDD → merge)

E-4 shipped as PR #22 (squash to main `8cd8ad5`): `eval --challenge` runs a
router-selected second Claude model as an adversarial reviewer over every
oracle-passed golden task, reporting findings in a new `verification`
scorecard section. Report-only **by construction**, not by promise —
findings are closed `{status, category}` enums, and `rows[]`, `totals`, and
the exit code are verifier-independent.

The design fight was about what a "finding" is allowed to be. The skeptic's
CRITICAL: prose findings would downgrade E-1's structural no-raw-output
allowlist to procedural sanitization — one missed escape and a hostile
adversary response walks into a rendered artifact. Resolution: enum
confinement (an unknown enum is a per-row `verifier-error`, never a
parse-time widening), with the honestly-priced consequence recorded in
ADR-0020 that a single finding is a prompt to re-examine, not a diagnosis —
the value lives in the aggregate challenge rate. Option B (persist raw
output for investigability) died on the constraint reviewer's CRITICAL: it
reverses ADR-0017 d6 and creates a new hostile-input surface. And
"report-only" itself was challenged as "a sentence, not a property" — the
answer is a CI-enforced differential invariance test pinning rows/totals/
exit equality with and without the verifier. The external Gemini pass on
the implementation plan earned its keep here: a shared mutable step-clock
between the two invariance runs would have made them diverge; the plan now
mandates fresh fakes per run.

Security posture: the adversary is de-fanged — a bare SDK `query()` (never
`createSession`; no memory/telemetry pollution), `maxTurns: 1`, and a
deny-all `PreToolUse` hook pinned by a test that *invokes* the hook rather
than asserting its presence. Prompt hardening is per-call random nonce
delimiters around labelled untrusted payloads. `redactSecrets` promoted
from optional to REQUIRED runner dep (ADR-0017's revisit-if M1, fired by
the new egress path) — output is redacted before the adversary sees it, and
a redaction failure means no call is made at all.

Review layers again found different things. The whole-branch /review3
caught a HIGH the per-task gates missed: an unguarded `verifier.challenge()`
throw could discard a completed oracle run — guarded, plus the MEDIUM raw
retention/ADR overclaim, all fixes independently verifier-confirmed. The
milestone differential review (three parallel dimensions) came back
SOUND-WITH-NITS, 0 crit/high/med: the CLI extraction verified as a
byte-identical pure move, plain `eval` bit-for-bit main behavior, E-3
surfaces zero-diff. Its best LOWs: unescaped `status` cells in the
verification table (a hostile `Verifier` implementation could spoof rows)
and non-finite `costUsd` rendering garbage — both fixed with tests
(`dfca9d4`).

Live acceptance (Claude as both primary and adversary): sonnet-4-6
adversary over the 2 starter tasks, agreed 2/2, challenge cost $0.13, exit
0. The C fallback (deferral ADR, trigger EOD 07-16) never fired. 835
tests. Post-merge smoke on main: `redteam` exit 0 `GATE_FAILURE=none`
(baseline still byte-matches), plain `eval` 2/2 pass $0.045 with the
challenge section correctly absent.

Next: `docs/eval-methodology.md` — the challenge-rate metric's real
consumer (ADR-0020 is interim), the synthetic rendered example, and the
exit-invariance-by-composition note — closes Week 3.
