# S3 design spec: `harness init` scaffolder, v2 (post-panel)

Status: v2, 2026-07-14. Panel run (skeptic + constraint = Fable, advocate =
sonnet); all three APPROVE-WITH-CHANGES; findings arbitrated below. Awaiting
Jackson's design approval before implementation.

## Goal

`init [dir]` scaffolds a minimal, runnable starter project so a user arriving
from a blog/HN link gets from nothing to a working `run` + `eval` in minutes,
without reading the full README first.

Not the differentiator (that is `process/`); CUT-IF-SLIP. Design bias:
smallest honest surface.

## Command surface

- `init [dir]`: dir defaults to `.`; created recursively if absent.
- No flags in v1. No `--force`. No template variants.
- **Exit codes (corrected by panel; verified against cli.ts):**
  - 0 = scaffolded successfully
  - 2 = refused, nothing written: usage error (free via the shared
    `parseArgs → 2` path, cli.ts:200-205) AND collision refusal; both are
    the repo's existing "refused before any work, nothing produced" class
    (missing key, settings load error, symlink refusal all exit 2)
  - 1 = unexpected fs failure mid-write only (matches "ran and failed")
- Wiring touch-points (implementation checklist): `parseArgs` dispatch
  (cli.ts:78-89) + `USAGE` constant (src/cli/shared.ts:23-27); both under
  the output-text test pins.

## What the starter contains

Layout mirrors `examples/repo-qa/` (proven: cwd-based settings, non-recursive
`*.task.md` discovery at taskDir root, sibling `<name>.oracle.mjs`, skills/
inside the task dir per src/eval/golden/task.ts containment).

```
<dir>/
  README.md
  .gitignore                    # .harness/* + !.harness/settings.json
  .harness/settings.json        # deny WebFetch + WebSearch; NO defaultDecision
  skills/getting-started.md
  hello-harness.task.md         # frontmatter id: hello-harness (= file stem)
  hello-harness.oracle.mjs
```

Content decisions (panel-final):

