import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { BUDGET_MAX_USD_MESSAGE, BudgetSettingsError, hasBudgetKey, parseBudgetSettings } from './budget-settings.js';
import { composeSecurity, SettingsLoadError } from './shared.js';

// Issue #187 D3: `budget.maxUsd` is read from the USER settings file only,
// like `judge` and `sdk`; the project layer's key is detected, never parsed.

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

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function layer(doc: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'compose-budget-'));
  created.push(dir);
  if (doc !== undefined) {
    mkdirSync(join(dir, '.harness'));
    writeFileSync(join(dir, '.harness', 'settings.json'), JSON.stringify(doc));
  }
  return dir;
}

let lastProjectDir = '';
function compose(user: unknown, project: unknown) {
  lastProjectDir = layer(project);
  return composeSecurity({ userDir: layer(user), projectDir: lastProjectDir });
}

describe('composeSecurity budget (D3)', () => {
  it('takes the cap from the user file', () => {
    expect(compose({ budget: { maxUsd: 3 } }, undefined).budget.maxUsd).toBe(3);
  });

  it('is null with no user key', () => {
    expect(compose(undefined, undefined).budget.maxUsd).toBeNull();
  });

  // The "merged again" mutation target (lesson :729-730): a project cap must
  // never raise or lower the user's, valid or not.
  it.each([[{ budget: { maxUsd: 50 } }], [{ budget: { maxUsd: -1 } }], [{ budget: 'junk' }]])(
    'ignores a project budget key (%j) with exactly one warning; the user cap stands',
    (project) => {
      const result = compose({ budget: { maxUsd: 2 } }, project);
      expect(result.budget.maxUsd).toBe(2);
      const budgetWarnings = result.warnings.filter((w) => w.includes('"budget"'));
      expect(budgetWarnings).toEqual([
        `ignoring "budget" in ${join(lastProjectDir, '.harness', 'settings.json')}: the budget is configured only in ~/.harness/settings.json`,
      ]);
    },
  );

  it('ignores a project cap when the user file has none', () => {
    expect(compose(undefined, { budget: { maxUsd: 50 } }).budget.maxUsd).toBeNull();
  });

  it('fails loud on a malformed user budget', () => {
    expect(() => compose({ budget: { maxUsd: 0 } }, undefined)).toThrow(SettingsLoadError);
  });
});
