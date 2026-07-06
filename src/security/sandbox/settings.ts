import { loadJsonSettings } from '../../internal/settings.js';
import type { SandboxAllowlist, SandboxConfig } from './types.js';

/** Same fail-loud contract as PermissionSettingsError (ADR-0014 §6). */
export class SandboxSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxSettingsError';
  }
}

/** Same bound and rationale as permissions' MAX_RULES: project settings are attacker-influenced. */
export const MAX_ALLOW_ENTRIES = 1000;

function parseAllowlist(value: unknown, key: string): SandboxAllowlist {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SandboxSettingsError(`sandbox.${key} must be an object`);
  }
  const { allow } = value as Record<string, unknown>;
  if (!Array.isArray(allow)) {
    throw new SandboxSettingsError(`sandbox.${key}.allow must be an array`);
  }
  if (allow.length > MAX_ALLOW_ENTRIES) {
    throw new SandboxSettingsError(
      `sandbox.${key}.allow has ${allow.length} entries; the maximum is ${MAX_ALLOW_ENTRIES}`,
    );
  }
  const entries = allow.map((entry, index) => {
    if (typeof entry !== 'string' || entry === '') {
      throw new SandboxSettingsError(
        `sandbox.${key}.allow[${index}] must be a non-empty string`,
      );
    }
    return entry;
  });
  return { allow: entries };
}

/**
 * Validates the `sandbox` key of a settings document. Absent key → `{}`
 * (sandbox off). Bad entries under `sandbox` are errors, never skipped —
 * silently dropping part of a security config would fail open.
 */
export function parseSandboxSettings(doc: unknown): SandboxConfig {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new SandboxSettingsError('settings root must be a JSON object');
  }
  const sandbox = (doc as Record<string, unknown>)['sandbox'];
  if (sandbox === undefined) {
    return {};
  }
  if (typeof sandbox !== 'object' || sandbox === null || Array.isArray(sandbox)) {
    throw new SandboxSettingsError('sandbox must be an object');
  }
  const { paths, commands } = sandbox as Record<string, unknown>;
  return {
    ...(paths === undefined ? {} : { paths: parseAllowlist(paths, 'paths') }),
    ...(commands === undefined ? {} : { commands: parseAllowlist(commands, 'commands') }),
  };
}

/** Loads one sandbox settings layer via the shared internal loader. */
export function loadSandboxSettingsFile(
  path: string,
  readFile: (path: string) => string,
): SandboxConfig {
  return loadJsonSettings(
    path,
    readFile,
    parseSandboxSettings,
    {},
    (message) => new SandboxSettingsError(message),
  );
}
