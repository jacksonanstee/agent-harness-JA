# E-4 design decision log — 2026-07-12

Process: user locked mode/target → designer proposed options A/B/C → 3 blind
reviewers (skeptic + constraint-guardian = Fable, user-advocate = Sonnet) →
designer revision (A-minimal) → arbiter ruling. Disposition: **APPROVED
(A-minimal), 6 binding conditions; B REJECTED; C fallback-only.**

## User-locked (pre-panel)

| # | Decision | Rationale |
|---|---|---|
| U1 | Offline eval only | Runtime guardrail doubles per-turn cost/latency and touches the session core; requirement's OR resolved to eval side |
| U2 | Golden outputs, report-only | Oracle authority stays deterministic (ADR-0016 tighten-only analog); LLM findings never flip verdicts |
| U3 | Option A (→ A-minimal post-panel) | See dispositions below |

## Objection dispositions (arbiter)

| # | Source | Objection | Disposition |
|---|---|---|---|
| 1 | Skeptic CRIT | Prose findings downgrade E-1's structural no-raw-output allowlist to procedural sanitization | RESOLVED by construction: findings are closed enums; no adversary prose persisted or printed anywhere. Binding: adversary response parsed against exact ajv allowlist (condition 1) |
| 2 | Skeptic HIGH | Findings un-investigatable (nothing persisted, runs nondeterministic); A-vs-B framing loaded | ACCEPTED as recorded limitation, verbatim in ADR. B's remedy died on its own CRITICAL (#12) |
| 3 | Skeptic HIGH | "Different tier via router" unimplementable — route() has no exclusion channel (verified) | RESOLVED: dropped; fixed review-shaped descriptor; overlap recorded via section-level adversaryModelId |
| 4 | Skeptic HIGH | A = unmeasured judge contrary to ADR-0016 deferral doctrine; C dismissed in one clause | SPLIT: doctrine-violation REJECTED (S-5 judge had verdict authority + an unfired build trigger; E-4 has zero authority + a standing SHOULD with a named acceptance test). Unmeasured-quality residue ACCEPTED as limitation. C given honest standing as dated fallback |
| 5 | Skeptic HIGH | Model-call channel unspecified; session pollutes memory/telemetry; bare fn drags full d4 hardening | RESOLVED: bare injected AdversaryFn, no session; d4 hardening embraced as binding, not avoided |
| 6 | Skeptic MED | Report-only = "a sentence, not a property" without machine-boundary pins | RESOLVED + condition 2: differential invariance test (rows/totals/exit identical ± verifier) makes it suite-enforced |
| 7 | Skeptic MED | Optional redactSecrets violates ADR-0017's fired revisit-if M1 | RESOLVED: required dep; egress path is a stronger trigger than M1's letter |
| 8 | Skeptic MED | Which rows does the adversary challenge? | RESOLVED: oracle-pass rows only (the only info-add over self-report oracles); oracle-fail-unchallenged recorded as scope limit |
| 9 | Skeptic MED | Cost understatement risk vs totals doctrine | RESOLVED + condition 4: totalCostUsd + unpricedChallenges mirror the never-understated pattern |
| 10 | Skeptic MED | Schedule realism (MUST-grade surface for a SHOULD; week ends 07-19) | MANAGED + condition 5: shrunk scope + C fallback with trigger EOD 2026-07-16 |
| 11 | Skeptic MED | Golden-only type scoping must be binding | RESOLVED: section on GoldenScorecard only; ADR-0019 d4 scalar-row contract independently forbids row-level findings |
| 12 | Constraint CRIT | B persists raw output → reverses ADR-0017 d6 + ADR-0013; run-dir = new hostile-input surface | ACCEPTED: **B rejected** |
| 13 | Constraint | 6 approval conditions on A (same-provider pin, d4 binding, redact request payload, fail-open + exit untouched, separate volatile section, cli wiring placement) | ALL FOLDED into A-minimal. Correction of record: router use is layer-LEGAL for the eval-layer verifier (ADR-0016 d5 protects the security-below-harness seam only) |
| 14 | Constraint | C's acceptance clause has no exercised path (green-without-running) | ACCEPTED → condition 5: C ships only with a recorded requirements-row deviation (ADR-0019 d2 precedent) |
| 15 | Advocate CRIT | Adversary-call failure must never destroy the oracle scorecard or exit code | RESOLVED: per-row verifier-error, fail-open, one call no retries; "adversary failure can never alter the authoritative result" is the single formulation both ADRs share |
| 16 | Advocate HIGH | Bare disagree-flags are noise; findings need structure | RESOLVED at the floor: {status, category} enums. Recorded trade: prose richness sacrificed to #1, which outranks it; per-finding = pointer-to-re-run, value lives in the aggregate rate |
| 17 | Advocate HIGH | Cost split + pre-spend warning | RESOLVED with precision fix: warning fires at the oracle→adversary phase boundary (pass-row count knowable only then) |
| 18 | Advocate HIGH/MED | Discoverability (USAGE/README); --verify name overloaded; not-run vs nothing-challenged ambiguity | RESOLVED: flag = --challenge; USAGE + README updated; tri-state section (absent / zero-challenge / findings) |
| 19 | Advocate LOW | C invisible to portfolio audience | ACCEPTED: supports A>C ordering; a well-written deferral ADR remains the fallback's portfolio story |

