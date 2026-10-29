import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { composeSecurity, SettingsLoadError } from './shared.js';

// Issue #187 D3: `budget.maxUsd` is read from the USER settings file only,
// like `judge` and `sdk`; the project layer's key is detected, never parsed.

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
