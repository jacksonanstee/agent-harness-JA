# ADR-0021: `init` scaffolder: embedded templates, fail-closed collisions, no scaffolded CI

- **Status:** Accepted
- **Date:** 2026-07-14
- **Requirements:** Week-4 S3 (explicitly CUT-IF-SLIP; the last feature before
  publish)
- **Relates to:** ADR-0006 (the scaffolded skill must satisfy the skill
  schema), ADR-0014 (the scaffolded policy is a pure-tightening project
  layer), ADR-0016 §7 / ADR-0017 (keyless-CI invariant the scaffold must not
  break), ADR-0017 (golden-task and oracle contracts the scaffolded task
  must satisfy)
- **Design + panel decision log:**
  [2026-07-14-s3-init-scaffolder-design-and-decision-log.md](../../process/designs/2026-07-14-s3-init-scaffolder-design-and-decision-log.md)
  (skeptic/constraint/advocate panel; 15 findings, all dispositioned)

## Context

Publishing to npm (S4) makes `init` the likely first contact for anyone
arriving from a blog post: the first command they run, the first output they
read, and the first project the harness ever generates for them. The design
constraint hierarchy, in order: never lie in the first five minutes (about
costs, about what the policy stops, about what a failure means), never
widen anything security-relevant, and stay small (the scaffolder is not the
differentiator, and was the first feature marked for cutting).

## Decisions

1. **Templates are TypeScript string constants** (`src/cli/init-templates.ts`)
   compiled into `dist/`. The npm `files` allowlist ships only `dist`,
   README, LICENSE, and the build is bare `tsc`: a loose `templates/`
   directory would silently vanish from the published tarball. Semantic
   validity is CI-gated against the REAL loaders (skills `validate()`, both
   settings parsers, `parseTaskFile`, `loadOracle` contract, plus a live
   `git check-ignore` over a scaffolded instance), not substring checks.
2. **Fail-closed collision policy.** Every target path is checked before
   anything is written; any collision refuses the entire operation with the
   full conflict list and exit 2 (the repo-wide "refused, nothing produced"
   class, same as parse errors, missing key, and malformed settings). No
   `--force`, no merging. Honest consequence, stated rather than hidden: the
   target set includes `README.md` and `.gitignore`, so `init` into an
   existing project will nearly always refuse; the practical contract is a
   fresh directory, and the refusal message says so.
3. **The starter policy denies `WebFetch` and `WebSearch` and omits
   `defaultDecision`.** Panel-arbitrated 2-1 (constraint + advocate vs
   skeptic, who argued for the full repo-qa deny list). The deny pair is the
   security model's own named partial mitigation for the R-3+R-4 composed
   exfiltration chain; omitting `defaultDecision` keeps the one
   project-overrides-user scalar (R-8) out of every generated project. The
   skeptic's route-around objection (Bash `curl` defeats a network deny) is
   carried in prose, not silently: the scaffolded README names the
   route-around, shows the one-line tighten, and includes a guided
   trip-the-denial prompt. A general-purpose starter that denied Bash/Write
   would fail its user's first real prompt; repo-qa can afford that posture
   only because it is a read-only Q&A example.
4. **The golden task pins `numTurns === 1`** (the groundedness lesson from
   PR #28) as a package deal: task phrasing demands a no-tools answer, the
   oracle's failure reason explains a turns-failure in plain language, and
   the scaffolded README carries the same explanation. Relaxing the pin
   would reopen the "right answer, wrong mechanism" false-pass it exists to
   close.
5. **No scaffolded CI.** The simplest honest answer to the keyless-CI
   invariant: nothing generated, nothing to get wrong. The scaffolded README
   states the rule (keyless `redteam` only; a fork PR plus a CI key plus
   in-process oracles is an exfiltration primitive).
6. **The printed next steps compute the real invocation** from
   `process.argv[1]` (relative path, absolute when the relative climb
   exceeds three `..` segments, bin name only under a true bin-shim
   invocation). Pre-publish there is no bin on PATH; printing
   `agent-harness-ja` would be `command not found` on the success path. The
   key step branches on whether `ANTHROPIC_API_KEY` is already set.
7. **No new missing-key preflight.** The panel's highest-value catch: all
   three reviewers independently verified that `run` and `eval` already
   hard-fail with exit 2 before any SDK call; the design draft had inherited
   a stale premise from the week plan. Residual work was a message
   enrichment only (export syntax + key-console URL), shipped in this
   change.
8. **The scaffolded oracle keeps the documented typed-JSDoc header**
   (`@type {import('agent-harness-ja').OracleFn}`), matching the authoring
   contract in `src/eval/golden/oracle.ts` and `examples/repo-qa`. This is a
   recorded deviation from the panel's LOW disposition (plain JSDoc): the
   repo's own docs prescribe the typed form, it is inert plain text until
   the package is installed, and consistency with the documented contract
   wins. (Decision log #13 note.)

## Consequences

- A published `npx agent-harness-ja init my-agent` produces a project that
  passes its own eval in one turn (verified live pre-merge: 1/1 pass, 1
  turn, $0.0318) and whose README makes honest claims about cost ("a few
  cents at most"; the earlier "well under a cent" phrasing was corrected
  against observed costs, including in `examples/repo-qa`).
- Six template constants become load-bearing documentation; the semantic
  test suite is what keeps them from drifting as schemas evolve.
- Exit-code surface is unchanged: 0 success, 1 unexpected mid-write failure
  (main's catch-all), 2 refusals.

## Alternatives considered

- **Template files on disk** (a `templates/` dir): breaks silently after
  `npm pack`; rejected on the files-allowlist constraint.
- **`--force` / merge-into-existing:** overwrite semantics in a first-contact
  command invert fail-closed; rejected.
- **Full repo-qa deny list:** rejected 2-1 as a first-run UX failure for a
  general-purpose starter (decision 3 records the dissent).
- **Scaffolded CI workflow:** rejected; every generated CI file is a chance
  to violate the keyless invariant in a repo the maintainer never sees.

## Revisit if

- **R1:** npm publish lands (S4): the invocation renderer's bin-shim branch
  becomes the common path; verify the printed commands against a real
  global install.
- **R2:** a second starter variant is requested (`--template`): that is the
  moment to design template selection, not before.
- **R3:** issue #29's block-on-flag posture ships for skill bodies: the
  scaffolded skill then flows through a scanning gate and the starter should
  document it.
