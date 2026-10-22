// The Claude Code settings sources the SDK child may load (issue #140,
// ADR-0040). The tuple is the harness's own literal, parity-pinned in both
// directions against the SDK's `SettingSource` in session/sdk-types.test.ts.
// The default is none: an absent or empty list isolates the child. The parser
// below validates the USER file's `sdk.settingSources`; the project layer's
// `sdk` key is only detected (`hasSdkKey`), never parsed.
import { unknownKeyMessage, unknownKeys } from '../internal/settings.js';

export const SETTING_SOURCES = ['user', 'project', 'local'] as const;
export type SettingSource = (typeof SETTING_SOURCES)[number];

/** Same fail-loud contract as JudgeSettingsError (ADR-0034, A-8). */
export class SdkSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SdkSettingsError';
  }
}

/** The one refusal for a bad list. It never echoes a value (G-3). */
export const SDK_SETTING_SOURCES_MESSAGE = `sdk.settingSources must be an array of distinct values from ${SETTING_SOURCES.map((s) => `"${s}"`).join(', ')}`;

const SDK_KEYS: readonly string[] = ['settingSources'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSettingSource(value: unknown): value is SettingSource {
  return typeof value === 'string' && (SETTING_SOURCES as readonly string[]).includes(value);
}

/**
 * Validates the `sdk` key of a USER settings document (ADR-0040 D2). Absent
 * key, absent list and `[]` all resolve to `[]` (isolated). Anything else
 * must be an array of distinct `user | project | local` literals, returned as
 * a fresh array in the order written. Messages are fixed and never echo a
 * value (G-3); an unknown key's name is bounded by `unknownKeyMessage`.
 */
export function parseSdkSettings(doc: unknown): SettingSource[] {
  if (!isRecord(doc)) throw new SdkSettingsError('settings root must be a JSON object');
  const sdk = doc['sdk'];
  if (sdk === undefined) return [];
  if (!isRecord(sdk)) throw new SdkSettingsError('sdk must be an object');
  const [unknown] = unknownKeys(sdk, SDK_KEYS);
  if (unknown !== undefined) throw new SdkSettingsError(unknownKeyMessage('sdk', unknown, SDK_KEYS));
  const list = sdk['settingSources'];
  if (list === undefined) return [];
  if (!Array.isArray(list) || !list.every(isSettingSource) || new Set<unknown>(list).size !== list.length) {
    throw new SdkSettingsError(SDK_SETTING_SOURCES_MESSAGE);
  }
  return [...list];
}

/**
 * True when a settings document carries an OWN `sdk` key, whatever its
 * value: the project layer's only sdk behaviour is one warning (D-2).
 */
export function hasSdkKey(doc: unknown): boolean {
  return isRecord(doc) && Object.prototype.hasOwnProperty.call(doc, 'sdk');
}
