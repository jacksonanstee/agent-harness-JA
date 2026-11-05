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

const SDK_KEYS: readonly string[] = ['settingSources', 'allowedMcpServers'];

/** The one refusal for a bad MCP server list (#225). It never echoes a value (G-3). */
export const SDK_ALLOWED_MCP_SERVERS_MESSAGE =
  'sdk.allowedMcpServers must be an array of distinct MCP server names (letters, digits, "-" and single "_", 1-64 characters)';

/**
 * An MCP server name the harness can match as a whole `mcp__<server>__`
 * segment: letters, digits, `-`, and `_` only between two other characters
 * and never doubled, so the name cannot run into the `__` that ends the
 * segment. 1-64 characters. The other half of this naming contract is
 * `underListedServer` in unknown-tool-deny.ts: change both together.
 */
const MCP_SERVER_NAME = /^(?=.{1,64}$)[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMcpServerName(value: unknown): value is string {
  return typeof value === 'string' && MCP_SERVER_NAME.test(value);
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
  const sdk = sdkBlock(doc);
  if (sdk === undefined) return [];
  const list = sdk['settingSources'];
  if (list === undefined) return [];
  if (!Array.isArray(list) || !list.every(isSettingSource) || new Set<unknown>(list).size !== list.length) {
    throw new SdkSettingsError(SDK_SETTING_SOURCES_MESSAGE);
  }
  return [...list];
}

/**
 * Validates `sdk.allowedMcpServers` of a USER settings document (#225, ADR-0045):
 * the MCP servers whose tools `unknownToolDenyHook` lets through. Absent key,
 * absent list and `[]` all resolve to `[]`, which refuses every MCP tool:
 * the bundled CLI runs MCP servers no operator configured. Anything else must
 * be an array of distinct server names, returned as a fresh array in the
 * order written. The message is fixed and never echoes a value (G-3).
 */
export function parseSdkAllowedMcpServers(doc: unknown): string[] {
  const sdk = sdkBlock(doc);
  if (sdk === undefined) return [];
  const list = sdk['allowedMcpServers'];
  if (list === undefined) return [];
  if (!Array.isArray(list) || !list.every(isMcpServerName) || new Set<unknown>(list).size !== list.length) {
    throw new SdkSettingsError(SDK_ALLOWED_MCP_SERVERS_MESSAGE);
  }
  return [...list];
}

/** The validated `sdk` object of a settings document, or undefined when the key is absent. */
function sdkBlock(doc: unknown): Record<string, unknown> | undefined {
  if (!isRecord(doc)) throw new SdkSettingsError('settings root must be a JSON object');
  const sdk = doc['sdk'];
  if (sdk === undefined) return undefined;
  if (!isRecord(sdk)) throw new SdkSettingsError('sdk must be an object');
  const [unknown] = unknownKeys(sdk, SDK_KEYS);
  if (unknown !== undefined) throw new SdkSettingsError(unknownKeyMessage('sdk', unknown, SDK_KEYS));
  return sdk;
}

/**
 * True when a settings document carries an OWN `sdk` key, whatever its
 * value: the project layer's only sdk behaviour is one warning (D-2).
 */
export function hasSdkKey(doc: unknown): boolean {
  return isRecord(doc) && Object.prototype.hasOwnProperty.call(doc, 'sdk');
}
