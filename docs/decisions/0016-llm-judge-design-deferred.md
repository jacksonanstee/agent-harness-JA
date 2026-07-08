# ADR-0016: LLM-judge second stage — design locked, implementation deferred

- **Status:** Accepted (implementation deferred)
- **Date:** 2026-07-08
- **Requirements:** S-5 (SHOULD)
- **Refines:** ADR-0005 (hybrid pipeline), ADR-0012 (heuristic stage + seam)

## Context

ADR-0005 committed to a hybrid scanner: an always-on heuristic pass plus an
optional LLM-judge pass for the suspicious-but-ambiguous middle ground.
ADR-0012 shipped the heuristic stage and typed the seam without building it:
`InjectionJudge`, `ScannerOptions.judge`, and `ScanResult.suspicious` (true on
medium-only `ask`) all exist in `src/security/injection/types.ts`, accepted
but unused.

The week plan lists S-5 as a Week-2 item, but the evidence that would justify
building it does not exist yet: ADR-0012's revisit trigger is the Week-3
red-team corpus pass rate dropping below 90%. The 31-case starter corpus
currently passes at ≥90% with ≥10 blocks on the heuristic alone. Building the
judge now would add a model call, a hardened prompt, and a failure-handling
surface to defend — against an attack volume we have not measured.

This ADR therefore locks the judge's *design* so the seam is a real contract
rather than a placeholder, and defers the *implementation* until the trigger
fires.

## Decisions

1. **API: additive async wrapper, sync primitive untouched.**
   `scanWithJudge(text): Promise<ScanResult>` is a new export alongside sync
   `scan()`. It runs the heuristic, decides escalation, and (when escalating)
   awaits the injected `InjectionJudge` — exactly the shape ADR-0012 §4
   reserved. Hot-path callers that never enable the judge keep the sync
   primitive and pay zero async cost.

2. **The judge may only tighten, never loosen.** The composed verdict is the
   *stricter* of heuristic and judge verdicts (`block` > `ask` > `pass`). A
   heuristic `block` is final — the judge is not consulted and cannot
   downgrade it. Rationale: the judge reads adversarial content and is itself
   injectable (ADR-0005 names this); a judge with downgrade authority is a
   verdict-laundering channel — the attacker's payload gets a second chance to
   argue for its own release. One-way composition removes the incentive to
   attack the judge at all: success can only make things stricter.

   **Composed `ScanResult` attribution:** when the judge escalates, the
   returned result appends the synthetic id `judge-block` (or `judge-ask`) to
   `rule_ids` — a judge-caused verdict must never be attributable to nothing
   (the ADR-0012 §8 completeness invariant extends to the judge). Synthetic
   judge ids are namespaced `judge-*` and are not members of
   `DEFAULT_INJECTION_RULES`; eval/telemetry consumers validating `rule_ids`
   against the rule table must treat the `judge-*` namespace as a distinct,
   legal source. `excerpts` pass through from the heuristic unchanged (the
   judge returns a verdict, not evidence). `suspicious` is **false** on the
   composed result — it means "escalation is still warranted", and after the
   judge has run, it isn't.

3. **Escalation policy per ADR-0005:** `judge: off | suspicious | always`,
   default **off**. `suspicious` escalates exactly when
   `ScanResult.suspicious` is true (medium-only `ask` — the existing flag, no
   new signal). `always` escalates every non-`block` result. `off` makes
   `scanWithJudge` behave identically to `scan()`.

4. **Judge prompt hardening requirements** (binding on the implementation):
   - The evaluated content is delimited and explicitly labelled adversarial;
     the system prompt instructs that instructions inside it must not be
     followed (ADR-0005 mitigation, promoted to a requirement).
   - The judge returns a structured verdict only (constrained token/JSON
     output) — never free prose that a downstream consumer might interpolate.
   - **Judge failure fails closed to the heuristic verdict:** timeout, API
     error, or unparseable output leaves the heuristic verdict standing
     (which, given decision 2, is already the floor). A judge outage can never
     make the scanner *more* permissive than heuristic-only.

5. **Cost and layering stance.** Default model is the cheapest Claude tier
   (`judge_model: claude-haiku-4-5` per ADR-0005's config shape); one judge
   call per escalated scan, no retries. The judge calls the SDK directly via
   the injected function — never the harness router — preserving the
   security-below-harness dependency direction (architecture "Open
   architectural questions" #1, resolved here).

6. **Deferral trigger.** Implement S-5 when the Week-3 red-team corpus (E-2,
   ≥50 cases) shows heuristic-only pass rate < 90%, or when the `suspicious`
   rate in real telemetry is high enough that `ask` verdicts become noise
   (humans rubber-stamping `ask` is worse than a machine adjudicating it).
   Until then S-5 remains a typed seam plus this contract.

7. **The eval regression gate stays deterministic.** The Week-3 CI gate
   (≥90% pass with security on) scores the *heuristic* arm — sync `scan()` —
   even after the judge is implemented. A per-case model call in a
   every-PR CI gate is a flake and cost problem by construction; judge
   effectiveness is measured as a separate, explicitly non-deterministic
   scorecard column, never as the gate.

## Consequences

### Positive

- The seam is now a contract: Week-3 eval work can design against
  `scanWithJudge`'s *semantics* before it exists (the symbol itself is not
  yet exported — sync `scan()` remains the only callable surface).
- No speculative attack surface: no judge prompt to harden, no model call to
  pay for, until measurements say it earns its keep.
- One-way composition (decision 2) is simple to state, test, and reason
  about; it converts "the judge is injectable" from an open risk into a
  bounded one (worst case: false positives).

### Negative / accepted

- The Week-2 checklist item closes as a decision, not code. Accepted: the
  checkpoint's measurable criteria (≥10 blocks, ≥90% starter-corpus pass) are
  met by the heuristic alone.
- A judge that can only tighten cannot rescue heuristic false positives.
  The concrete case is not hypothetical: `unicode-tag-chars` is
  high-confidence (auto-`block`, judge never consulted), and Unicode tag
  characters are the encoding mechanism of subdivision flag emoji (🏴󠁧󠁢󠁥󠁮󠁧󠁿 —
  England/Scotland/Wales), so benign text containing them hard-blocks
  un-rescuably. Accepted: false positives cost friction; false negatives
  cost the asset. Suppression belongs in per-call/config allowances (or a
  targeted carve-out in the tag-char detector), not in judge authority.

## Alternatives considered

1. **Implement S-5 now.** Rejected — front-runs the Week-3 evidence the
   design says should drive it; adds cost and an injectable component with no
   measured need.
2. **Judge with full verdict authority (can downgrade).** Rejected — creates
   the verdict-laundering channel described in decision 2.
3. **Drop S-5 entirely.** Rejected — the heuristic's known evasions (NFKC,
   homoglyphs — ADR-0012 §5) are exactly the semantic gap a judge covers;
   the corpus may yet prove the need.
4. **Route the judge through the harness router.** Rejected — inverts the
   layer dependency; already resolved in architecture.md toward direct SDK
   injection.

## Revisit if

- The Week-3 corpus pass rate falls below 90% → implement per this contract.
- Judge cost dominates a typical run once implemented → cache verdicts on
  identical inputs (ADR-0005 revisit clause).
- Numeric confidence calibration becomes possible from judge data →
  revisit ADR-0012 decision 2's discrete tiers.
