# Differential Security Review — E-2 Red-Team Corpus Milestone Gate

**Branch:** `feat/eval-e2-redteam-corpus` @ 3c7024b
**Diff:** `git diff da3e686..3c7024b` — 13 commits, 31 files (+2,177 / −160): new `src/eval/redteam/` (corpus + runner + renderer + drift diagnostic), producer-agnostic scorecard-core refactor (ADR-0017 H1), `cli redteam` keyless subcommand, CI gate, ADR-0018 + week-plan reword.
**Reviewer:** differential-review (whole-branch milestone gate — 3 parallel dimensions: red-team security surface, scorecard-refactor blast radius, coverage/docs/hygiene; per-task SDD reviews not re-litigated)
**Date:** 2026-07-10
**Verdict:** ✅ **APPROVE-WITH-NITS** — 0 HIGH/CRITICAL; 3 MEDIUM + 4 LOW, all resolved on-branch. Nothing blocks the milestone. See §Resolution.

---

## 1. Scope & Strategy

MEDIUM codebase, FOCUSED. Read in full: `src/eval/redteam/*`, `src/eval/scorecard/core.ts`+`canonical.ts`, `src/eval/golden/scorecard-shape.ts`+moved `markdown.ts`, `src/cli.ts` redteam path, ADR-0018, week-plan. Empirical: payload-containment probe on built `dist/`, live `node dist/cli.js redteam`, `computeByFailureKind` drift probe, full suite. Out of scope: accepted ADR-0018 decisions (E-2 ship-window, off-arm guaranteed-zero, detection-reported-not-gated, the 3 known-missed).

## 2. Empirical Verification

| Check | Result |
|---|---|
| Full suite | ✅ 35 files, **703 tests** pass |
| tsc / eslint | ✅ clean |
| Keyless smoke `node dist/cli.js redteam` (no API key) | ✅ exit 0, `Gate: PASS`, scorecard written |
| Payload-containment probe (10 distinctive payload substrings vs canonical JSON + markdown) | ✅ **zero** leak; row keys = `category,expected,failureKind,id,pass,reason,verdict`; reasons = 4 fixed literals |
| Output dir `.harness/` committed? | ✅ gitignored + untracked — no adversarial artifact reaches a rendered `.md` |
| Re-derived numbers | corpus 13/9/9/9/11 = 51; detection 37/40 = 92.5%; strength blocked 23 / flagged-only 14; benign-block 0; misses exfil-02/indirect-09/jailbreak-03 — **all match ADR-0018 exactly** |
| Golden regression | ✅ 47 golden tests green; invariant table all PRESERVED; `toCanonicalJson` byte-stable for golden |
| Layering edge | ✅ `grep "from '.*golden'" src/eval/scorecard/` empty; no new backward edge |

## 3. Findings (theme: two ADR claims are stronger in prose than in code)

### F-1 — MEDIUM: strength-split render line is unpinned
`src/eval/redteam/markdown.test.ts:22-24` asserts only `/1\/1 malicious/`, never the `blocked X / flagged-only Y` substring. ADR-0018 decision 9 names that line the **interim defense** against gate-invisible block→ask softening in the E-2→E-3 window — yet deleting/mislabeling/swapping it in the render would pass. Runner-level totals math is pinned (`runner.test.ts:72-77`); the render is not.

### F-2 — MEDIUM: week-plan E-2 checkbox left unchecked/undated
`process/05-week-plan.md:78` still `- [ ]` with no `*(date, ADR)*` annotation, despite E-2 being fully merged on this branch — inconsistent with the file's own completion convention (cf. E-1 `[x]` at :77). The reword commit touched only the Checkpoint paragraph.

### F-3 — LOW-MEDIUM: stale "<50%" off-arm language in the week-plan checkpoint
`process/05-week-plan.md:83` retains "(<50%, proving the security layer does real work)" — a pre-ADR carryover. ADR-0018 decision 5 + the renderer make the off-arm a **guaranteed-zero-by-construction** control (0/40), not a soft measured "<50%". The phrasing mischaracterizes (and undersells) what was built.

### F-4 — LOW: id "double-guard" is not two independent guards; ADR-0018 decision 4 overstates it
`markdown.ts:18` + `corpus.test.ts:11-13`. The charset pin `^[a-z0-9][a-z0-9-]{0,63}$` lives ONLY in the test — there is no runtime validator (golden validates its task ids at parse time via AJV schema; redteam does not). And `escapeCell` escapes only `|`/`\n`, NOT markdown image syntax `![]()`. So the real protection against a beacon-shaped id is the single vitest assertion. Not exploitable today (markdown → stdout/CI-log only, output gitignored, test runs before the gate), but a ratchet risk, and decision 4's "rejected at validation … same shape as golden's task ids" overstates the parity.

### F-5 — LOW: `computeByFailureKind` can drift from type `K`; ADR-0018 decision 6 "cannot drift" overstated
`src/eval/scorecard/core.ts:28-37`. `K` is inferred jointly from `rows` + `kinds`; a subset tuple is assignable to `readonly K[]`, so a producer passing a tuple missing a kind its rows carry compiles clean and yields NaN/`null` for the dropped count (empirically confirmed under `tsc --strict`). Blast radius on golden/redteam = **NIL** (both pass their canonical `as const` tuple), but the drift path is untested and the ADR guarantee isn't enforced.

### F-6 — LOW: exit-0-on-missed pinned only indirectly
`cli.test.ts:495-499` pins "a `missed` case doesn't fire the gate" only via the live corpus's 3 current misses. If the scanner later closes them, this invariant silently loses coverage. No isolated stub-based test constructs a deliberate `missed` case → exit 0.

### F-7 — COSMETIC: stale comment
`src/eval/scorecard/sanitize.ts:16` still says "ScorecardRow has no raw-output field"; that type is now `GoldenRow`/`RedteamRow`.

## 4. Clean (negative coverage)

Payload containment (no `case.text`/excerpt on any row, in JSON, or markdown — empirical); gate partition (`falseBlockCount` = benign→block only, off-arm never run so no null-arm confusion); defang (all exfil URLs `.example`/`.invalid`, no real secret/credential shape, base64 blob decodes to harmless text); keyless CI surface (no runtime attacker-file read, no network, corpus compiled-in, no golden-style oracle exec); golden invariants all preserved (`tasks→total` rename non-diffed + no consumer, markdown still prints "Tasks:"); layering edge discharged; drift diagnostic genuinely non-gating (only trivially-true assertions); every ADR-0018 quantitative claim matches live output.

## 5. Resolution (applied on-branch before PR)

| Finding | Action |
|---|---|
| F-1 MEDIUM | fixed — `markdown.test.ts` asserts the `blocked X / flagged-only Y` render line |
| F-2 MEDIUM | fixed — week-plan E-2 checkbox ticked `[x]` with date + ADR-0018 annotation |
| F-3 LOW-MED | fixed — off-arm reworded to the guaranteed-zero control (not "<50%") |
| F-4 LOW | fixed — runtime id-charset validator added to the redteam path (makes decision 4 literally true); ADR-0018 decision 4 parity wording corrected |
| F-5 LOW | fixed — `computeByFailureKind` hardened (no NaN on out-of-tuple kind) + regression test; ADR-0018 decision 6 wording softened to "must be passed the producer's canonical tuple" |
| F-6 LOW | fixed — isolated stub test: a deliberate `missed` case → `falseBlockCount 0` → exit 0 |
| F-7 COSMETIC | fixed — comment updated |
