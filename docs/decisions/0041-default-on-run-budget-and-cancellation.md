# ADR-0041: every session runs under a default-on dollar ceiling and can be cancelled; the SDK's throw after an error result ends the run, not the session

- **Status:** Accepted
- **Date:** 2026-10-29
- **Requirements:** issue #187; H-6 and H-7 (promoted COULD to SHOULD), H-8 (stays COULD, recorded as out); security-model R-21 and ASI08.
- **Amends:** ADR-0010 (the session's primary query now also passes `maxBudgetUsd` and an `abortController`), ADR-0037 D4 (the seam's `abortController` is no longer judge-only). **Relates to:** ADR-0017 and ADR-0020 (the wall-clock gap they record is still open), ADR-0025 (the result subtype is still recorded verbatim), ADR-0036 (its "no dollar cap anywhere in the harness" is superseded for the primary session), #212 (the SDK's cost figure for claude-sonnet-5 reads high).

## Context

Before this change `maxTurns` was the only whole-run bound the harness passed to the SDK (R-21). The pinned SDK, 0.3.201, declares `maxBudgetUsd` ("The query will stop if this budget is exceeded, returning an `error_max_budget_usd` result", `sdk.d.ts:1635-1639`) and `abortController` (`sdk.d.ts:1279-1283`). The seam carried `abortController` for the judge call only (ADR-0037 D4), and the harness installed no signal handler, so a Ctrl-C killed the process before the stop hook ran or the turn-cost row was written.

The owner decided on 19/10/2026 that the budget is default-on. A live probe on 29/10/2026 (claude-haiku-5-5, two calls costing under a cent; the evidence is operator-local under `tasks/issue-187-evidence/`) observed three behaviours that shape the decisions below:

1. **The budget result arrives, then the iterator throws.** With `maxBudgetUsd: 0.000001` the stream yielded `system/init`, one assistant message, and a result with subtype `error_max_budget_usd`, `total_cost_usd` 0.00366, usage present and `errors: ["Reached maximum budget ($0.000001)"]`. Then the iterator threw `Error: Claude Code returned an error result: Reached maximum budget ($0.000001)`. The SDK source (`sdk.mjs`, `Query.readMessages`) throws that message after every error result whose throw is not an abort, so `error_max_turns` behaves the same way. Before this ADR the session rethrew it, so `run` printed only `error: ...` and no summary line.
2. **The cap is checked after a turn, not before.** The first turn ran in full and cost 3,660 times the cap.
3. **An abort yields no result.** Aborted 2.5 s into a long reply, the stream threw the SDK's abort error ("Claude Code process aborted by user") with no result message and so no cost. Two more system messages arrived after `abort()`.

## Decision

**D1. The seam and the primary query.** `QueryOptions` gains `maxBudgetUsd`, a structural mirror of the SDK's field, pinned in `src/session/sdk-types.test.ts` (the seam now has eleven keys). The session's primary query passes `maxBudgetUsd` and an `AbortController` it creates for each run. The controller is linked to an optional caller `SessionConfig.signal` with a one-shot listener, which is removed when the run ends, so the SDK never holds the caller's controller. A signal that is already aborted aborts the run at once. The judge and the eval adversary keep their own option sets; neither passes a budget.

**D2. The default lives in the session.** `DEFAULT_MAX_BUDGET_USD = 1` (`src/internal/limits.ts`) applies whenever `SessionConfig.maxBudgetUsd` is absent, so `run`, every golden eval task and any library caller are capped. Only absence means the default. Any other value must pass `isBudgetUsd`, a finite number greater than 0, or `createSession` throws before the first query. There is no "unlimited" value: an operator who wants a higher cap names one.

**D3. Where an operator sets the cap.** `run --max-budget-usd <usd>` beats the user settings file's `budget.maxUsd` (`~/.harness/settings.json`), which beats the default. The flag accepts plain decimal digits only (no sign, exponent, or leading or trailing dot). The settings key is read from the USER file only, on the `judge` and `sdk` pattern: the project file's `budget` key is detected but never parsed, and produces one warning, so a cloned repo can neither raise nor lower the operator's cap. One predicate, `isBudgetUsd`, backs the session, the flag and the settings parser, so the three rules cannot drift apart.

