# E-2 Design — Decision Log

## Skeptic round (findings folded)

**S1 (CRITICAL) — ≥90% CI gate disarms the ADR-0016 S-5 trigger it measures.**
ACCEPTED. The same number can't be both the measurement that decides whether to build the LLM judge AND a merge-blocking gate (an honest corpus of real attacks the 15-regex scanner misses would strand the PR until curated back to green). RESOLUTION: separate measurement from gating.
- The per-PR CI **gate** enforces only hard invariants: **zero benign FALSE-BLOCKS** and **no regression vs baseline** (the latter is E-3's job; E-2 ships the diffable artifact + the 0-false-block check).
- Detection rate and the on-arm/off-arm differential are **reported metrics** written into the scorecard, feeding ADR-0016's S-5 trigger — never a merge blocker.
- The ≥90%/<50% figures become a **milestone checkpoint assertion** (a single documenting test of current state), not a per-PR gate.

**S2 (HIGH) — `RuleFamily` can't express indirect-injection/jailbreak (week-plan-mandated).**
ACCEPTED. RESOLUTION: the eval corpus case gets its own `category` field (eval taxonomy: `direct | indirect | jailbreak | exfil | benign`) DISTINCT from the scanner's `RuleFamily`. Never widen `RuleFamily` (same cross-contamination the FailureKind refactor avoids). Starter cases are wrapped with a category mapping.

**S3 (HIGH) — dual pass-semantics; gated number absent from the artifact; exit-0-with-FAIL-rows inverts eval's precedent.**
ACCEPTED. RESOLUTION: single detection-based semantics (see S4). The gated quantities (benign-block count, detection rate, off-arm rate) are **explicit fields in the canonical scorecard**, so E-3 diffs exactly what CI gates. Exit code reflects the GATE outcome; the difference from eval's row-based exit is documented in ADR-0018.

**S4 (HIGH) — exact-verdict-match freezes rule-confidence topology; a medium→high rule promotion flips rows to false regressions.**
ACCEPTED — and it reverts my stricter-than-starter deviation. RESOLUTION: adopt the starter corpus's existing semantics.
- Malicious case **passes if verdict ∈ {block, ask}** (detection); block-vs-ask recorded as a strength metric, not a pass/fail driver.
- Benign case **passes if verdict == pass**; `ask` = soft flag (tolerated), `block` = hard fail.
- This kills `downgraded`/`overblocked` as failure kinds. New failure-kind union: **`missed`** (malicious → pass), **`false-flag`** (benign → ask), **`false-block`** (benign → block).
- Recalibration policy (ADR-0018): editing an `expectedVerdict`/category is legitimate ONLY when a deliberate rule-confidence change motivates it, recorded in the same commit; otherwise a verdict flip is a finding, not a corpus edit.

**S5 (MEDIUM) — off-arm <50% is a tautology (= benign fraction) and goes red when benign cases grow.**
ACCEPTED. RESOLUTION: off-arm is not gated. Detection is computed over **malicious cases only** (benign fraction can't distort it). Reported differential = on-arm malicious detection − off-arm malicious detection (off-arm null scanner detects 0, so the delta is just on-arm detection — reported for the portfolio claim, not gated).

**S6 (MEDIUM) — `false-positive` conflates benign→ask and benign→block; gate not recomputable from the diffable partition.**
ACCEPTED. RESOLVED by S4's split into `false-flag` vs `false-block`. The gate reads `false-block` count directly from the row partition E-3 diffs.

**S7 (MEDIUM) — the "pure refactor, golden tests unmodified" proof understates scope: ScorecardMeta.taskDir/models are golden-shaped, toMarkdown hardcodes the title + cost/turns columns.**
ACCEPTED. RESOLUTION: share only the **producer-agnostic core** — row type, totals partition, canonical JSON. **Each producer owns its own markdown renderer and its own meta shape.** `ScorecardMeta` splits: universal (`createdAt`, `harnessVersion`, `schemaVersion`) stays shared; `taskDir`/`models` become golden's meta; redteam's meta carries `corpusSize`, `armLabel`, thresholds. Golden's renderer/tests stay as-is (genuinely unmodified); redteam gets a thin renderer with its own columns (no cost/turns wall of n/a).

**S8 (LOW) — `cli redteam` would hit the global API-key guard; keyless CI fails misleadingly.**
ACCEPTED. Dispatch `redteam` BEFORE the `ANTHROPIC_API_KEY` guard, exactly like `telemetry-export`.

**S9 (LOW) — runtime kind list not bound to type param K; a drift silently undercounts.**
ACCEPTED. Derive `K` from a single `as const` tuple per producer (`type FailureKind = typeof REDTEAM_FAILURE_KINDS[number]`) so array and type can't drift; totals built from that tuple.

**S10 (LOW) — one case ≈ 2.2%; incentive to add only already-caught cases.**
RESOLVED by S1: `missed` rows are reported, not gated, so honest misses can land without stranding the PR.

**Verified-clean (no action):** eval→security import is layering-legal and STARTER_CORPUS is already barrel-exported; scan() is cross-version deterministic; workflow builds dist/ before the step.

## User Advocate round (findings folded)

**UA1 (HIGH) — exit 0 above a table of literal "FAIL"/`missed` rows is self-contradicting.**
ACCEPTED. RESOLUTION: redteam's own renderer does NOT reuse golden's `pass?'pass':'FAIL'` labeling. Malicious rows render outcome as `detected`/`MISSED`; benign rows as `ok`/`flagged`/`BLOCKED`. The gate-relevant failure (`false-block`) is the only one rendered in an alarming style. A `missed` row reads as a measurement, not a build failure.

**UA2 (HIGH) — a "documenting" milestone test that hardcodes today's detection rate silently re-becomes the per-PR gate S1 removed.**
ACCEPTED — this is the sharpest UA catch. RESOLUTION: there is NO hardcoded detection-rate assertion in the blocking test suite. The only tests that gate are: (a) `falseBlockCount === 0`, (b) corpus size ≥50, (c) every case's expected verdict is internally consistent. Detection rate is asserted only by a NON-blocking check that prints the number (and, if desired later, a `>= floor` far below the S-5 trigger, e.g. the ≥50% "security does real work" sanity floor — never the ≥90% S-5 number). The ≥90% figure lives in ADR-0018 prose as the measured-at-design-time value, not as a CI assertion.

**UA3 (HIGH) — no in-band legend marking which failure kind is gate-load-bearing.**
ACCEPTED. RESOLUTION: the markdown summary states the gate rule explicitly (`Gate: PASS — false-blocks: 0`) and the renderer marks `false-block` rows distinctly. A reader sees which rows gate without reading ADR-0018.

**UA4 (MEDIUM) — redteam markdown must lead with a gate-first summary (golden's totals-first convention).**
ACCEPTED. RESOLUTION: redteam renderer leads with: `Gate: PASS/FAIL`, false-block count, detection (N/M malicious + %), off-arm baseline (labeled guaranteed-zero), corpus size — THEN the table. Inherits golden's totals-first house style.

**UA5 (HIGH) — ADR-0018 must LEAD with the circularity argument + state the measured detection rate, or it reads as "lowered the bar to pass".**
ACCEPTED — critical for the portfolio purpose. RESOLUTION: ADR-0018 opens with the gate-vs-S-5-trigger circularity argument (a CI gate and an S-5 trigger can't share a threshold without incentivizing corpus-gaming), then states the actual measured detection rate at design time. If that number is ≥90%, say so plainly — it defuses the "dodging a hard bar" read immediately. Framing is locked, not left to the writer.

**UA6 (MEDIUM) — two taxonomies (`family` vs `category`) on one case object is a contributor trap (overlapping `exfil`/`benign` vocab).**
ACCEPTED. RESOLUTION: the eval corpus does NOT carry both fields loosely. Starter cases are wrapped by a single explicit mapping table (family → category) in one place, reviewed once; new cases set ONLY `category` (the eval taxonomy), and the scanner's `family` is not a field on the eval case at all — it stays in the security layer. One taxonomy at the eval authoring surface.

**UA7 (MEDIUM) — no in-band breadcrumb from "a row's verdict changed" to E-3's diff tool.**
ACCEPTED (light). RESOLUTION: redteam markdown footer names the E-3 baseline-diff command as where verdict deltas surface. Low-cost; avoids a contributor hunting.

**UA8 (MEDIUM) — block→ask softening of malicious cases is gate-invisible; could erode silently.**
ACCEPTED. RESOLUTION: the summary surfaces a `strength` line (`blocked: X · flagged-only(ask): Y` over malicious cases) prominently, so a drift from block→ask is visible to a human even though it doesn't gate. E-3 will diff it; E-2 makes it legible now.

**UA9 (LOW-MED) — off-arm 0% differential reads as padding unless labeled guaranteed-zero.**
ACCEPTED. RESOLUTION: labeled explicitly as a null-scanner baseline (ablation control), not a measurement, in both the summary and ADR-0018.

**UA10 (LOW) — detection rate needs raw N/M counts, not a bare %.**
ACCEPTED. RESOLUTION: render `46/50 (92%)` everywhere, given ~2.2%/case sensitivity.

**UA11 (LOW) — `cli redteam` missing from the USAGE string.**
ACCEPTED. RESOLUTION: add `redteam` to `src/cli.ts` USAGE + help text.

## Constraint Guardian round (findings folded)

**CG1 (HIGH) — new attack-payload cases trip the operator's own `secret-scan.sh --staged` commit hook + GitHub push protection (the S-2 precedent).**
ACCEPTED. RESOLUTION: ADR-0018 documents a defang convention for corpus payload text — credential-shaped literals assembled from fragments (as S-2 fixtures do: `'AKIA'+'IOSF…'`), assignment shapes (`token=…`, `api_key: …`) avoided or split, exfil URLs use non-resolving `.example`/`.invalid` domains. The corpus module carries a header comment stating the convention so the first contributor doesn't get a blocked commit.

**CG2 (HIGH) — redteam scorecard could carry LIVE exfil markup (image beacons) into the committed baseline + GitHub-rendered markdown.**
ACCEPTED — strongest new finding. RESOLUTION (collapses CG2+CG6+CG8): **redteam rows carry NO payload text and NO scan excerpts.** A row is `{id, category, verdict, expected, failureKind, reason}` where `reason` is a fixed enumerated explanation (`"expected block, scanner returned pass"`), never case text. Payloads live ONLY in the corpus source (defanged per CG1). The scorecard is about outcomes, not payloads — so nothing adversarial reaches the rendered table, the committed JSON, or a viewer's browser. As a consequence redteam rows are NOT run through `redact()` (they contain no free text), which also resolves CG8.

**CG3 (HIGH) — milestone documenting assertion is a per-PR blocker by construction.**
DUPLICATE of UA2 — already resolved (no hardcoded detection-rate assertion in the blocking suite).

**CG4 (MEDIUM) — the generic-core split is under-specified: `volatile` + cost fields in totals are golden-shaped too.**
ACCEPTED — tightens S7. RESOLUTION: the SHARED core row is minimal — `ScorecardRow<K> = {id, outcome, failureKind: K | null}`. Producers EXTEND it: golden adds `volatile` (cost/turns), redteam adds `category`/`verdict`/`expected`. The shared totals partition is `byFailureKind` + pass/fail counts only; golden's cost totals live in golden's own totals type. Share the minimal diffable core; each producer extends.

**CG5 (MEDIUM) — one `schemaVersion` governs two divergent schemas with no producer discriminator.**
ACCEPTED. RESOLUTION: add a `producer: 'golden' | 'redteam'` discriminator field to the canonical scorecard; E-3 and any consumer branch on it. `schemaVersion` is interpreted per-producer.

**CG6 (MEDIUM) — two-renderer drift on cell-sanitization (`escapeCell`), for the adversarial-by-design producer.**
ACCEPTED. RESOLUTION: hoist `escapeCell` into shared `scorecard/sanitize.ts` beside `truncateWellFormed` so both renderers share one escaping impl (defense in depth even though CG2 means redteam renders no payload text).

**CG7 (MEDIUM) — recalibration policy has no adjudicator / no mechanical enforcement (DEC-0016 tension).**
ACCEPTED. RESOLUTION: a NON-gating diagnostic test re-derives each case's current `scan()` verdict and prints any drift from `expectedVerdict` (re-derivation satisfies DEC-0016's spirit; non-gating because drift can be legitimate). ADR-0018 names the maintainer as adjudicator and states the policy is convention-backed-by-diagnostic, accepting the residual drift risk in writing.

**CG8 (MEDIUM) — redteam `reason` coupled to the S-2 redaction table.**
RESOLVED by CG2 (reason carries no payload; redteam rows not redacted).

**CG9 (LOW) — factual: `scan()` has NO runtime time budget; ADR-0018 must not describe one.**
ACCEPTED. ADR-0018 states scan() is pure sync regex, no runtime budget; the only timing guard is the existing test-time ReDoS assertion. E-2 adds no corpus-scale timing assertions.

**CG10 (LOW) — `RedTeamCase` type-name collision across layers (security barrel already exports one).**
ACCEPTED. RESOLUTION: the eval type is named `CorpusCase`, not `RedTeamCase`, to avoid wrong auto-imports in the eval layer.

**CG11 (LOW) — `offArmDetectionRate` is constant-zero dead weight in the diffed baseline; no-regression clause is E-3 vaporware at E-2 ship.**
ACCEPTED. RESOLUTION: off-arm is computed at render time and labeled a null-scanner baseline in markdown; it is NOT a stored field in the diffed JSON. ADR-0018 states plainly that at E-2 ship the effective gate is `falseBlockCount === 0` alone (the no-regression clause activates when E-3 lands).

**Verified-clean (guardian):** eval→security import direction legal; keyless dispatch precedent (`telemetry-export`); `as const`→K derivation robust; two-arm 50-case run is negligible CI cost and deterministic.

## Arbiter / Integrator — final disposition

All three reviewers invoked; all objections resolved or explicitly folded; no reviewer objection rejected; no inter-reviewer conflict (complementary dimensions). The two user-locked decisions (scanner-only scope, `cli redteam` subcommand) are preserved intact by every resolution.

Material design changes from review (net): (1) gate ≠ measurement — CI gates `falseBlockCount===0` (+ E-3 no-regression later); detection rate is reported, feeding ADR-0016 S-5. (2) detection-based semantics (block-or-ask), reverting the over-strict exact-match. (3) failure kinds = `missed`/`false-flag`/`false-block`. (4) **redteam rows carry no payload text/excerpts** — outcomes only; not redacted; nothing adversarial reaches committed/rendered artifacts. (5) shared minimal core row + per-producer extension/renderer/meta; `producer` discriminator. (6) eval type named `CorpusCase`; defang convention for payloads; non-gating drift diagnostic. (7) ADR-0018 leads with the gate-vs-S-5 circularity argument and states the measured detection rate.

**DISPOSITION: APPROVED** (revisions folded into the design). Proceed to spec doc → user review → writing-plans.

## External adversarial round — Gemini 2.5 Flash (2026-07-10)

Ran the review-validated spec + decision log through the Gemini API (multi-model verification workflow; 2.5-pro and 3-pro quota-blocked, so 2.5-flash — a weaker reviewer). Two findings folded, rest were known tradeoffs.

**G1 (folded) — the row `id` is an un-guarded author-controlled field reaching the rendered/committed artifact.**
ACCEPTED. The "rows carry no payloads" resolution (CG2) missed that `id` is on the row and is free text. A corpus id like `x-![beacon](https://evil/collect)` reproduces the image-beacon exfil CG2 closed — the exact E-1 bidi-in-row-id class. RESOLUTION: corpus ids pattern-pinned to `^[a-z0-9][a-z0-9-]{0,63}$` at validation time AND run through shared `escapeCell` at render (double-guard). Added to spec + testing.

**G2 (folded) — block→ask softening is CI-invisible in the E-2 ship window (before E-3's no-regression clause).**
ACCEPTED as an explicit documented limitation (sharpens CG11). RESOLUTION: ADR-0018 names the window as a known time-boxed weakness; interim defense = the prominent strength line; S-5 decision reads the strength split, not detection alone. No new gate (a strength gate needs a baseline = E-3's job).

**Not folded (known/accepted):** detection-counts-`ask` possibly flattering S-5 (mitigated by G2's strength-split note); corpus size 50 overfit risk (reinforces the open size question to Jackson); defang reduces realism (accepted safety cost); §3 scorecard boundary — Gemini explicitly validated it as correct.
