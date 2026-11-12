import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeControlChars, stripBidi, truncateTailWellFormed } from '../internal/sanitize.js';
import { projectConfigDirs } from './agent-definitions.js';
import type { SettingSource } from './sdk-settings.js';

/**
 * Settings-env scan (issue #250, ADR-0040 D-8 as amended 12/11/2026).
 *
 * The harness turns the bundled CLI's background tasks off by forcing a
 * variable into the child's environment (`src/internal/child-env.ts`). The
 * CLI then applies the `env` block of each settings file it loads OVER its own
 * environment, so a block that names the variable, with any value, replaces
 * the harness's (OBSERVED, loopback mock API, CLI 2.1.312, 12/11/2026: a block
 * holding `""` or `"0"` in the user, project or local settings file under the
 * matching `sdk.settingSources` entry, and in the global config file under
 * the default isolation, each brought the unhooked stall notice back).
 *
 * This module lists the files whose `env` block the CLI applies for the chosen
 * sources and refuses the run when one of them names a forced variable. The
 * paths are a BINARY READING of CLI 2.1.312 (located by needle, not run,
 * except where the mock runs above exercised them). Two sources the CLI also
 * reads are out of reach of a file scan and are not covered: an OS-level
 * policy (a macOS managed preference, a Windows registry key) and settings a
 * server hands the CLI. Both are the machine administrator's.
 */

/** Which loader a file belongs to. `managed` and `global` load whatever the sources say. */
export type SettingsEnvSource = 'managed' | 'global' | SettingSource;

export interface SettingsEnvFile {
  readonly source: SettingsEnvSource;
  readonly path: string;
}

/**
 * `env`: the file parses and its top-level `env` object names a forced
 * variable. `unparsable`: the file is not a JSON object this scan can read
 * and its text names one, so the scan cannot vouch for it. `unreadable`: the
 * path exists and could not be read, or is over the size limit.
 */
export type SettingsEnvRefusalReason = 'env' | 'unparsable' | 'unreadable';

export interface SettingsEnvRefusal {
  readonly source: SettingsEnvSource;
  readonly path: string;
  readonly reason: SettingsEnvRefusalReason;
}

/** Fixed text: it names no variable and echoes no value (ADR-0031). */
export const SETTINGS_ENV_REFUSED_REASON =
  'A settings file the bundled CLI would load sets, in its env block, a variable the harness sets itself, and the file ' +
  'would win: remove that entry, or drop the setting source (#250)';

const MAX_LISTED_REFUSALS = 8;
const MAX_REPORTED_PATH = 200;
/** The global config file holds per-project state and can run to megabytes; past this the scan refuses rather than reads. */
export const SETTINGS_ENV_MAX_FILE_BYTES = 32 * 1024 * 1024;

const reportPath = (path: string): string => truncateTailWellFormed(stripBidi(sanitizeControlChars(path)), MAX_REPORTED_PATH - 1);

export class SettingsEnvRefused extends Error {
  readonly refusals: readonly SettingsEnvRefusal[];
  constructor(refusals: readonly SettingsEnvRefusal[]) {
    const listed = refusals.slice(0, MAX_LISTED_REFUSALS).map((r) => `${r.source}:${reportPath(r.path)} (${r.reason})`);
    const more = refusals.length > MAX_LISTED_REFUSALS ? `; and ${refusals.length - MAX_LISTED_REFUSALS} more` : '';
    super(`settings env refused: ${listed.join('; ')}${more}. ${SETTINGS_ENV_REFUSED_REASON}`);
    this.name = 'SettingsEnvRefused';
    this.refusals = [...refusals];
  }
}

export interface SettingsEnvFilesInput {
  readonly settingSources: readonly SettingSource[];
  readonly cwd: string;
  readonly homeDir: string;
  readonly env: { readonly CLAUDE_CONFIG_DIR?: string | undefined };
  readonly managedDir: string;
}

/** The global config file's name suffixes (`mV()` in the 2.1.312 binary, read): one per OAuth environment. */
const GLOBAL_CONFIG_SUFFIXES = ['', '-custom-oauth', '-local-oauth', '-staging-oauth'] as const;

function managedFiles(managedDir: string): SettingsEnvFile[] {
  const dropInDir = join(managedDir, 'managed-settings.d');
  let dropIns: string[] = [];
  try {
    dropIns = readdirSync(dropInDir).sort();
  } catch {
    // Absent or unlistable: the CLI reads no drop-in it cannot list either.
  }
  return [
    { source: 'managed', path: join(managedDir, 'managed-settings.json') },
    ...dropIns.map((name) => ({ source: 'managed' as const, path: join(dropInDir, name) })),
  ];
}