1. **settings.json: deny `WebFetch` + `WebSearch`, no `defaultDecision`, no
   `_comment` key.** [ARBITRATED; see decision log #4] This is the
   security-model's own named partial mitigation for the R-3+R-4 composed
   chain, and a general-purpose starter must not deny Bash/Write (first real
   `run` prompt would trip denials repo-qa never sees because it is a
   read-only QA agent). The route-around honesty requirement transfers to
   the README: it must name the Bash-curl route-around explicitly, show the
   one-line tighten (add a Bash deny), and include a guided "trip the
   denial" demo prompt (ask the agent to fetch a URL) so the mechanism is
   seen firing, not just declared. `_comment`: both parsers tolerate unknown
   root keys (verified) but the convention is reserved namespace, not a
   comment channel. README-only.
2. **Skill `getting-started.md`**: valid per ADR-0006 schema: frontmatter
   MUST carry `name`, `description`, AND semver `version`
   (`additionalProperties: false`, so nothing else). Body = 3-4 facts about
   the scaffolded project so the golden task answers from the skill alone.
3. **Golden task `hello-harness`**: "answer directly from the loaded skill,
   without using any tools" phrasing; `maxTurns: 5`; oracle pins
   `numTurns === 1` AND checks answer content. Pin kept as a package deal:
   phrasing + oracle + README line explaining a turns-failure in plain terms
   ("used N turns instead of 1; it likely reached for a tool instead of
   answering from the loaded skill"): the failure `reason` string itself
   must say this, not a bare number mismatch. Oracle contract: named export
   `oracle` returning strict `{pass, reason?}`. No package-typed JSDoc
   import in the template (nothing is installed in a scaffolded dir); plain
   JSDoc.
4. **README.md** first content: quickstart (key → run → eval), full R-10
   paragraph, route-around note + tighten line + trip-the-denial prompt
   (see 1), turns-failure explainer, one sentence "if this dir sits inside a
   repo whose ancestor .gitignore ignores `.harness/`, confirm
   settings.json is tracked", and: if you add CI, run only keyless
   `redteam`, never keyed eval.
5. **.gitignore**: `.harness/*` + `!.harness/settings.json`. (Provenance
   corrected: this pattern lives at this repo's root, repo-qa ships no own
   .gitignore; the two-line standalone form is semantically valid: `*`
   ignores contents not the dir, so negation is honoured. First real
   exercise of the standalone form → semantic test below.)

## Template-embedding strategy

TS string constants in `src/cli/init-templates.ts` → compiled into `dist/`
(`files` allowlist = dist/README/LICENSE; build is bare `tsc`, no copy step,
so loose template files would silently vanish from the npm tarball;
verified). Templates stay in `src/cli/` (leaf modules ban `**/cli/**`
imports; cli is the composition root and may import skills `validate`,
settings parsers, golden task parser; eslint layering verified).

Semantic-validity tests (keyless CI):
- scaffolded skill passes real `validate()`
- scaffolded settings parse under BOTH real parsers (permissions + sandbox)
- scaffolded task parses under the real golden-task parser (id charset,
  containment)
- scaffolded oracle imports and satisfies the oracle contract (import() from
  a temp scaffold in a test, not `new Function`)
- `git check-ignore` against a real scaffolded instance: telemetry.db
  ignored, settings.json tracked
- README template contains R-10 warning + key-setup + route-around note
- post-init output pins (tree, next steps, R-10 line)
- collision refusal: exit 2, full conflict list, nothing written

## Collision / overwrite policy (fail-closed)

- Stat ALL target paths first; if ANY exists → print full conflict list +
  `try: init <new-dir>` suggestion → exit 2, zero writes. No merge, no
  `--force`.
- Honest framing (corrected): because the target set includes README.md and
  .gitignore, `init .` into an existing repo will nearly always refuse;
  the practical contract is a fresh/empty target dir. Say so in USAGE and
  the ADR; do not claim "init into an existing repo is fine".
- TOCTOU not defended (local scaffolder; panel concurs).

## Post-init UX

Print (all under test pins): the created tree; numbered next steps with the
**computed invocation**: resolve `process.argv[1]` and render `run`/`eval`
commands relative to it (`node ../dist/cli.js …` style), NEVER the hardcoded
`agent-harness-ja` bin name, which is not on PATH pre-publish (post-publish
detection of a true bin invocation can print the short form, an implementation
detail); key step branches on whether `ANTHROPIC_API_KEY` is already set
("already set? skip"); the suggested `run` prompt mirrors the golden task's
prompt so the first manual run and the eval reinforce each other; expected
eval outcome incl. "well under a cent" cost line; one-line R-10 pointer at
terminal altitude (full paragraph lives in README: differentiated altitude,
not duplication); artefact locations corrected: run telemetry →
`.harness/telemetry.db`, **eval scorecards → `.harness/eval/`** (eval uses an
in-memory DB, never telemetry.db; verified eval-command.ts:170-172).

## Missing-key preflight: REMOVED (stale premise)

Both `run` (cli.ts:219-224) and `eval` (eval-command.ts:107-110) ALREADY
hard-fail with a clear message and exit 2 before any SDK call/spend. All
three panellists verified this independently; the spec's v1 premise ("raw
SDK throw") was written from memory and was false. Residual in-scope work:
enrich the two existing messages with export syntax + key-console URL
(advocate's drafted wording), keeping behaviour identical. No skip-env, no
warn-only, no SDK-error rewrite.

## What init does NOT do (v1)

No CI scaffolding (README carries the keyless-redteam-only rule); no
`--template`/prompts/git-init/npm-install; no network; no telemetry writes
during init.

## Acceptance

- Keyless CI = the semantic-validity + collision + output-pin tests above.
- Keyed MANUAL check (documented, never called a CI gate): scaffold → run →
  `eval .` → 1/1 pass, 1 turn.
- Docs: ADR-0021 (embedding strategy, fail-closed collision + fresh-dir
  contract, no-CI decision, settings posture incl. dissent, exit-code map);
  README `init` planned→shipped; architecture.md CLI row.

## Panel decision log

| # | Finding (source) | Disposition |
|---|---|---|
| 1 | Exit-code map backwards; usage errors exit 2 today (skeptic CRIT, constraint HIGH) | ACCEPTED: usage 2, collision 2, 1 = mid-write failure only |
| 2 | Missing-key preflight already shipped; v1 premise false (all three) | ACCEPTED: scope addition deleted; message enrichment only |
| 3 | "Init into existing repo fine" de facto false (skeptic HIGH, constraint LOW) | ACCEPTED: fresh-dir contract stated honestly + error suggests new dir |
| 4 | Settings: skeptic demands full repo-qa deny list (Bash-open = route-around anti-pattern, HIGH); constraint + advocate argue WebFetch/WebSearch-only (general-purpose starter, zero first-run denials, R-3 doc-grounded) | **ARBITRATED 2-1 for WebFetch/WebSearch-only**, with the skeptic's real concern satisfied in prose: README names the Bash route-around, shows the tighten, demos a denial. Dissent recorded; Jackson to confirm |
| 5 | `_comment` key: tolerated but wrong channel (all three) | ACCEPTED: README-only |
| 6 | numTurns===1 keep as package deal + plain-language failure reason (skeptic MED, advocate MED) | ACCEPTED |
| 7 | Post-init print: computed invocation path, not bin name (advocate HIGH) | ACCEPTED |
| 8 | Eval artefact is scorecard in .harness/eval/, not telemetry.db (constraint MED) | ACCEPTED: print + README corrected |
| 9 | USAGE/dispatch touch-points unstated (skeptic LOW, constraint LOW) | ACCEPTED: checklist + pins |
| 10 | .gitignore provenance misattributed; add git check-ignore semantic test (constraint LOW, advocate LOW) | ACCEPTED |
| 11 | Skill frontmatter needs `version`; additionalProperties false (constraint) | ACCEPTED: pinned |
| 12 | Task id = file stem explicitly (advocate LOW) | ACCEPTED |
| 13 | Oracle JSDoc package-import won't resolve in scaffold (skeptic LOW) | REVISED AT IMPLEMENTATION: kept the typed header; src/eval/golden/oracle.ts documents it as THE authoring contract and repo-qa uses it; inert plain text until install. Recorded in ADR-0021 decision 8 |
| 14 | Ancestor-gitignore caveat sentence (skeptic LOW, advocate LOW) | ACCEPTED: one README sentence |
| 15 | `engines >=20.1.0` overclaims (import attributes need 20.10; CI matrix never catches it) (constraint MED, pre-existing) | ACCEPTED as S4 item: added to tasks/todo.md S4 checklist, not this PR |