## Arbiter's internal-consistency findings (folded)

| # | Finding | Resolution |
|---|---|---|
| I1 | Enum-only vs decorative pull in opposite directions | Value claim relocated to the aggregate (reported metric, named consumer); ADR must not oversell per-finding diagnostics |
| I2 | Category enum designed before any observed challenge | `other` bucket allowed; parse-time widening forbidden (condition 3); revisit-if keyed to live data |
| I3 | Shrunk scope bounds the estimate, not the tail | C fallback trigger date EOD 2026-07-16 (condition 5) |
| I4 | "Fail-open" vs ADR-0016 "fails closed" wording | Single formulation adopted; equivalence stated in ADR-0020 |
| I5 | Per-finding adversaryModelId implies multi-adversary | Cut; section-level only |
| I6 | Self-reported confidence has no calibration story | `confidence` dropped for v1 (condition 6); revisit-if recorded |

## Binding conditions of approval

1. Verification section validated against an exact ajv field allowlist (structural, ADR-0017-d6-style) — *reconciled reading (R2-4): the allowlist binds the adversary WIRE RESPONSE, the untrusted input; the constructed section needs no load-time validator (nothing re-reads golden scorecards) — its shape is TS-constructed and pinned by the differential test*
2. Report-only proven by a CI-safe differential invariance test
3. Unknown enum from the adversary = per-row verifier-error, never parse-time widening
4. Adversary cost mirrors the never-understated totals pattern — *field names as shipped: `verification.totalCostUsd` + `unpricedChallenges` (verifier-error counts as unpriced; no-output counts in neither)*
5. C fallback trigger EOD 2026-07-16, with requirements-row deviation if invoked
6. `confidence` dropped (or explicitly uncalibrated with revisit-if) — dropped

## Round 2 — spec-level review (same panel roles, blind, on the committed spec text)

Settled architecture unchallenged by all three reviewers. All findings were spec-precision gaps; all folded into the spec same-day.

