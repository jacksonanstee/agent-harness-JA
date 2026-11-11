/**
 * Dated, sourced Anthropic price table and the pre-run cost estimate (#192,
 * feeding #98). Zero-dep leaf: it knows model ids as plain strings, never the
 * router's `Model` union, so internal stays below every domain. A test in
 * src/cli/pricing-coverage.test.ts proves every id in the router's MODELS
 * list has a row, and that the judge's model has one.
 *
 * Nothing here changes routing. It exists so the estimate can be stored beside
 * the actual cost and compared (`telemetry cost --estimate`).
 */

/** USD per million tokens. */
export interface PriceRates {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** The 5-minute prompt-cache write price (the default TTL), not the 1-hour one. */
  cacheWriteUsdPerMTok: number;
  cacheReadUsdPerMTok: number;
}

export interface PriceRow extends PriceRates {
  model: string;
  /** The page the row was read from. */
  source: string;
  /** ISO date (YYYY-MM-DD) the row was last checked against `source`. */
  checked: string;
  /**
   * A per-model price step by prompt length, or null when the source page lists
   * none. The page lists one only for Claude Haiku 5.5: a request whose prompt
   * (input + cache read + cache write) is over the threshold pays `rates`.
   */
  longContext: { overPromptTokens: number; rates: PriceRates } | null;
}

const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
const CHECKED = '2026-11-12';

/**
 * Models the harness never routes to but the bundled CLI calls on its own in a
 * run, so their usage arrives in `modelUsage` and must be priced or the whole
 * run falls back to the SDK figure (#219: the SDK 0.3.312 CLI made a Haiku 5.5
 * side call in each of three keyed runs on 03/11/2026). Empty since #242:
 * Haiku 5.5 became a router model, so it is covered as one. The list stays as
 * the place the next observed side-call model goes. pricing-coverage.test.ts
 * allows a PRICE_TABLE row only for a router model, one listed here, or one in
 * RETIRED_ROUTER_MODELS.
 */
export const CLI_SIDE_CALL_MODELS: readonly string[] = Object.freeze([]);

/**
 * Ids that were members of the router's `Model` union and no longer are (#242,
 * the refresh to the 5.5 / 5.2 generation). Their PRICE_TABLE rows are kept on
 * purpose: stored telemetry from older runs names them, and `telemetry cost`
 * prices a run from this table, so dropping a row would turn an old run's
 * harness-priced cost into "unpriced". `claude-sonnet-5` is also still the
 * judge's model (`JUDGE_MODEL`, never routed). The router cannot select any
 * of these; pricing-coverage.test.ts keeps this list disjoint from MODELS.
 */
export const RETIRED_ROUTER_MODELS: readonly string[] = Object.freeze([
  'claude-haiku-4-5',
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-fable-5',
]);

/** The date every PRICE_TABLE row was last checked; stored beside a harness-priced cost (#212). */
export const PRICE_TABLE_CHECKED = CHECKED;

const priced = (r: Omit<PriceRow, 'source' | 'checked' | 'longContext'>): Readonly<PriceRow> =>
  Object.freeze({ ...r, source: PRICING_URL, checked: CHECKED, longContext: null });

/**
 * Rows were read from the "Model pricing" table of PRICING_URL on CHECKED
 * (every row re-read on 12/11/2026 when Sonnet 5.5, Opus 5.5 and Fable 5.2
 * were added, #242; Haiku 5.5 was added on 03/11/2026, #219).
 *
 * Each rate is the page's own figure, never derived from a multiplier: the
 * cache-hit price is 0.1x input on the older rows but 0.05x on Sonnet 5.5 and
 * Opus 5.5 and 0.025x on Fable 5.2.
 */
