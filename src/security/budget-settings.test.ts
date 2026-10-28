import { describe, expect, it } from 'vitest';

import { BUDGET_MAX_USD_MESSAGE, BudgetSettingsError, hasBudgetKey, parseBudgetSettings } from './budget-settings.js';

// Issue #187 D3: the parser for the USER file's `budget.maxUsd`. The
// composition (user only, project ignored) is pinned in cli/compose-budget.test.ts.

describe('parseBudgetSettings', () => {
  it('reads absence as null (the session default applies)', () => {
    expect(parseBudgetSettings({})).toBeNull();
    expect(parseBudgetSettings({ budget: {} })).toBeNull();
  });

  it('returns a valid cap', () => {
    expect(parseBudgetSettings({ budget: { maxUsd: 2.5 } })).toBe(2.5);
    expect(parseBudgetSettings({ budget: { maxUsd: 1 } })).toBe(1);
  });

  // Only absence means default (lesson :321): null is checked, not defaulted.
  it.each([[0], [-1], [null], ['1'], [true], [[1]]])('refuses maxUsd %j without echoing it', (bad) => {
    expect(() => parseBudgetSettings({ budget: { maxUsd: bad } })).toThrow(BudgetSettingsError);
    expect(() => parseBudgetSettings({ budget: { maxUsd: bad } })).toThrow(BUDGET_MAX_USD_MESSAGE);
  });

  it('refuses a non-object budget and an unknown key', () => {
    expect(() => parseBudgetSettings({ budget: 2 })).toThrow('budget must be an object');
    expect(() => parseBudgetSettings({ budget: { maxUSD: 2 } })).toThrow(/maxUSD/);
  });

  it('detects an own budget key whatever its value', () => {
    expect(hasBudgetKey({ budget: 'junk' })).toBe(true);
    expect(hasBudgetKey({})).toBe(false);
    expect(hasBudgetKey(Object.create({ budget: 1 }))).toBe(false);
  });
});