| # | Source | Finding | Resolution (spec §) |
|---|---|---|---|
| R2-1 | Skeptic CRIT / Constraint F-3 | Loop-shape contradiction: per-row challenge vs phase-boundary warning | TWO-PHASE pinned (all oracles, then challenges); retention, timing, crash semantics stated (§Runner integration) |
| R2-2 | All three | AdversaryFn call channel unresolvable (only channel is agentic query(); bare = ungated tool-capable turn) | Pinned: wrap query() sans session, de-fanged by maxTurns:1 + deny-all PreToolUse hook (typed today); cost from total_cost_usd; allowedTools additive if plan verifies it (§Adversary model) |
| R2-3 | Skeptic 3 / Constraint F-4 | Pass rows with resultText:null unhandled (gating-behavior tasks) | New status 'no-output': finding recorded, no call, cardinality holds (§Verifier contract, §Runner integration) |
| R2-4 | Skeptic 5 / Constraint F-7 | Condition-1 artifact mismatch (wire response vs section) | Reconciled: condition 1 discharged at wire-response parse; section needs no load-time validator (nothing re-reads golden scorecards); TS construction + differential test pin the shape |
| R2-5 | Constraint F-1 | Delimiting waved at; fixed delimiters invite breakout | Per-call random nonce boundary tokens (crypto.randomBytes) + origin labels (§Prompt hardening) |
| R2-6 | Skeptic 2 | adversaryModelId unpopulatable through specced interfaces | Verifier gains adversaryModelId member; createVerifier deps carry it |
| R2-7 | Skeptic 6 | Wire-format undefined cells (challenge w/o category; agree w/ category) | Two-branch oneOf: agree forbids category, challenge requires it; wrong combos = unparseable |
| R2-8 | Skeptic 7 / Constraint F-8 | "Timeout" named but no mechanism/owner | Verifier-owned 60s race → call-failed; orphan discarded; may still bill → counts unpriced; hang surface recorded as limitation |
| R2-9 | Skeptic 8 | Invariance test "identical" ambiguous (clock, meta, timing) | Injected clock + fake sessions required; deep-equal field identity on rows/totals + exit; two-phase makes row timing verifier-independent |
| R2-10 | Skeptic 9 / Advocate 5 | Named consumer (eval-methodology.md) doesn't exist | ADR-0020 = interim metric consumer; eval-methodology (next week item) must carry metric + synthetic rendered example |
| R2-11 | Skeptic 10 / Advocate 2 | Tri-state hides fourth state (zero eligible rows) | Four states pinned with rendered copy; counts always related to totals.passed; N=0 warning variant |
| R2-12 | Skeptic 11 | Envelope widening is the natural-but-forbidden implementation | Intersection type pinned in the spec's own code block |
| R2-13 | Skeptic 12 | redactSecrets migration surface understated | ~15 test call sites named; cleanForScorecard param deliberately stays optional (redteam), stated |
| R2-14 | Skeptic 13 | unpricedChallenges conflates unpriced with no-spend | Pinned: verifier-error counts as unpriced (unknown ≠ zero); no-output counts in neither |
| R2-15 | Skeptic 14 | "Solely oracle-derived" exit wording false today | Fixed: "unchanged — totals.failed===0 as today"; verification never contributes |
| R2-16 | Constraint F-5 | Redaction failure on egress path unspecified | errorKind gains 'redaction-failed'; no call made; nothing egresses |
| R2-17 | Constraint F-6 | No response size bound; parse order unstated | 128 KiB cap pre-parse; trim-only; parse→validate→read pinned; fenced JSON = unparseable |
| R2-18 | Constraint F-9 / Advocate 6 | "Pure-move" extraction inaccurate (shared helpers, ESM cycle) | Honestly scoped: helpers relocate to cli/shared.ts same commit; cli.ts keeps dispatch + run/telemetry |
| R2-19 | Constraint F-10 | Headline cost line would understate on --challenge runs | Rendered challenge-cost line required (condition 4 at presentation layer) |
| R2-20 | Constraint F-11 | Redaction responsibility stated 3 ways | One sentence: runner redacts resultText; taskPrompt deliberately unredacted (repo-committed), said aloud |
| R2-21 | Advocate 1 | Rendered section never shown | Concrete markdown example pinned in §Scorecard shape |
| R2-22 | Advocate 3 | "Pointer to re-run" has no re-run command | Reworded to prompt-to-re-examine; no single-task selector recorded as limitation |
| R2-23 | Advocate 4 | Challenge phase silent (hang perception) | Per-challenge onProgress lines pinned |
