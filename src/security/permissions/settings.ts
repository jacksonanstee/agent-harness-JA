import { loadJsonSettings, unknownKeyMessage, unknownKeys } from '../../internal/settings.js';
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
 * The known keys at each object level inside `permissions`. An unknown key at
 * either level is an error (ADR-0034 decision 1): a typo of `defaultDecision`
 * left the default at allow, and a typo of `match` turned a scoped allow rule
 * into a blanket one, each with no signal (issue #85). Root-level siblings of
 * `permissions` stay ignored; that is the forward-compatibility ADR-0014 §5
 * meant, and the only level it applies to.
 */
const PERMISSIONS_KEYS: readonly string[] = ['defaultDecision', 'rules'];
const RULE_KEYS: readonly string[] = ['tool', 'match', 'decision'];

function rejectUnknownKeys(
  record: Record<string, unknown>,
  known: readonly string[],
  where: string,
): void {
  const [first] = unknownKeys(record, known);
  if (first !== undefined) {
    throw new PermissionSettingsError(unknownKeyMessage(where, first, known));
  }
}

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
  rejectUnknownKeys(value as Record<string, unknown>, RULE_KEYS, `permissions.rules[${index}]`);
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
 * S-1/S-2 style). Absent `permissions` key → empty layer. Unknown ROOT-level
 * siblings are ignored (the file is shared with future settings); inside
 * `permissions`, at every level, an unknown key is an error like any other
 * malformed entry, never skipped (ADR-0014 §6, ADR-0034 decision 1).
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
  rejectUnknownKeys(permissions as Record<string, unknown>, PERMISSIONS_KEYS, 'permissions');
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
