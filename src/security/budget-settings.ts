// The run's dollar ceiling from settings (issue #187, ADR-0041 D3). The
// parser below validates the USER file's `budget.maxUsd`; the project
// layer's `budget` key is only detected (`hasBudgetKey`), never parsed, so a
// cloned repo can neither raise nor lower the operator's cap.
// It lives beside sdk-settings.ts and judge-settings.ts, its two models,
// because the security model files the cap under DoS (R-21, ASI08).
import { isBudgetUsd } from '../internal/limits.js';
import { unknownKeyMessage, unknownKeys } from '../internal/settings.js';

/** Same fail-loud contract as JudgeSettingsError (ADR-0034, A-8). */
export class BudgetSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetSettingsError';
  }
}

/** The one refusal for a bad cap. It never echoes a value (G-3). */
export const BUDGET_MAX_USD_MESSAGE = 'budget.maxUsd must be a finite number of US dollars greater than 0';

const BUDGET_KEYS: readonly string[] = ['maxUsd'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates the `budget` key of a USER settings document. Absent key and
 * absent `maxUsd` resolve to null (the session default applies); only
 * absence means default, so `null` is refused like any other bad value.
 */
export function parseBudgetSettings(doc: unknown): number | null {
  if (!isRecord(doc)) throw new BudgetSettingsError('settings root must be a JSON object');
  const budget = doc['budget'];
  if (budget === undefined) return null;
  if (!isRecord(budget)) throw new BudgetSettingsError('budget must be an object');
  const [unknown] = unknownKeys(budget, BUDGET_KEYS);
  if (unknown !== undefined) throw new BudgetSettingsError(unknownKeyMessage('budget', unknown, BUDGET_KEYS));
  const maxUsd = budget['maxUsd'];
  if (maxUsd === undefined) return null;
  if (!isBudgetUsd(maxUsd)) throw new BudgetSettingsError(BUDGET_MAX_USD_MESSAGE);
  return maxUsd;
}

/**
 * True when a settings document carries an OWN `budget` key, whatever its
 * value: the project layer's only budget behaviour is one warning.
 */
export function hasBudgetKey(doc: unknown): boolean {
  return isRecord(doc) && Object.prototype.hasOwnProperty.call(doc, 'budget');
}