/**
 * Every file whose `env` block the CLI applies for these setting sources
 * (2.1.312, read). The lists over-approximate on purpose, since an extra file
 * can only add a refusal: both user file names (the second is used in one CLI
 * mode), every global-config suffix, and for `project` and `local` every
 * directory from cwd up to the git root where the CLI reads one or two.
 */
export function settingsEnvFiles(input: SettingsEnvFilesInput): SettingsEnvFile[] {
  const configured = input.env.CLAUDE_CONFIG_DIR;
  const hasConfigDir = configured !== undefined && configured !== '';
  const configDir = hasConfigDir ? configured : join(input.homeDir, '.claude');
  const globalDir = hasConfigDir ? configured : input.homeDir;
  const files: SettingsEnvFile[] = [
    ...managedFiles(input.managedDir),
    { source: 'global', path: join(configDir, '.config.json') },
    ...GLOBAL_CONFIG_SUFFIXES.map((suffix) => ({ source: 'global' as const, path: join(globalDir, `.claude${suffix}.json`) })),
  ];
  if (input.settingSources.includes('user')) {
    files.push({ source: 'user', path: join(configDir, 'settings.json') }, { source: 'user', path: join(configDir, 'cowork_settings.json') });
  }
  const projectDirs = input.settingSources.includes('project') || input.settingSources.includes('local') ? projectConfigDirs(input.cwd, input.homeDir) : [];
  if (input.settingSources.includes('project')) files.push(...projectDirs.map((dir) => ({ source: 'project' as const, path: join(dir, 'settings.json') })));
  if (input.settingSources.includes('local')) files.push(...projectDirs.map((dir) => ({ source: 'local' as const, path: join(dir, 'settings.local.json') })));
  return files;
}

const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);
const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && MISSING_CODES.has(String((error as { code?: unknown }).code));

/** The text with JSON `\uXXXX` escapes decoded, upper-cased: the only escape that can spell a variable name. */
const comparable = (text: string): string =>
  text.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16))).toUpperCase();

function textVerdict(raw: string, forced: readonly string[]): SettingsEnvRefusalReason | null {
  const upper = comparable(raw);
  if (!forced.some((key) => upper.includes(key))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'unparsable';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'unparsable';
  if (!Object.hasOwn(parsed, 'env')) return null;
  const env: unknown = (parsed as Record<string, unknown>)['env'];
  if (typeof env !== 'object' || env === null || Array.isArray(env)) return null;
  return Object.keys(env).some((name) => forced.includes(name.toUpperCase())) ? 'env' : null;
}

export interface SettingsEnvScanLimits {
  readonly maxFileBytes?: number;
}

/**
 * Refusals for the files that name a forced variable. Per file:
 * - missing: skipped (the CLI loads nothing from it);
 * - present but unreadable, or over the size limit: refused, since the scan
 *   cannot vouch for it;
 * - text that names no forced variable, in any letter case and after `\u`
 *   escapes are decoded: passed without parsing, whatever its syntax (the CLI
 *   cannot find a name the text does not hold);
 * - a JSON object: refused when its own top-level `env` object has a key that
 *   is a forced variable, whatever the value; a mention anywhere else passes;
 * - anything else that names one (not JSON, or JSON that is not an object):
 *   refused. The CLI's parser is not this one, so a file this scan cannot
 *   read the way the CLI does is not waved through.
 * Names compare without regard to case, which over-refuses on a
 * case-sensitive platform and is exact on Windows.
 */
export function scanSettingsEnv(
  files: readonly SettingsEnvFile[],
  forcedKeys: readonly string[],
  limits: SettingsEnvScanLimits = {},
): SettingsEnvRefusal[] {
  const forced = forcedKeys.map((key) => key.toUpperCase());
  if (forced.length === 0) return [];
  const maxFileBytes = limits.maxFileBytes ?? SETTINGS_ENV_MAX_FILE_BYTES;
  const refusals: SettingsEnvRefusal[] = [];
  for (const file of files) {
    let raw: string;
    try {
      if (statSync(file.path).size > maxFileBytes) {
        refusals.push({ ...file, reason: 'unreadable' });
        continue;
      }
      raw = readFileSync(file.path, 'utf8');
    } catch (error: unknown) {
      if (!isMissing(error)) refusals.push({ ...file, reason: 'unreadable' });
      continue;
    }
    const reason = textVerdict(raw, forced);
    if (reason !== null) refusals.push({ ...file, reason });
  }
  return refusals;
}
