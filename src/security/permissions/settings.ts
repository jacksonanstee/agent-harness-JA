import { loadJsonSettings } from '../../internal/settings.js';
import type {
  EvaluatorOptions,
  LayeredRule,
  PermissionDecision,
  PermissionRule,
  PermissionSettings,
} from './types.js';

/**
 * A settings file that exists but cannot be parsed or validated. Thrown at
 * load time so a broken security config crashes the harness before any tool
 * runs — fail loud, never fail open (ADR-0014 §6).
 */
export class PermissionSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionSettingsError';
  }
}

const DECISIONS: readonly PermissionDecision[] = ['allow', 'ask', 'deny'];

/**
 * Upper bound per settings file. Project settings are attacker-influenced
 * input (a cloned repo ships its own .harness/settings.json); the cap keeps
 * per-call evaluation cost bounded. Far above any plausible hand-written
 * policy.
 */
export const MAX_RULES = 1000;

function isDecision(value: unknown): value is PermissionDecision {
  return typeof value === 'string' && (DECISIONS as readonly string[]).includes(value);
}

function parseRule(value: unknown, index: number): PermissionRule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PermissionSettingsError(`permissions.rules[${index}] must be an object`);
  }
  const { tool, match, decision } = value as Record<string, unknown>;
  if (typeof tool !== 'string' || tool === '') {
    throw new PermissionSettingsError(`permissions.rules[${index}].tool must be a non-empty string`);
  }
  if (match !== undefined && typeof match !== 'string') {
    throw new PermissionSettingsError(`permissions.rules[${index}].match must be a string`);
  }
  if (!isDecision(decision)) {
    throw new PermissionSettingsError(
      `permissions.rules[${index}].decision must be one of ${DECISIONS.join(' | ')}`,
    );
  }
  return match === undefined ? { tool, decision } : { tool, match, decision };
}

/**
 * Validates one settings document (hand-rolled: no schema deps, matching the
 * S-1/S-2 style). Absent `permissions` key → empty layer. Unknown sibling
 * keys are ignored (the file is shared with future settings); malformed
 * entries under `permissions` are errors, never skipped.
 */
export function parsePermissionSettings(doc: unknown): PermissionSettings {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new PermissionSettingsError('settings root must be a JSON object');
  }
  const permissions = (doc as Record<string, unknown>)['permissions'];
  if (permissions === undefined) {
    return { rules: [] };
  }
  if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)) {
    throw new PermissionSettingsError('permissions must be an object');
  }
  const { defaultDecision, rules } = permissions as Record<string, unknown>;
  if (defaultDecision !== undefined && !isDecision(defaultDecision)) {
    throw new PermissionSettingsError(
      `permissions.defaultDecision must be one of ${DECISIONS.join(' | ')}`,
    );
  }
  const ruleList = rules === undefined ? [] : rules;
  if (!Array.isArray(ruleList)) {
    throw new PermissionSettingsError('permissions.rules must be an array');
  }
  if (ruleList.length > MAX_RULES) {
    throw new PermissionSettingsError(
      `permissions.rules has ${ruleList.length} entries; the maximum is ${MAX_RULES}`,
    );
  }
  const parsed = ruleList.map((entry, index) => parseRule(entry, index));
  return defaultDecision === undefined
    ? { rules: parsed }
    : { defaultDecision, rules: parsed };
}

export type { ReadFile } from '../../internal/settings.js';

/**
 * Loads one settings layer. Missing file (ENOENT) → empty layer; a file that
 * exists but is unreadable or invalid throws (fail loud at startup).
 * Mechanics live in the shared internal loader (ADR-0015).
 */
export function loadSettingsFile(
  path: string,
  readFile: (path: string) => string,
): PermissionSettings {
  return loadJsonSettings(
    path,
    readFile,
    parsePermissionSettings,
    { rules: [] },
    PermissionSettingsError,
  );
}

/**
 * Merges the user layer under the project layer. Rules concatenate user-first
 * and evaluate under specificity-then-severity, so a user deny survives a
 * project allow of equal specificity (sticky deny, ADR-0014 §5).
 * `defaultDecision`: project overrides user.
 */
export function mergeLayers(
  user: PermissionSettings,
  project: PermissionSettings,
): EvaluatorOptions {
  const tag = (rules: readonly PermissionRule[], layer: LayeredRule['layer']): LayeredRule[] =>
    rules.map((rule) => ({ ...rule, layer }));
  const rules = [...tag(user.rules, 'user'), ...tag(project.rules, 'project')];
  const defaultDecision = project.defaultDecision ?? user.defaultDecision;
  return defaultDecision === undefined ? { rules } : { rules, defaultDecision };
}
