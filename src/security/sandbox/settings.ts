import {
  boundEcho,
  loadJsonSettings,
  unknownKeyMessage,
  unknownKeys,
} from '../../internal/settings.js';
import { hasGlobCharacter } from './sandbox.js';
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

/**
 * The known keys at each object level inside `sandbox`. An unknown key at
 * either level is an error (ADR-0034 decision 1): `sandbox.path` (a typo of
 * `paths`) left the dimension off, and `alow` beside a valid `allow` was
 * dropped, each with no signal (issue #85). Root-level siblings of `sandbox`
 * stay ignored (ADR-0014 §5's forward-compatibility rule, root only).
 */
const SANDBOX_KEYS: readonly string[] = ['paths', 'commands'];
const ALLOWLIST_KEYS: readonly string[] = ['allow'];

function rejectUnknownKeys(
  record: Record<string, unknown>,
  known: readonly string[],
  where: string,
): void {
  const [first] = unknownKeys(record, known);
  if (first !== undefined) {
    throw new SandboxSettingsError(unknownKeyMessage(where, first, known));
  }
}

function parseAllowlist(value: unknown, key: string): SandboxAllowlist {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SandboxSettingsError(`sandbox.${key} must be an object`);
  }
  rejectUnknownKeys(value as Record<string, unknown>, ALLOWLIST_KEYS, `sandbox.${key}`);
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
    // A glob-shaped COMMAND entry names one program and the executing shell
    // starts another: `/bin/s?` passes the shell-runner blocklist as written
    // and expands to `/bin/sh` (issue #93, ADR-0034 decision 2). The gate
    // refuses the same characters in argv[0] with the same predicate. Path
    // entries are prefix-matched, so a glob there is inert (fail closed) and
    // is not refused here.
    if (key === 'commands' && hasGlobCharacter(entry)) {
      throw new SandboxSettingsError(
        `sandbox.commands.allow[${index}] '${boundEcho(entry)}' contains a glob character; the shell would expand it to a different program from the one the entry names (ADR-0034)`,
      );
    }
    return entry;
  });
  return { allow: entries };
}

/**
 * Validates the `sandbox` key of a settings document. Absent key → `{}`
 * (sandbox off). Bad entries under `sandbox` are errors, never skipped, and
 * since ADR-0034 that includes an unknown key at either level: silently
 * dropping part of a security config fails open, and before issue #85 this
 * parser did exactly that while its comment said otherwise.
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
  rejectUnknownKeys(sandbox as Record<string, unknown>, SANDBOX_KEYS, 'sandbox');
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
    SandboxSettingsError,
  );
}
