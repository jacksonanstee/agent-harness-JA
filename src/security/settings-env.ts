import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from 'node:fs';
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
 * path exists and could not be read, is not a regular file (a directory, a
 * FIFO, a device; a symlink is followed first), or is over the size limit.
 * `encoding`: the bytes are not UTF-8 text this scan can search (a UTF-16 or
 * UTF-32 byte-order mark, or any NUL byte).
 */
export type SettingsEnvRefusalReason = 'env' | 'setting' | 'unparsable' | 'unreadable' | 'encoding';

/**
 * Top-level settings keys that refuse a run when a settings file the CLI would
 * load sets them. `autoMemoryDirectory` moves the CLI's memory to a directory
 * self-protection does not know; an ungranted Write there succeeded (OBSERVED,
 * loopback mock, CLI 2.1.312, 13/11/2026, user settings under an inherited
 * `user` source; with no source inherited the same Write was refused).
 */
export const REFUSED_SETTINGS_KEYS: readonly string[] = Object.freeze(['autoMemoryDirectory']);

/** The fixed reason for a `setting` refusal. It names the key and echoes no value. */
export const SETTINGS_KEY_REFUSED_REASON =
  "A settings file the bundled CLI would load sets autoMemoryDirectory, which moves the CLI's memory outside the " +
  'directories the harness protects: remove that key, or drop the setting source';

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
    const reasons = [
      ...(refusals.some((r) => r.reason !== 'setting') ? [SETTINGS_ENV_REFUSED_REASON] : []),
      ...(refusals.some((r) => r.reason === 'setting') ? [SETTINGS_KEY_REFUSED_REASON] : []),
    ];
    super(`settings env refused: ${listed.join('; ')}${more}. ${reasons.join(' ')}`);
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

function textVerdict(raw: string, forced: readonly string[], settingKeys: readonly string[]): SettingsEnvRefusalReason | null {
  const upper = comparable(raw);
  if (!forced.some((key) => upper.includes(key)) && !settingKeys.some((key) => upper.includes(key))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'unparsable';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'unparsable';
  if (Object.keys(parsed).some((name) => settingKeys.includes(name.toUpperCase()))) return 'setting';
  if (!Object.hasOwn(parsed, 'env')) return null;
  const env: unknown = (parsed as Record<string, unknown>)['env'];
  if (typeof env !== 'object' || env === null || Array.isArray(env)) return null;
  return Object.keys(env).some((name) => forced.includes(name.toUpperCase())) ? 'env' : null;
}

/** The four fs calls the bounded read makes; a seam so a test can change the file between them. */
export interface SettingsEnvIo {
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): { isFile(): boolean };
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: null): number;
  closeSync(fd: number): void;
}

const NODE_IO: SettingsEnvIo = { openSync, fstatSync, readSync, closeSync };
/** Bytes asked for per read call. Memory follows the file, never the limit. */
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * The file's bytes, `'missing'`, or `'unreadable'`. A symlink is followed, as
 * the CLI follows it. The path is opened without blocking and judged on the
 * open descriptor, so a FIFO put there cannot hang the scan and the file
 * checked is the file read. Only a regular file is read. It is read in chunks
 * to END OF FILE, not to the size a stat reported, so bytes appended after
 * the stat are read too; the read stops, as `'unreadable'`, once it holds one
 * byte more than `maxBytes`.
 */
function readBounded(path: string, maxBytes: number, io: SettingsEnvIo): Buffer | 'missing' | 'unreadable' {
  let fd: number;
  try {
    // O_NONBLOCK is absent on Windows, where there is no FIFO to block on.
    fd = io.openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error: unknown) {
    return isMissing(error) ? 'missing' : 'unreadable';
  }
  try {
    if (!io.fstatSync(fd).isFile()) return 'unreadable';
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
      const read = io.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) return Buffer.concat(chunks, total);
      chunks.push(chunk.subarray(0, read));
      total += read;
    }
    return 'unreadable';
  } catch {
    return 'unreadable';
  } finally {
    io.closeSync(fd);
  }
}

/**
 * True for bytes the CLI may decode differently from a UTF-8 read: a UTF-16
 * or UTF-32 byte-order mark, or any NUL byte (UTF-16 and UTF-32 text without
 * a mark is full of them, and JSON text has none). OBSERVED by the security
 * re-review (mock API, CLI 2.1.312, 12/11/2026): the CLI applied the env block of
 * a UTF-16LE settings file whose UTF-8 reading never spells the variable. A
 * UTF-8 mark is not refused here; such a file is judged on its text.
 */
function isForeignEncoding(bytes: Buffer): boolean {
  const [a, b] = [bytes[0], bytes[1]];
  if ((a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff)) return true;
  return bytes.includes(0);
}

export interface SettingsEnvScanLimits {
  readonly maxFileBytes?: number;
  /** The fs calls to read with. Default: node's. A seam for tests. */
  readonly io?: SettingsEnvIo;
  /**
   * Top-level keys that refuse a file which sets them (reason `setting`),
   * compared without regard to case. Default: none. The session's gate passes
   * `REFUSED_SETTINGS_KEYS`.
   */
  readonly refusedTopLevelKeys?: readonly string[];
}

/**
 * Refusals for the files that name a forced variable. Per file:
 * - missing: skipped (the CLI loads nothing from it);
 * - present but unreadable, not a regular file, or over the size limit:
 *   refused, since the scan cannot vouch for it;
 * - a UTF-16 or UTF-32 byte-order mark, or a NUL byte: refused, whatever the
 *   text says, since a UTF-8 search of it proves nothing;
 * - text that names no forced variable, in any letter case and after `\u`
 *   escapes are decoded: passed without parsing, whatever its syntax (the CLI
 *   cannot find a name the text does not hold);
 * - a JSON object: refused when one of its own top-level keys is a refused
 *   settings key (`refusedTopLevelKeys`), or when its own top-level `env`
 *   object has a key that is a forced variable, whatever the value; a mention
 *   anywhere else passes;
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
  const settingKeys = (limits.refusedTopLevelKeys ?? []).map((key) => key.toUpperCase());
  if (forced.length === 0 && settingKeys.length === 0) return [];
  const maxFileBytes = limits.maxFileBytes ?? SETTINGS_ENV_MAX_FILE_BYTES;
  const refusals: SettingsEnvRefusal[] = [];
  for (const file of files) {
    const read = readBounded(file.path, maxFileBytes, limits.io ?? NODE_IO);
    if (read === 'missing') continue;
    if (read === 'unreadable') {
      refusals.push({ ...file, reason: 'unreadable' });
      continue;
    }
    if (isForeignEncoding(read)) {
      refusals.push({ ...file, reason: 'encoding' });
      continue;
    }
    const raw = read.toString('utf8');
    const reason = textVerdict(raw, forced, settingKeys);
    if (reason !== null) refusals.push({ ...file, reason });
  }
  return refusals;
}
