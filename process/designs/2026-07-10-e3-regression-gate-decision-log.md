# E-3 Regression Gate — Design Review Decision Log

Date: 2026-07-10
Panel: skeptic (SK, Fable-inherit) + constraint-guardian (CG, Fable-inherit) + user-advocate (UA, sonnet), each blind to the others, reviewing commit `5c7fb6a` of the design. Arbiter pass follows this log.
Pre-panel: external best-practice survey (WebSearch subagent) informed the two user-locked decisions; user locked (1) strict per-row weakening semantics, (2) fail on ANY drift including improvements. Neither was reopened by the panel.

Verdict column: **ACCEPT** (design changed), **ACCEPT-PARTIAL** (changed with narrower scope, rationale given), **REJECT** (rationale given), **N/A** (reviewer confirmed non-issue).

## Skeptic (13 findings)

| # | Sev | Finding (compressed) | Resolution |
|---|---|---|---|
| SK1 | HIGH | Classifier table has no bucket for verdict-unchanged drift (`expected` recalibration, `category` change, `reason` rewording) — the design's own flagship decision-8 scenario is unclassifiable | **ACCEPT** — added `recalibration` class (same-verdict field changes; cross-class category changes, where the strength order itself flips) and `envelope` class (meta/totals-shape drift). Test table extended to cover them. |
| SK2 | HIGH | A differ "over `ScorecardRowCore`" can miss the flagship block→ask regression — core fields (`pass`, `failureKind`) are identical on both sides; only extension field `verdict` moves | **ACCEPT** — differ pinned as generic over the concrete row type comparing ALL own fields; extension-field-only change is a named test case in `diff.test.ts`. |
| SK3 | HIGH | Non-canonical baseline bytes (CRLF checkout — no `.gitattributes` exists; hand-edit; merge-mangled key order) fail byte-compare with an empty classification table and no diagnosis | **ACCEPT** — distinct branch: semantically-equal-but-byte-unequal prints "baseline file is not canonical — regenerate with --update-baseline" (still fails, per locked decision 2); `.gitattributes` `eol=lf` pin ships in the E-3 PR; no CRLF normalization on load. |
| SK4 | HIGH | CI runs `npm test` before the Red-team gate step, so the vitest e2e — not the CLI — is the failure surface in CI, and its default output is a raw multi-KB string diff | **ACCEPT** — e2e failure message pinned to be the classifier's rendered report (same single renderer). Design states the ordering fact explicitly. |
| SK5 | MED | `armLabel` is a per-call-site string literal (`cli.ts` vs `drift.test.ts` differ already); e2e would hardcode a third copy → split-brain; meta drift unclassifiable | **ACCEPT** — shared exported `REDTEAM_ARM_LABEL` constant; meta drift covered by the new `envelope` class. |
| SK6 | MED | `--update-baseline` underspecified on 5 axes (false-block bake-in, cwd, atomicity, --out interplay, backstop-in-update-mode) | **ACCEPT** — all five pinned: refuses on falseBlock>0 (exit 1, no write); refuses on backstop failure (exit 2, no write — kills the non-terminating "update the baseline" loop); default path's parent must exist (exit 2, no mkdir); temp+rename write; update mode = normal run + baseline write (still writes --out scorecard + markdown). |
| SK7 | MED | "ids are already charset-guarded" is false for baseline-side ids (guard lives in `runRedteam`, fresh side only) | **ACCEPT** (= CG1) — baseline load re-validates every row id against the same charset (exit 2); full row-shape validation; report sanitized. Design text corrected. |
| SK8 | MED | New-case drift partially resurrects the curated-away incentive unless the message contract is explicit; "detection never gated" needs a level-vs-delta sentence | **ACCEPT** — pinned new-case-only summary line (§Output contract 3); ADR-0018 amendment gains the explicit "level never gated, delta always gated" sentence. |
| SK9 | MED | Concurrent baseline-updating PRs: clean textual merge → non-canonical baseline → red main with no PR to blame | **ACCEPT** as a *named accepted limitation* in ADR-0019 (the Jest-doctrine failure mode carried over honestly); mitigation = require-branches-up-to-date protection; recovery = one regenerate commit. Solo-maintainer repo today; no mechanism built. |
| SK10 | LOW | Both false-block AND drift present: short-circuit? backstop's exit code? | **ACCEPT** — no short-circuit; one combined report; `GATE_FAILURE=false-block+drift`; backstop (`internal`) → exit 2 (producer bug is infra, "update the baseline" can't fix it). |
| SK11 | LOW | "totals drift with identical rows = impossible unless buggy" overclaims — the ADR-0018 decision-6 precedent (adding a field without a schema bump) is legitimate; `corpusSize` re-derivation unstated | **ACCEPT** — legitimate shape drift is the `envelope` class (not `internal`); `internal` reserved for backstop mismatch; backstop re-derives `corpusSize` too. |
| SK12 | LOW | YAGNI: producer-agnostic differ has one permanent consumer (golden needs a *different* comparison contract); `--baseline` flag justified only by tests | **ACCEPT-PARTIAL** — golden-reuse caveat recorded in ADR-0019 (field projection would be needed; not built). Differ stays in scorecard core: it is genuinely producer-agnostic *as code* (no redteam imports) and placing it beside `toCanonicalJson` keeps the byte-stability contract and its differ in one module. `--baseline` kept — now justified by the outside-repo consumer message (CG2/SK13 resolution), not test ergonomics alone. |
| SK13 | LOW | Compare-by-default silently changes a shipped `bin` command's contract for package consumers | **ACCEPT-PARTIAL** (= CG2) — see CG2. Package is unpublished, zero consumers exist; contract declared repo/CI-scoped in ADR-0019 with a context-neutral exit-2 message; package-relative resolution deferred to the Week-4 publish item as a recorded decision point. |

