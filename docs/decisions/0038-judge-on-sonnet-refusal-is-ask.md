# ADR-0038: the S-5 judge runs on claude-sonnet-5, and a provider refusal is the judge's `ask`

- **Status:** Accepted. Ships in the #148 PR, which closes #148.
- **Date:** 2026-10-07
- **Requirements:** S-5 (SHOULD: hybrid heuristic plus LLM judge, optional, off by default).
- **Supersedes:** ADR-0016 decision 5's model clause ("the cheapest Claude tier, `claude-haiku-4-5`"). **Amends:** ADR-0016 decision 4 (a provider refusal now tightens rather than leaving the heuristic verdict standing), ADR-0036 D3 (the default model) and D8 (the gate is read over repeated samples).
- **Relates to:** ADR-0025 (the refusal signals, now read through one shared detector), ADR-0036 (the measured judge; its D8 #148 notes carry the figures), ADR-0037 (the wired judge; R6, the `judge-call` row), issue #145 (B2, which reads the rows).

## Context

Wiring the judge (ADR-0037) and accepting haiku's fenced replies (issue #147) showed that the haiku judge fails ADR-0036 D8's zero false-block gate: three judge-caused false-blocks on 07/10/2026, where the 02/10 pass had been one sample of a non-deterministic judge. Issue #148 asked for a precision fix measured over repeated samples. Part 1 shipped the instrument, `redteam --judge --samples <n>` and its `JUDGE_GATE=` line (ADR-0036 D8's first #148 note). Part 2 fixed a decision rule before any sampled measurement (`tasks/issue-148-plan.md`): a configuration qualifies when, over five samples of the corpus and the held-out slice, the gate reads `pass` (no judge-caused false-block, a pooled false-flag rate of at most 10%, every call judged) and the worst sample detects 41 of 41 corpus and at least 11 of 12 held-out cases; among qualifiers prefer no change to the composition rule, then the lower cost.

No candidate qualified. Haiku made 7 false-blocks. Haiku with a judge `block` over a heuristic `pass` read as `ask` made none, but a 14.2% false-flag rate. `claude-sonnet-5` made no false-blocks and 3 of 120 false-flags at a lower measured cost per call, but read `incomplete`: the provider's usage-policy filter refused corpus case `eb-01` on every call, the SDK threw, and the judge recorded `call-failed`. A `call-failed` also counts toward R6's early stop, so any text that trips the provider's filter could switch the judge off for the run before anything was judged.

## Decision

1. **The judge's model is `claude-sonnet-5`** (`JUDGE_MODEL`, `src/session/judge.ts`). The session still takes no model setting; `redteam --judge-model` still overrides it for a measurement. The money ceiling follows the list price: `JUDGE_WORST_CASE_USD_PER_CALL` is 0.3072 from USD 2 and 10 per million input and output tokens, read on 07/10/2026; the measured typical figure is about USD 0.0026 per call.
2. **A provider refusal is the judge's `ask`.** The signals are ADR-0025's two channels, now one detector shared with the session (`src/session/sdk-refusal.ts`): a `model_refusal_*` banner, or a result whose cleaned `stop_reason` is `refusal`. Both arrive on the SDK stream; the model's reply text arrives only in `result.result` and cannot forge them. `buildJudge` reads them before the SDK's throw. A refusal tightens to at least `ask`, never counts toward R6, and counts as answered for the gate. A parseable verdict beside the signal is kept when stricter, so a refusal never reads below what the model said. A fallback banner counts as a refusal too: another, unmeasured model answered.
3. **ADR-0036 D8's gate is read over repeated samples** with `--samples <n>`; the #148 measurement used N = 5.

## Consequences

- The re-measure from this change (`redteam --judge --holdout <path> --samples 5`, default model) reads `JUDGE_GATE=pass`: 270 of 270 calls judged, no false-blocks, no false-flags in 120 benign judgements, 41 of 41 and 12 of 12 detected in every sample, `eb-01` read as `ask` in all five, USD 0.6914 (ADR-0036 D8's #148 notes).
- Latency falls to about 3 s per judged result (2.9 to 3.2 s per call from the scorecard stamps of the five pre-change sonnet runs, 2.9 to 3.1 s in the five post-change runs); the start line says so.
- The worst-case ceiling per call doubles with the list price even though the typical cost falls.
- **Observability, accepted for now:** a refusal's `judge-call` row reads `judged`, verdict `ask`, and its summary and live lines are those of a judged `ask`, so telemetry does not tell a provider refusal from a judgement, and `api_refusal_category` is not recorded. B2 (#145) decides withholding from these rows, so a distinct `refused` state, rule id and telemetry mirror is a precondition for B2's analysis (#152).
- The prompt and the parser are unchanged; the held-out slice was used only to measure, not to tune.

## Alternatives considered

- **Keep haiku and revise the prompt.** Post-holdout tuning under ADR-0036 freeze 3: the held-out slice would need re-authoring behind a wall before any measurement meant anything.
- **Keep haiku and read a judge `block` over a heuristic `pass` as `ask`.** Measured: within the false-block rule but over the false-flag bound.
- **A `refused` judge state now.** The cleaner end state, but it threads a new state through security, the session fold, telemetry (a migration) and the redteam arm; deferred to the follow-up so the precision fix ships first.
- **Sonnet with refusals left as `call-failed`.** Leaves the attacker-triggerable early stop and a gate that can never read complete on the corpus.

## Revisit if

- The `refused` state lands (#152): refusals become distinguishable in rows and the summary.
- A cheaper model is measured that passes the same repeated-sample rule.
- The provider changes how a refusal is signalled to the SDK.