**D4. A budget stop is a distinct, recorded outcome.** The result subtype `error_max_budget_usd` is already recorded verbatim (ADR-0025). The turn-cost payload also records `maxBudgetUsd`, the cap that was in force; the field is optional on read, so rows from before this ADR still validate. `run` prints its normal summary line, then `[harness] budget: run stopped at the $X cap after the turn that crossed it (SDK-reported cost $Y; ...)`. The exit code stays 1, as for any non-success result.

**D5. Ctrl-C.** `run` installs a one-shot SIGINT listener for the duration of the run (`src/cli/interrupt.ts`). The listener removes itself and then aborts the run's controller. The session then fires the stop hook and records the turn-cost row with `interrupted: true`, and the command prints `[harness] interrupted: ...` and exits 130. Because the listener has already removed itself, a second Ctrl-C finds none and Node's default kills the process: that is the escape when cleanup hangs. The cost on an interrupted row is null whenever no result arrived, which the probe found is the case for an abort mid-turn. The listener is uninstalled after every run, whatever the outcome.

**D6. Requirements.** H-6 is promoted to SHOULD and met (the requirement names the router, but the cap is a ceiling on the SDK query, and the row says so). H-7 is promoted to SHOULD and partly met: cancellation is met, while the token and wall-clock ceilings stay open and the row says so. H-8 (retries and timeouts) stays COULD, explicitly out of this change.

**D7. The SDK's throw after an error result ends the run, not the session.** Once a result message with a subtype other than `success` has arrived, a later throw from the iterator is the SDK repeating that result, so the session returns the `SessionResult` instead of rethrowing it. This applies to every error subtype, not only the budget one (owner ruling, 29/10/2026). The session still rethrows:
- a throw with no result before it;
- a throw after a `success` result;
- any throw once the caller's signal has aborted, even after an error result (an interrupt takes precedence over D7).

The memory row of a run that D7 completes records `failed: false`, and its `resultSubtype` names the stop.

## Consequences

- **The cap is a ceiling on starting a new turn, not on spend.** A run can overshoot by up to one turn's cost. The SDK enforces the cap on its own `total_cost_usd`, which for claude-sonnet-5 on SDK 0.3.201 prices at Sonnet 4.x rates, about 1.5x list (#212). A USD 1.00 cap therefore trips at about USD 0.67 of list-price spend. This is the safe direction, but the summary's `cost=` and the budget line both show the SDK's figure, not list price.
- **An interrupted run's spend is not traced.** The row exists, which R-21 recorded as missing, but its cost is null, and whether the cut request is billed is unverified, as it is for the judge (ADR-0037).
- **`error_max_turns` now presents differently.** Before, `run` printed `error: Claude Code returned an error result: ...` and exited 1. It now prints the summary line and `[harness] stopped: the run ended without success (result="error_max_turns")`, and exits 1. A library caller now receives a result for such a run instead of a rejection.
- **Eval task sessions inherit the default cap.** A golden task whose run costs more than USD 1.00 by the SDK's figure now stops with `error_max_budget_usd`. `eval` has no override flag yet. The 17 Sonnet `run` sessions in the operator's own telemetry (backfilled 26/10/2026) averaged about USD 0.30 each by the SDK's figure, but golden tasks have not been measured against the cap.
- **Judge calls are not linked to the run's abort.** A judge call already in flight when Ctrl-C arrives is still bounded by its own timer and the existing drain.

## Alternatives considered

- **Default in the CLI only.** This would leave eval tasks and library callers uncapped, which is the opposite of default-on. Rejected.
- **A distinct exit code for a budget stop.** Scripts that check for exit 1 keep working without one, and the stop line names the cause. Rejected (owner ruling, 29/10/2026).
- **Spot the budget stop in the CLI by matching the SDK's error text.** That breaks silently if the SDK rewords its message, and it leaves `error_max_turns` behind a bare `error:` line. Rejected in favour of D7.
- **Ignore the second Ctrl-C until cleanup finishes.** That leaves the operator no escape if a hook or the telemetry write hangs. Rejected.

## Revisit if

- The SDK starts reporting a cost for an aborted run (D5's null cost becomes avoidable).
- #212 is fixed upstream (the "trips early" note goes stale).
- A golden task legitimately needs more than USD 1.00 (add an `eval` override, or a per-task frontmatter cap).
- The SDK stops throwing after an error result, or throws a different error class on abort (D7's condition is keyed on "a result arrived", not on the message text, so it should survive a rewording; re-run the probe).
- H-7's token or wall-clock ceiling is taken up (the seam grows again, and `sdk-types.test.ts` reddens).
