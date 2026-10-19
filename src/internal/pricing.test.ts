import { describe, expect, it } from 'vitest';

import {
  CHARS_PER_TOKEN,
  DEFAULT_EXPECTED_OUTPUT_TOKENS,
  estimateRunCostUsd,
  PRICE_MAX_AGE_DAYS,
  PRICE_TABLE,
  stalePriceRows,
  type PriceRow,
} from './pricing.js';

const DAY_MS = 86_400_000;
/** Pinned clock: the day the table was checked. Tests never read the real clock. */
const PINNED_NOW = Date.parse('2026-10-19T00:00:00Z');

function row(model: string): PriceRow {
  const found = PRICE_TABLE.find((r) => r.model === model);
  if (found === undefined) throw new Error(`no price row for ${model}`);
  return found;
}

/** Independent re-derivation from the table row, not a hand-copied dollar figure. */
function expected(model: string, promptChars: number, turns: number, outputCount: number): number {
  const r = row(model);
  const promptSize = Math.ceil(promptChars / CHARS_PER_TOKEN);
  const perM = 1_000_000;
  return (
    (promptSize * r.cacheWriteUsdPerMTok) / perM +
    ((turns - 1) * promptSize * r.cacheReadUsdPerMTok) / perM +
    (outputCount * r.outputUsdPerMTok) / perM
  );
}

describe('PRICE_TABLE', () => {
  it('carries a pricing-page source URL and an ISO checked date on every row', () => {
    for (const r of PRICE_TABLE) {
      expect(r.source).toMatch(/^https:\/\/platform\.claude\.com\/docs\//);
      expect(r.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(r.checked))).toBe(false);
    }
  });

  it('is frozen at runtime, rows included', () => {
    expect(Object.isFrozen(PRICE_TABLE)).toBe(true);
    for (const r of PRICE_TABLE) expect(Object.isFrozen(r)).toBe(true);
  });

  it('prices cache writes above cache reads on every row (guards a swapped column)', () => {
    for (const r of PRICE_TABLE) expect(r.cacheWriteUsdPerMTok).toBeGreaterThan(r.cacheReadUsdPerMTok);
  });
});

describe('stalePriceRows (clock seam)', () => {
  it('passes the shipped table at the pinned clock', () => {
    expect(stalePriceRows(PINNED_NOW)).toEqual([]);
  });

  it('flags every row once the clock passes checked + PRICE_MAX_AGE_DAYS, not before', () => {
    for (const r of PRICE_TABLE) {
      const checked = Date.parse(`${r.checked}T00:00:00Z`);
      const atLimit = checked + PRICE_MAX_AGE_DAYS * DAY_MS;
      expect(stalePriceRows(atLimit).map((s) => s.model)).not.toContain(r.model);
      expect(stalePriceRows(atLimit + DAY_MS).map((s) => s.model)).toContain(r.model);
    }
  });

  it('flags a synthetic old row in a supplied table', () => {
    const old: PriceRow = { ...row('claude-sonnet-5'), model: 'old', checked: '2020-01-01' };
    expect(stalePriceRows(PINNED_NOW, [old]).map((s) => s.model)).toEqual(['old']);
  });

  it('treats an unparseable checked date as stale, not fresh', () => {
    for (const checked of ['', 'not-a-date', '2026-13-45', '2026/10/19']) {
      const bad: PriceRow = { ...row('claude-sonnet-5'), model: 'bad', checked };
      expect(stalePriceRows(PINNED_NOW, [bad]).map((s) => s.model), checked).toEqual(['bad']);
    }
  });

  it('names a positive default output guess', () => {
    expect(DEFAULT_EXPECTED_OUTPUT_TOKENS).toBeGreaterThan(0);
  });

  it('names 120 days as the limit', () => {
    expect(PRICE_MAX_AGE_DAYS).toBe(120);
  });
});

describe('estimateRunCostUsd', () => {
  it('prices one cache write, (turns - 1) cache reads and the output, re-derived from the table', () => {
    for (const r of PRICE_TABLE) {
      const got = estimateRunCostUsd(r.model, 40_000, 5, 3_000);
      expect(got).not.toBeNull();
      expect(got as number).toBeCloseTo(expected(r.model, 40_000, 5, 3_000), 12);
    }
  });

  it('a single turn has no cache reads', () => {
    const got = estimateRunCostUsd('claude-opus-5', 8_000, 1, 0) as number;
    const r = row('claude-opus-5');
    expect(got).toBeCloseTo((2_000 * r.cacheWriteUsdPerMTok) / 1_000_000, 12);
  });

  it('cache reads are priced at the read rate, not the write rate', () => {
    const r = row('claude-fable-5');
    const one = estimateRunCostUsd(r.model, 4_000, 1, 0) as number;
    const three = estimateRunCostUsd(r.model, 4_000, 3, 0) as number;
    expect(three - one).toBeCloseTo((2 * 1_000 * r.cacheReadUsdPerMTok) / 1_000_000, 12);
  });

  it('returns null for an unpriced model and for unusable inputs, never zero', () => {
    expect(estimateRunCostUsd('claude-unknown', 1_000, 3, 100)).toBeNull();
    expect(estimateRunCostUsd('claude-sonnet-5', -1, 3, 100)).toBeNull();
    expect(estimateRunCostUsd('claude-sonnet-5', 1_000, 0, 100)).toBeNull();
    expect(estimateRunCostUsd('claude-sonnet-5', 1_000, 3, Number.NaN)).toBeNull();
    expect(estimateRunCostUsd('claude-sonnet-5', Number.POSITIVE_INFINITY, 3, 1)).toBeNull();
  });

  it('applies a long-context step when the supplied table has one and the prompt crosses it', () => {
    const base = row('claude-sonnet-5');
    const stepped: PriceRow = {
      ...base,
      model: 'stepped',
      longContext: {
        overPromptTokens: 1_000,
        rates: { inputUsdPerMTok: 9, outputUsdPerMTok: 90, cacheWriteUsdPerMTok: 11, cacheReadUsdPerMTok: 7 },
      },
    };
    const table = [stepped];
    const under = estimateRunCostUsd('stepped', 3_996, 2, 100, table) as number; // 999 tokens
    const over = estimateRunCostUsd('stepped', 4_004, 2, 100, table) as number; // 1001 tokens
    expect(under).toBeCloseTo(
      (999 * base.cacheWriteUsdPerMTok + 999 * base.cacheReadUsdPerMTok + 100 * base.outputUsdPerMTok) / 1_000_000,
      12,
    );
    expect(over).toBeCloseTo((1001 * 11 + 1001 * 7 + 100 * 90) / 1_000_000, 12);
  });

  it('the shipped rows carry no long-context step (none listed for these models on the source page)', () => {
    for (const r of PRICE_TABLE) expect(r.longContext).toBeNull();
  });
});
