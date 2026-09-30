# Issue #96, PR-A: design review decision log (condensed)

*Structured design review (one designer, three sequential reviewers, one arbiter) of the PR-A design for issue #96:
implement the ADR-0016 S-5 injection judge to its locked contract and measure it through a keyed, report-only
red-team arm on the committed corpus plus a privately held-out slice. Run 2026-09-09. The full findings files and
the round-by-round log live outside the repository; this is the record the ADR condenses (ADR-0036).*

## Understanding lock

- Two PRs, measured first (maintainer, 2026-09-09). PR-A: the contract, the arm, the held-out slice, two keyed
  measurement runs, ADR-0036. PR-B: session wiring behind a settings toggle, a per-run judge-call cap, telemetry,
  the withhold decision, skills-at-load escalation, an abort path. PR-A does not close #96.
- Design D1-D8 approved in chat before the review. Two of those decisions were revised by the review and put back
  to the maintainer at sign-off (below); both revisions were accepted.

## Decisions as they stand after the review

| ID | Decision |
| --- | --- |
| D1 | `createJudgedScanner` in the security layer implements ADR-0016: modes `off` (default), `suspicious`, `always`; stricter-of composition over a verdict rank; a heuristic `block` is final; `judge-block` / `judge-ask` attribution; every judge failure (rejection, timeout under a scanner-owned 60 s timer, non-verdict value, input over 128 KiB) leaves the heuristic verdict standing; `scanWithJudge` returns the scan result plus a `judge` run state |
| D2 | Shared judge types live in security; the builder lives in the session layer and is public, because it takes an injected `query` and imports no SDK; the SDK is imported only at the CLI roots; a test pins that no security or session source file imports the SDK |
| D3 | The judge call is blind (the prompt never carries the heuristic verdict; pinned by invariance), isolated (the SDK's six isolation keys: no settings layers, no MCP config, no built-in tools, no discovered skills, a bare system prompt, no persisted transcript), de-fanged (one turn, deny-all pre-tool hook), hardened (per-call nonce delimiters, adversarial-data instruction, JSON-only reply in three literal shapes), parsed closed (byte cap, ajv, enum membership). No category on the wire |
| D4 | `redteam --judge [--judge-model <id>] [--holdout <path>]`: every refusal the judge arm adds (the flag parse, the held-out slice) before the key is demanded; the heuristic gate runs first and unchanged and alone decides the exit code, except that `JUDGE_ARM=skipped` (after an infrastructure exit) and `JUDGE_ARM=failed` exit 2; one progress line per call; early stop after three consecutive failures with nothing judged; remedy lines beside `partial` and `failed`; both machine-readable lines at column 0; a separate scorecard with its own envelope, never compared to the baseline |
| D5 | The held-out slice is a private JSON file outside the repository, loaded as hostile input (guarded read, exact schema, byte cap on text, case cap of 100, benign implies `pass`, malicious implies not `pass`, no id collision with the corpus) and checked against the live scanner at load (every malicious case a heuristic `pass`, every benign case non-block). Authored behind a wall with three freeze rules: the slice is hashed before the prompt exists; the prompt is hashed before the first keyed run; any later prompt change is reported as post-hoc tuning |
| D6 | The arm drives the real judged scanner with a recording judge and derives both modes from one call per case; the structural/contextual split is derived (judge-only catches from a heuristic `pass` versus confirmed catches from a heuristic `ask`), totalled by the case's own category |
| D7 | Two keyed runs (the default haiku tier and a sonnet tier) over corpus plus holdout; the ADR claims only what both slices show; precondition 2 of the evaluation methodology is met through its calibration-set branch (the labelled, blind-authored holdout), with the two-tier agreement recorded as a consistency reading, not the quorum |
| D8 | ADR-0036 records the contract's implementation, the cost policy, the false-positive gate PR-B must meet before wiring (zero judge-caused false-blocks on both benign slices at `always`, read from a named field, re-measured if PR-B's prompt, model or query keys differ), the accepted negatives, and the freeze evidence (holdout hash and id table, prompt hash) |

## Review passes

| Pass | Findings | Accepted | Headline changes |
| --- | --- | --- | --- |
| Skeptic | 28 (1 high, 12 medium, 15 low) plus 14 silent assumptions and 8 YAGNI items | 26 in full, 2 in part | judge types moved below both consumers (eval cannot import cli, even a type); bare-verdict wire with a derived split; holdout loads before the heuristic arm; freeze rules; deps seam on the command; the `off` equivalence pin moved to the eval layer; timeout-orphan and size-evasion residuals recorded |
| Constraint Guardian | 10 (1 high, 3 medium, 6 low; 0 reject) plus 16 unstated limits | 10 | one isolation key became six (settings, MCP, tools, skills, system prompt, transcript persistence), each a structural mirror with a parity pin; holdout case cap; docs-gate skip region narrowed; model override validated; SDK import behind the seam; write-failure state |
| User Advocate | 21 (2 high, 11 medium, 8 low) plus 23 message items | 21 | progress line and early stop; consumer-facing doc comments; run state on the scan result; the builder made public so the package ships the hardened judge; column-0 machine lines (a pre-existing defect); remedy lines; holdout rules enforced at load with named messages |
| Arbiter | round 1: REVISE, 12 fixes (parity between sections rewritten at different times; ADR-0023's barrel rule applied evenly; both revised approvals flagged in the spec; the log brought current); round 2: REVISE, 1 fix; round 3: APPROVED | | |

The two acceptances in part: the issue's "structural versus contextual" label was replaced by a derived split
because a blind judge cannot say what a regex could have caught and the rule families are groupings, not an attack
taxonomy; the methodology's multi-model quorum is recorded as a same-provider consistency reading because v1 targets
one provider (ADR-0003), with its calibration-set branch met instead.

## Sign-off

The maintainer accepted both revisions to approved decisions on 2026-09-09: the builder in the session layer and on
the root barrel; no category on the wire. The reviewed spec is the build contract.

## Residual risk named for the ADR

The measurement is a same-family reading twice over: the held-out slice is authored by a Claude subagent and scored
by two Claude tiers, so a clean number is evidence of consistency and of detection against blind labels, not of
independence from the judge's training. The six isolation keys, whether installed plugins load under an empty
settings-source list, and the billing of a timed-out call whose subprocess is later terminated are verified on
typings only until the first keyed run.