export const PRICE_TABLE: readonly Readonly<PriceRow>[] = Object.freeze([
  priced({
    model: 'claude-haiku-4-5',
    inputUsdPerMTok: 1,
    cacheWriteUsdPerMTok: 1.25,
    cacheReadUsdPerMTok: 0.1,
    outputUsdPerMTok: 5,
  }),
  Object.freeze({
    model: 'claude-haiku-5-5',
    inputUsdPerMTok: 0.1,
    cacheWriteUsdPerMTok: 0.125,
    cacheReadUsdPerMTok: 0.01,
    outputUsdPerMTok: 0.5,
    source: PRICING_URL,
    checked: CHECKED,
    longContext: {
      overPromptTokens: 100_000,
      rates: { inputUsdPerMTok: 0.5, cacheWriteUsdPerMTok: 0.625, cacheReadUsdPerMTok: 0.05, outputUsdPerMTok: 2.5 },
    },
  }),
  priced({
    model: 'claude-sonnet-5-5',
    inputUsdPerMTok: 2,
    cacheWriteUsdPerMTok: 2.5,
    cacheReadUsdPerMTok: 0.1,
    outputUsdPerMTok: 10,
  }),
  priced({
    model: 'claude-opus-5-5',
    inputUsdPerMTok: 4,
    cacheWriteUsdPerMTok: 5,
    cacheReadUsdPerMTok: 0.2,
    outputUsdPerMTok: 20,
  }),
  priced({
    model: 'claude-fable-5-2',
    inputUsdPerMTok: 8,
    cacheWriteUsdPerMTok: 10,
    cacheReadUsdPerMTok: 0.2,
    outputUsdPerMTok: 40,
  }),
  priced({
    model: 'claude-sonnet-5',
    inputUsdPerMTok: 2,
    cacheWriteUsdPerMTok: 2.5,
    cacheReadUsdPerMTok: 0.2,
    outputUsdPerMTok: 10,
  }),
  priced({
    model: 'claude-opus-5',
    inputUsdPerMTok: 5,
    cacheWriteUsdPerMTok: 6.25,
    cacheReadUsdPerMTok: 0.5,
    outputUsdPerMTok: 25,
  }),
  priced({
    model: 'claude-fable-5',
    inputUsdPerMTok: 10,
    cacheWriteUsdPerMTok: 12.5,
    cacheReadUsdPerMTok: 1,
    outputUsdPerMTok: 50,
  }),
]);

/** A row whose `checked` date is older than this many days is stale. */
export const PRICE_MAX_AGE_DAYS = 120;

const DAY_MS = 86_400_000;

/**
 * Output tokens assumed when the operator gives no `--expected-output-tokens`.
 * A placeholder guess, recorded as defaulted in the payload so a calibration
 * can separate defaulted rows from operator-supplied ones.
 */
export const DEFAULT_EXPECTED_OUTPUT_TOKENS = 4000;

/**
 * Rows older than PRICE_MAX_AGE_DAYS at `now` (epoch ms; the caller owns the
 * clock). A `checked` date that does not parse counts as stale: NaN compares
 * false against any limit, which would otherwise read as fresh.
 */
export function stalePriceRows(
  now: number,
  table: readonly Readonly<PriceRow>[] = PRICE_TABLE,
): Readonly<PriceRow>[] {
  return table.filter((r) => {
    const age = now - Date.parse(`${r.checked}T00:00:00Z`);
    return Number.isNaN(age) || age > PRICE_MAX_AGE_DAYS * DAY_MS;
  });
}

/**
 * Characters per token for turning the assembled system prompt's length into a
 * token count. An APPROXIMATION on purpose (no tokenizer is imported): English
 * prose averages near 4, and the page notes Claude 4.7 and later tokenise about
 * 30% more tokens for the same text, so this likely under-counts. The estimate
 * is for calibration against actuals, not for billing.
 */
export const CHARS_PER_TOKEN = 4;

const PER_MTOK = 1_000_000;

