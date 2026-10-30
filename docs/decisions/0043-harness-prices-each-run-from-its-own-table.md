# ADR-0043: the harness prices each run from its own dated table, and telemetry leads with that figure

- **Status:** Accepted
- **Date:** 2026-10-30
- **Requirements:** issue #212; #192 (the pre-run estimate this pairs against); #98 (routing calibration, which needs true costs); ADR-0041 and security-model R-21 (the dollar ceiling).
- **Amends:** ADR-0041 (the cap is enforced on the SDK's figure, not on a list-price figure; `run` now says so when the two differ), ADR-0011 (the `turn-cost` payload gains three optional fields; no migration, the payload is JSON).

## Context

The harness stored the SDK result's `total_cost_usd` as `costUsd` on every `turn-cost` row and reported it as spend. Issue #212 re-priced 27 Sonnet 5 runs from their own tokens: 19 matched the SDK figure to four decimal places at $3 / $15 per MTok, none at Sonnet 5's list $2 / $10, so recorded spend read about 1.5x real.

Reading the bundled CLI (0.3.201, `strings` of the binary, 30/10/2026; not run) explains it. Its price table maps `claude-sonnet-5` to the Sonnet 4.x tier ($3 in, $15 out, $3.75 5-minute write, $0.30 read), and has no row at all for `claude-opus-5`, which therefore falls back to the default model's tier and then to $5 / $25, the same last resort 0.3.312 keeps. The latest SDK, 0.3.312, rebuilds pricing on a baked model catalogue with a `modelPricing` settings override; its catalogue lists `claude-sonnet-5` at `tier_2_10` ($2 / $10) and `claude-opus-5` at `tier_5_25` (docs-parity read of the 0.3.312 binary, 30/10/2026). Whether the CLI's `total_cost_usd` uses that tier at runtime needs a keyed run, so the bump is a separate issue (#219).

The result message also carries `modelUsage` on both variants (`sdk.d.ts:4012` error, `:4042` success; type `ModelUsage` at `:1229`): tokens, web-search requests and the CLI's own cost for each model the run used. The harness did not capture it. A WebFetch digest or a subagent on another model would be a separate key there, which would explain #212's residuals on runs that made WebFetch calls; that is not yet confirmed.

## Decision

**D1. Capture `modelUsage`.** The session reads the result's `modelUsage` into at most `MODEL_USAGE_MAX` (16, `src/internal/limits.ts`) rows of `{ model, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, sdkCostUsd }` (`parseModelUsage`, `src/session/session.ts`). The stream is untrusted: a non-object or empty value, a non-object entry, or any of the first `MODEL_USAGE_MAX` entries with a count that is not a finite number >= 0 yields no rows (entries past the cap are not inspected, and a cut set is never priced); an unusable per-model SDK cost is kept as null. The SDK's own `total_cost_usd`, `num_turns` and `usage` counts get the same finite guard, because `1e999` parses to Infinity (and a missing count is undefined), which the store refuses, and that would drop the whole row; those three predate #212. Model keys are cleaned like the other SDK tokens, and the store sanitises them again and refuses more than the cap on its read path.

**D2. Price the run.** `priceModelUsage` (`src/internal/pricing.ts`) prices every row from `PRICE_TABLE`, plus web search at the pricing page's $10 per 1,000 (read 30/10/2026). A dated id (`-YYYYMMDD`) prices as its undated row and nothing else is stripped, so `claude-opus-5-5` never prices as `claude-opus-5`. The figure is null, never a partial sum, when there are no rows, any model is unpriced, any count is unusable, the total overflows (a huge but finite count prices to Infinity), the session cut the set at the cap, or a row has a long-context step: `modelUsage` is cumulative over the run, so it cannot show whether any one request crossed a per-request threshold (no current row has a step). It is also null when every row carries the SDK's own per-model cost and those do not sum to the SDK's total within 1%: the CLI then billed something `modelUsage` does not list, and pricing the list would under-report the run (`pricedRunCost`, `src/session/session.ts`). The row stores it as `pricedCostUsd` with `pricedPriceChecked`, the table's `checked` date, so a later price change does not silently re-mean old rows. `costUsd` stays the SDK's figure, unchanged. `SessionResult` gains `pricedCostUsd`.

**D3. Lead with the harness figure (owner, 30/10/2026).** `telemetry cost` sums `pricedCostUsd` where a row has one and falls back to `costUsd` where it does not. The agent table adds `SDK` (the SDK's own sum) and `SDK-PRICED` (rows that fell back) beside `COST`, and one line under it states the split and the SDK's total. The estimate-vs-actual section pairs against the same figure. Judge rows carry only the SDK figure and keep their table, and the `TOTAL` line says so (`judge $X at the SDK figure`). The `run` summary line's `cost=` is the same headline, with `sdk-cost=` always beside it.

**D4. Say when the cap is off (owner, 30/10/2026).** The SDK enforces `maxBudgetUsd` against its own figure, which the harness cannot change, so on Sonnet 5 at 0.3.201 a $1.00 cap stops near $0.67 at list prices. That fails safe but misleads. After a run whose two figures differ by more than 5%, `run` prints one stderr line naming the ratio and where the cap really stops (`formatBudgetGapLine`, `src/cli.ts`). The owner chose "document and warn" over scaling the cap passed to the SDK, which would hard-code a reading of the CLI's prices and break silently once the SDK fixes them. The warning reads the run's own figures, not a stored ratio, so it goes quiet when the SDK figure is right. It was offered as a startup warning; it fires after the run because the routed model is only known inside `session.run()`, and the run's own figures are exact where a startup guess would need history.

**D5. The SDK bump is separate.** Moving to 0.3.312 moves the whole bundled CLI and re-opens the binary readings behind ADR-0040 D-8 (#211), so it is its own issue with a keyed run (#219).

## Consequences

- `telemetry cost` and `--estimate` read list-price spend for every new row whose models are all in the table and whose usage is whole; other rows fall back to the SDK figure, visibly. Older rows have no `pricedCostUsd`, fall back to the SDK figure, and are counted under `SDK-PRICED`, so the report says how much of a total is still the SDK's.
- #98 can calibrate on list prices.
- Judge spend (`judge-call` rows), the golden eval scorecard's adversary cost (`src/cli/eval-command.ts`) and the redteam judge totals stay on the SDK's `total_cost_usd`. *Amended 30/10/2026 (#213): the scorecard's per-task cost now carries the harness figure too (`volatile.pricedCostUsd`, `totals.totalPricedCostUsd`, `totals.sdkPricedTasks`), and the rendered scorecard leads with it.* The judge runs on Sonnet (ADR-0038), so those read about 1.5x list at 0.3.201. Pricing them the same way is a follow-up; #219's SDK bump may make it moot.
- The harness now owns a price table it must keep current: `PRICE_TABLE` is dated, and `telemetry cost --estimate` already notes a table over 120 days old. A model the table lacks prices as null, and its rows fall back, visibly.
- `pricedCostUsd` is list price. It does not model discounts, batch pricing, regional uplift (the 0.3.312 CLI applies 1.1x for `inference_geo: "us"`) or the 1-hour cache write, which `ModelUsage` does not separate from the 5-minute one; these are reasons the two figures can legitimately differ.
- The budget gap line fires on any run whose figures differ by more than 5%, including an SDK figure below list (the cap then lets more through than it says).

## Revisit if

- An SDK bump prices Sonnet 5 at list: the gap line goes quiet by itself; the D3 headline stays, since the harness's table is the one it can date and test.
- `ModelUsage` starts separating 1-hour cache writes, or the pricing page adds a charge the table does not model.