## Constraint guardian (13 findings)

| # | Sev | Finding (compressed) | Resolution |
|---|---|---|---|
| CG1 | HIGH | Baseline-loaded ids bypass `CORPUS_ID_RE`; hostile cloned repo's baseline pushes ANSI/bidi/beacon ids into the drift report | **ACCEPT** — §Baseline load: per-row id charset validation (exit 2) + report through `sanitizeForTerminal`; two independent guards, ADR-0018 decision-4 doctrine preserved. |
| CG2 | HIGH | npm `files` excludes `eval/`; compare-by-default hard-breaks `npx agent-harness-ja redteam` outside the repo; default path cwd-relative rests on unguaranteed cwd | **ACCEPT-PARTIAL** — repo/CI contract declared (ADR-0019); context-neutral exit-2 message pointing at `--baseline <path>`; default path becomes a named constant. Package-relative resolution REJECTED for now: package unpublished, zero consumers; building it pre-publish is YAGNI. Week-4 publish item inherits the recorded decision. |
| CG3 | MED | Hostile baseline: only schemaVersion/producer validated; `__proto__` row id corrupts a plain-object index; malformed rows → mid-diff TypeErrors | **ACCEPT** — full ajv structural validation against exact field allowlist (ADR-0017 precedent); `Map`-based pairing; typed errors → exit 2. |
| CG4 | MED | No size cap on baseline read (multi-GB DoS) | **ACCEPT** — stat-then-refuse over the existing 1 MB `MAX_FILE_BYTES` pattern → exit 2. |
| CG5 | MED | `--update-baseline` write lacks the symlink refusal every other write path has (hostile repo symlinks baseline → `~/.zshrc`) | **ACCEPT** — `refuseSymlinkedDir`-pattern no-follow check on file + parent before write, exit 2. |
| CG6 | MED | `process/01-requirements.md` E-3 row says "persisted in SQLite" — design records only the week-plan wording deviation; milestone gate would mark a MUST met with a silently-substituted medium | **ACCEPT** — ADR-0019 records the deviation against the requirements table; same PR amends the table; acceptance clause explicitly mapped to the corrupted-fixture test. |
| CG7 | MED | No `.gitattributes`; CRLF checkout → local red / CI green split-brain | **ACCEPT** (= SK3) — `.gitattributes` ships in the E-3 PR; no load-time CRLF normalization. |
| CG8 | MED | `cli.ts` at ~753 lines vs 800 hard cap; E-3's additions plausibly cross it | **ACCEPT** — redteam command wiring extracted to `src/cli/redteam-command.ts` planned in the design (not post-hoc); eslint cli band updated in the same commit. |
| CG9 | LOW | Exactly one normalization implementation must be pinned by the design | **ACCEPT** — single exported function in `baseline.ts`, consumed by compare, update, and e2e; fixture-pinned. |
| CG10 | LOW | Totals backstop ambiguous between tautology (imports runner's logic) and unpinned dual implementation | **ACCEPT** — pinned as an independent re-derivation in `baseline.ts` (deliberately not importing `runRedteam` totals code), corrupted-fixture-pinned. |
| CG11 | LOW | `diff.ts` agnosticism holds, but "applies to both producers" needs the golden-volatile-fields caveat (ADR-0017 decision 3) | **ACCEPT** (= SK12) — caveat recorded in ADR-0019 and the design's Code placement. |
| CG12 | LOW | Keyless gate's first read of repo-controlled data missing from `docs/security-model.md` | **ACCEPT** — one security-model entry added to the Documentation list. |
| CG13 | — | Verified-satisfied: CI cost negligible; ADR-0016 §7 / ADR-0017 / falseBlock absolutism / rows-carry-outcomes all honored; fail-on-any-drift maintainable at 51 cases | **N/A** — recorded as constraint-compliance evidence for the arbiter. |

## User advocate (10 findings)

| # | Sev | Finding (compressed) | Resolution |
|---|---|---|---|
| UA1 | HIGH | No pinned remedy text for the common exit-1 drift path (only exit-2 had one) | **ACCEPT** — §Output contract 2 pins the literal remedy line. |
| UA2 | HIGH | `new-case` will read as a rejection unless distinctly labeled + summarized | **ACCEPT** (= SK8) — distinct class label + pinned only-new-case summary line (§Output contract 3). |
| UA3 | HIGH | `--update-baseline` undiscoverable: not in USAGE, README, or any CONTRIBUTING | **ACCEPT** — USAGE + README quick-start line added to the Documentation section; the failure message itself (UA1) is the primary discovery channel. |
| UA4 | MED | No `npm run redteam` alias (existing `eval` precedent); remedy text must be runnable | **ACCEPT** — `"redteam"` script added; remedy line uses `npm run redteam -- --update-baseline`. |
| UA5 | MED | Removed-id regression line reads identically for an innocent rename and a real weakening | **ACCEPT** — rename hint appended to the removed-id line (§Gate rule 6). |
| UA6 | MED | Double failure surface (vitest + CLI): if the e2e asserts raw strings, `npm test` shows a noisy JSON blob instead of the classified table | **ACCEPT** (= SK4) — e2e failure message = same rendered report. |
| UA7 | MED | Exit 1 conflates false-block and drift with no stable machine-readable marker | **ACCEPT** — pinned `GATE_FAILURE=` stdout line (§Output contract 1), documented as stable contract separate from evolvable prose. |
| UA8 | LOW | The rigor-not-pedantry rationale lives only in ADR-0019, never reaches the person hitting the gate | **ACCEPT** — remedy line carries the one-clause ADR pointer. |
| UA9 | LOW | One-row change → two-hunk baseline diff (row + totals) may puzzle reviewers | **ACCEPT** — one-line note in ADR-0019 (lockstep movement is correct, not noise). |
| UA10 | — | GH Actions log rendering: plain-text report confirmed fine | **N/A** — probe recorded as addressed. |

## Cross-cutting designer notes

- Convergent findings (SK7=CG1, SK3=CG7, SK4=UA6, SK8=UA2, SK13=CG2,
  SK12=CG11) were resolved once each; convergence across blind reviewers is
  treated as severity-upgrading evidence.
- No reviewer challenged the two user-locked decisions; both survive intact.
- Zero findings REJECTED outright; two ACCEPT-PARTIAL (SK12/SK13-CG2), both
  narrowing scope on YAGNI grounds with the deferred half recorded in
  ADR-0019 rather than dropped silently.