function usable(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

/**
 * Pre-run cost estimate in USD: one cache write of the system prompt, then
 * (turns - 1) cache reads of it, plus `outputGuess` of output. User
 * prompt, tool results and per-turn growth are not counted. Returns null for an
 * unpriced model or an unusable input (never zero: unknown stays unknown).
 */
export function estimateRunCostUsd(
  model: string,
  systemPromptChars: number,
  expectedTurns: number,
  outputGuess: number,
  table: readonly Readonly<PriceRow>[] = PRICE_TABLE,
): number | null {
  const row = table.find((r) => r.model === model);
  if (row === undefined) return null;
  if (!usable(systemPromptChars) || !usable(outputGuess)) return null;
  if (!Number.isFinite(expectedTurns) || expectedTurns < 1) return null;
  const promptSize = Math.ceil(systemPromptChars / CHARS_PER_TOKEN);
  const step = row.longContext;
  const rates = step !== null && promptSize > step.overPromptTokens ? step.rates : row;
  return (
    (promptSize * rates.cacheWriteUsdPerMTok +
      (expectedTurns - 1) * promptSize * rates.cacheReadUsdPerMTok +
      outputGuess * rates.outputUsdPerMTok) /
    PER_MTOK
  );
}

/** The estimate fields a turn-cost payload carries (see TurnCostPayload). */
export interface RunEstimateFields {
  estimateUsd: number | null;
  estimateSystemPromptChars: number | null;
  estimateTurns: number | null;
  estimateOutputCount: number | null;
  estimateOutputDefaulted: boolean;
  estimatePriceChecked: string | null;
}

/**
 * Estimate plus the inputs that produced it. The estimate is null (never an
 * output-only figure) when there is no system prompt, when `turns` is unset or
 * below 1, or when the model is unpriced. A missing output guess falls back to
 * DEFAULT_EXPECTED_OUTPUT_TOKENS and is recorded as null and defaulted.
 */
export function buildRunEstimate(input: {
  model: string;
  systemPromptChars: number | undefined;
  turns: number | undefined;
  outputGuess: number | undefined;
}): RunEstimateFields {
  const defaulted = input.outputGuess === undefined;
  const output = input.outputGuess ?? DEFAULT_EXPECTED_OUTPUT_TOKENS;
  const usd =
    input.systemPromptChars === undefined || input.turns === undefined
      ? null
      : estimateRunCostUsd(input.model, input.systemPromptChars, input.turns, output);
  return {
    estimateUsd: usd,
    estimateSystemPromptChars: input.systemPromptChars ?? null,
    estimateTurns: input.turns ?? null,
    estimateOutputCount: input.outputGuess ?? null,
    estimateOutputDefaulted: defaulted,
    estimatePriceChecked: PRICE_TABLE.find((r) => r.model === input.model)?.checked ?? null,
  };
}

/**
 * Web search: "$10 USD per 1,000 searches, plus standard token costs" (PRICING_URL,
 * read 2026-10-30). Web fetch has no charge beyond tokens, so it has no rate here.
 */
export const WEB_SEARCH_USD_PER_REQUEST = 0.01;

/**
 * One model's share of a run, from the SDK result's `modelUsage` (#212). The
 * SDK's own figure rides along as `sdkCostUsd` so a row shows both; it is never
 * used to price.
 */
export interface ModelUsageRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  sdkCostUsd: number | null;
}

/** A dated id (`claude-haiku-4-5-20251001`) prices as its undated row; nothing else is stripped. */
const DATE_SUFFIX = /-\d{8}$/;

function rowFor(model: string, table: readonly Readonly<PriceRow>[]): Readonly<PriceRow> | undefined {
  return table.find((r) => r.model === model) ?? table.find((r) => r.model === model.replace(DATE_SUFFIX, ''));
}

/**
 * The run's cost priced by the harness's own dated table (#212), summed over
 * every model the SDK reports. The bundled CLI at 0.3.201 priced Sonnet 5 at
 * Sonnet 4.x rates (0.3.312 prices it at list, observed 03/11/2026, #219); this
 * is the figure `telemetry cost` leads with. Null, never a partial sum, when
 * there are no rows, any model is unpriced, any count is not a finite number
 * >= 0, or the total overflows (a huge but finite count).
 *
 * A row with a long-context step prices at base rates only when the model's
 * cumulative prompt for the run (input + cache read + cache write) is at or
 * under the step: no single request's prompt can exceed the run's total, so
 * none crossed. Over it, `modelUsage` cannot show which request crossed, so
 * the run is null (#212's rule, narrowed in #219, ADR-0043 amended). The proof
 * assumes `modelUsage` counts every request for the model.
 */
export function priceModelUsage(
  rows: readonly ModelUsageRow[],
  table: readonly Readonly<PriceRow>[] = PRICE_TABLE,
): number | null {
  if (rows.length === 0) return null;
  let total = 0;
  for (const u of rows) {
    const row = rowFor(u.model, table);
    const counts = [u.inputTokens, u.outputTokens, u.cacheReadInputTokens, u.cacheCreationInputTokens, u.webSearchRequests];
    if (row === undefined || !counts.every(usable)) return null;
    const prompt = u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
    if (row.longContext !== null && prompt > row.longContext.overPromptTokens) return null;
    total +=
      (u.inputTokens * row.inputUsdPerMTok +
        u.outputTokens * row.outputUsdPerMTok +
        u.cacheReadInputTokens * row.cacheReadUsdPerMTok +
        u.cacheCreationInputTokens * row.cacheWriteUsdPerMTok) /
        PER_MTOK +
      u.webSearchRequests * WEB_SEARCH_USD_PER_REQUEST;
  }
  return Number.isFinite(total) ? total : null;
}
