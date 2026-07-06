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
  const parsed = ruleList.map((entry, index) => parseRule(entry, index));
  return defaultDecision === undefined
    ? { rules: parsed }
    : { defaultDecision, rules: parsed };
}

export type ReadFile = (path: string) => string;

/**
 * Loads one settings layer. Missing file (ENOENT) → empty layer; a file that
 * exists but is unreadable or invalid throws (fail loud at startup).
 */
export function loadSettingsFile(path: string, readFile: ReadFile): PermissionSettings {
  let body: string;
  try {
    body = readFile(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { rules: [] };
    }
    throw error;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PermissionSettingsError(`${path} is not valid JSON: ${detail}`);
  }
  try {
    return parsePermissionSettings(doc);
  } catch (error: unknown) {
    if (error instanceof PermissionSettingsError) {
      throw new PermissionSettingsError(`${path}: ${error.message}`);
    }
    throw error;
  }
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
