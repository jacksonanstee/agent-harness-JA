/**
 * Dated, sourced Anthropic price table and the pre-run cost estimate (#192,
 * feeding #98). Zero-dep leaf: it knows model ids as plain strings, never the
 * router's `Model` union, so internal stays below every domain. A test in
 * src/cli/pricing-coverage.test.ts proves every id in the router's MODELS
 * list has a row.
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
   * none. The page lists one only for Claude Haiku 5.5, which is not a model
   * this harness names; the field exists so a future row can carry one.
   */
  longContext: { overPromptTokens: number; rates: PriceRates } | null;
}

const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
const CHECKED = '2026-10-19';

/** The date every PRICE_TABLE row was last checked; stored beside a harness-priced cost (#212). */
export const PRICE_TABLE_CHECKED = CHECKED;

const priced = (r: Omit<PriceRow, 'source' | 'checked' | 'longContext'>): Readonly<PriceRow> =>
  Object.freeze({ ...r, source: PRICING_URL, checked: CHECKED, longContext: null });

/** Rows were read from the "Model pricing" table of PRICING_URL on CHECKED. */
export const PRICE_TABLE: readonly Readonly<PriceRow>[] = Object.freeze([
  priced({
    model: 'claude-haiku-4-5',
    inputUsdPerMTok: 1,
    cacheWriteUsdPerMTok: 1.25,
    cacheReadUsdPerMTok: 0.1,
    outputUsdPerMTok: 5,
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
 * every model the SDK reports. The bundled CLI at 0.3.201 prices Sonnet 5 at
 * Sonnet 4.x rates, so its `total_cost_usd` reads about 1.5x high; this is the
 * figure `telemetry cost` leads with. Null, never a partial sum, when there are
 * no rows, any model is unpriced, any count is not a finite number >= 0, the
 * total overflows (a huge but finite count), or a row has a long-context step:
 * `modelUsage` is cumulative over the run, so it cannot show whether any one
 * request crossed a per-request threshold.
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
    if (row === undefined || row.longContext !== null || !counts.every(usable)) return null;
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
