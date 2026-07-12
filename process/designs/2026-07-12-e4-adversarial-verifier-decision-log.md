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

1. Verification section validated against an exact ajv field allowlist (structural, ADR-0017-d6-style)
2. Report-only proven by a CI-safe differential invariance test
3. Unknown enum from the adversary = per-row verifier-error, never parse-time widening
4. Adversary cost mirrors totalCostUsd/unpricedTasks (never silently understated)
5. C fallback trigger EOD 2026-07-16, with requirements-row deviation if invoked
6. `confidence` dropped (or explicitly uncalibrated with revisit-if) — dropped
