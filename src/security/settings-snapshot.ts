import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs';
import { readSettingsBytes, SETTINGS_ENV_MAX_FILE_BYTES, settingsBytesVerdict } from './settings-env.js';
import type { SettingsEnvFile, SettingsEnvIo, SettingsEnvNamePolicy, SettingsEnvSource } from './settings-env.js';

/**
 * A snapshot of the settings files the bundled CLI loads, and the re-check
 * against it (issue #264; ADR-0040 D-8 as amended 23/11/2026).
 *
 * The settings-env scan reads these files once, before the SDK is called.
 * The CLI watches the directories that hold them and re-reads a file that
 * changes while it runs, so a file written during the run is applied without
 * the scan ever seeing it. The session takes this snapshot right after the
 * scan and compares the files with it for as long as the child runs; any
 * difference stops the run (`src/session/settings-watch.ts`).
 *
 * What is compared, per file on the scan's own list (`settingsEnvFiles`,
 * called with every source) and for the managed drop-in directory:
 * - appearance and deletion. A DIRECTORY appearing where a file is looked
 *   for is not a change: the CLI cannot load one;
 * - kind (regular file, symlink, directory, anything else);
 * - for a symlink the link text, and for every path that exists the real
 *   path it resolves to, so a link pointed elsewhere, a file swapped for a
 *   link and a parent directory swapped for a link all show;
 * - content, as the SHA-256 of the bytes the scan's bounded reader returns;
 * - the names in the managed drop-in directory.
 *
 * The global config file is the exception. The CLI writes that file itself
 * during an ordinary run, so its bytes change in every run and it may not
 * exist when the run starts. It is compared by a projection: the scan's
 * verdict on it, and a hash of the keys below, with object keys sorted and
 * empty values left out (so `"mcpServers": {}` and no key compare equal).
 * - at the top level: `env`, `mcpServers`, `hooks`, `permissions`,
 *   `bypassPermissionsModeAccepted` (`GLOBAL_WATCHED_KEYS`);
 * - under each entry of `projects`: `hasTrustDialogAccepted`,
 *   `allowedTools`, `mcpServers`, `enabledMcpjsonServers`,
 *   `disabledMcpjsonServers`, `enableAllProjectMcpServers`,
 *   `enabledMcpServers`, `disabledMcpServers`, `mcpContextUris`,
 *   `hasClaudeMdExternalIncludesApproved` (`GLOBAL_WATCHED_PROJECT_KEYS`;
 *   the names are READ in the 2.1.312 binary).
 * Nothing else in the file is compared: the CLI's own counters, ids, caches
 * and the other per-project state can change freely (owner ruling R2-6 of
 * 23/11/2026). An absent file, a directory at its path and a file with none
 * of those keys compare equal. A difference there is confirmed by a second
 * read a short while later (`GLOBAL_CONFIRM_MS`), so that a read which lands
 * in the middle of the CLI's own write does not stop a run; a precaution,
 * since no torn read was observed. While the CLI keeps rewriting the file,
 * a timer check re-reads it at most once per `GLOBAL_REREAD_MIN_MS`; the
 * checks at the result message and at the end of the stream always read.
 *
 * The stat fields (device, inode, size, modification and change times, in
 * nanoseconds) are a pre-filter only: a path whose fields are the ones last
 * seen is not read again. The modification time can be put back by whoever
 * wrote the file; the change time cannot without setting the clock, and it
 * is in the fields.
 */

export type SettingsFileKind = 'absent' | 'file' | 'symlink' | 'directory' | 'other';

/** What differed. `global-config` is the global config file's projection; `reported` is a path the CLI itself named (`settings-watch.ts`). */
export type SettingsChangeKind = 'appeared' | 'deleted' | 'kind' | 'symlink-target' | 'content' | 'global-config' | 'drop-in-listing' | 'reported';

export interface SettingsChange {
  readonly source: SettingsEnvSource;
  readonly path: string;
  readonly kind: SettingsChangeKind;
  /** The state seen at detection, as one string. For the operator; nothing compares it. */
  readonly fingerprint: string;
  /**
   * The state at the START of the run, in the same form: what the path must
   * be back at for the marker to let a later run start (owner ruling R2-1).
   * `UNKNOWN_BASELINE` for a path the snapshot did not hold.
   */
  readonly baseline: string;
}

/** The baseline of a path the snapshot did not hold. No state equals it, so such an entry is cleared only by deleting the marker. */
export const UNKNOWN_BASELINE = 'unknown';

/** The stat fields the pre-filter reads, as node returns them with `bigint: true`. */
export interface SnapshotStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

/** The fs calls a snapshot makes; a seam so a test can change a file between them, count them, and skip the wait. */
export interface SettingsSnapshotIo extends SettingsEnvIo {
  lstatSync(path: string): SnapshotStats;
  statSync(path: string): SnapshotStats;
  readlinkSync(path: string): string;
  realpathSync(path: string): string;
  readdirSync(path: string): string[];
  /** Blocks this thread for `ms`. Called once per changed global config file, to confirm the change. */
  sleepSync(ms: number): void;
  /** A clock in milliseconds, for the limit on re-reading a global config file. */
  now(): number;
}

/** How long the confirming read of a changed global config file waits. */
export const GLOBAL_CONFIRM_MS = 50;
/** The least time between two reads of one global config file on a check that is not forced. */
export const GLOBAL_REREAD_MIN_MS = 1000;

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
export const NODE_SNAPSHOT_IO: SettingsSnapshotIo = {
  openSync,
  fstatSync,
  readSync,
  closeSync,
  lstatSync: (path) => lstatSync(path, { bigint: true }),
  statSync: (path) => statSync(path, { bigint: true }),
  readlinkSync: (path) => readlinkSync(path),
  realpathSync: (path) => realpathSync(path),
  readdirSync: (path) => readdirSync(path),
  sleepSync: (ms) => void Atomics.wait(sleepCell, 0, 0, ms),
  now: () => Date.now(),
};

export interface SettingsSnapshotOptions {
  /** Which `env` names the scan refuses: the global config file's verdict is part of its projection. */
  readonly policy: SettingsEnvNamePolicy;
  /** As `SettingsEnvScanLimits.refusedTopLevelKeys`. */
  readonly refusedTopLevelKeys?: readonly string[];
  readonly maxFileBytes?: number;
  readonly io?: SettingsSnapshotIo;
}

/** One path's state. `statKey` is the pre-filter; `content` is what is compared. */
interface FileState {
  readonly kind: SettingsFileKind;
  readonly link: string | null;
  readonly real: string | null;
  readonly statKey: string;
  readonly content: string;
}

type CheapState = Omit<FileState, 'content'>;

const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);
const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && MISSING_CODES.has(String((error as { code?: unknown }).code));

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const statKeyOf = (stats: SnapshotStats): string => `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;

function attempt<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** Everything about a path that needs no read of its bytes. Never throws. */
function cheapState(path: string, io: SettingsSnapshotIo): CheapState {
  let stats: SnapshotStats;
  try {
    stats = io.lstatSync(path);
  } catch (error: unknown) {
    // A path that cannot be examined at all is not absent: it is something the snapshot cannot vouch for.
    return isMissing(error) ? { kind: 'absent', link: null, real: null, statKey: '' } : { kind: 'other', link: null, real: null, statKey: 'unexaminable' };
  }
  const real = attempt(() => io.realpathSync(path));
  if (stats.isSymbolicLink()) {
    const target = attempt(() => io.statSync(path));
    return { kind: 'symlink', link: attempt(() => io.readlinkSync(path)), real, statKey: `${statKeyOf(stats)}>${target === null ? 'dangling' : statKeyOf(target)}` };
  }
  const kind: SettingsFileKind = stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other';
  return { kind, link: null, real, statKey: statKeyOf(stats) };
}

/** JSON text with every object's keys sorted, so two spellings of one `env` object hash alike. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Top-level keys of the global config file that are compared (owner rulings
 * R2-6 and R3-3). `bypassPermissionsModeAccepted` is the consent the CLI
 * asks for before it honours its bypass mode (READ, 2.1.312).
 */
export const GLOBAL_WATCHED_KEYS: readonly string[] = Object.freeze(['env', 'mcpServers', 'hooks', 'permissions', 'bypassPermissionsModeAccepted']);
/**
 * Keys compared under each entry of the global config file's `projects`
 * object: trust, tool grants and MCP approvals. The last four were added by
 * owner ruling R3-3. All four are read from the PROJECT entry (READ in the
 * 2.1.312 binary: `enabledMcpServers` and `disabledMcpServers` switch the
 * CLI's own MCP servers on and off per project, and no top-level read of
 * either was found; `mcpContextUris` and
 * `hasClaudeMdExternalIncludesApproved` are in the project entry's
 * defaults).
 */
export const GLOBAL_WATCHED_PROJECT_KEYS: readonly string[] = Object.freeze([
  'hasTrustDialogAccepted',
  'allowedTools',
  'mcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'enableAllProjectMcpServers',
  'enabledMcpServers',
  'disabledMcpServers',
  'mcpContextUris',
  'hasClaudeMdExternalIncludesApproved',
]);

/** The projection of a file with none of the watched keys, and of an absent file. */
const NO_KEYS_PROJECTION = 'verdict:pass|keys:none';
const UTF8_BOM = '\uFEFF';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Nothing set: absent, null, false, an empty string, list or object. The CLI writes such defaults itself. */
const isEmptyValue = (value: unknown): boolean =>
  value === undefined || value === null || value === false || value === '' || (Array.isArray(value) && value.length === 0) || (isRecord(value) && Object.keys(value).length === 0);

/** The watched keys of `source` that hold something, or null when none does. */
function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | null {
  const kept = keys.filter((key) => Object.hasOwn(source, key) && !isEmptyValue(source[key])).map((key) => [key, source[key]] as const);
  return kept.length === 0 ? null : Object.fromEntries(kept);
}

/** The watched part of a parsed global config file, or null when it holds none of it. */
function watchedPart(parsed: Record<string, unknown>): Record<string, unknown> | null {
  const top = pick(parsed, GLOBAL_WATCHED_KEYS) ?? {};
  const projects = isRecord(parsed['projects']) ? parsed['projects'] : {};
  const watchedProjects = Object.entries(projects).flatMap(([path, entry]) => {
    const kept = isRecord(entry) ? pick(entry, GLOBAL_WATCHED_PROJECT_KEYS) : null;
    return kept === null ? [] : [[path, kept] as const];
  });
  // A `projects` value that is not an object is not something the CLI wrote: it is kept whole, so a change to it shows.
  const odd = Object.hasOwn(parsed, 'projects') && !isRecord(parsed['projects']) && !isEmptyValue(parsed['projects']) ? { projects: parsed['projects'] } : {};
  const part = { ...top, ...(watchedProjects.length === 0 ? odd : { projects: Object.fromEntries(watchedProjects) }) };
  return Object.keys(part).length === 0 ? null : part;
}

/**
 * What is compared of a global config file: the scan's verdict, and the
 * hash of its watched keys. Bytes that are not a JSON object are kept by
 * their own hash, so that a file this function cannot parse is still
 * compared by something: every change to it is then a change.
 */
function globalProjection(bytes: Buffer, options: SettingsSnapshotOptions): string {
  const verdict = settingsBytesVerdict(bytes, options.policy, options.refusedTopLevelKeys) ?? 'pass';
  const text = bytes.toString('utf8');
  if (text.trim() === '') return `verdict:${verdict}|keys:none`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.startsWith(UTF8_BOM) ? text.slice(1) : text);
  } catch {
    return `verdict:${verdict}|keys:unparsed:${sha256(bytes)}`;
  }
  if (!isRecord(parsed)) return `verdict:${verdict}|keys:unparsed:${sha256(bytes)}`;
  const part = watchedPart(parsed);
  return `verdict:${verdict}|keys:${part === null ? 'none' : sha256(canonical(part))}`;
}

/** What is compared for a path: a hash of its bytes, or for a global config file its projection. Never throws. */
function contentOf(file: SettingsEnvFile, cheap: CheapState, options: SettingsSnapshotOptions, io: SettingsSnapshotIo): string {
  const isGlobal = file.source === 'global';
  if (cheap.kind === 'absent') return isGlobal ? NO_KEYS_PROJECTION : 'absent';
  // A directory cannot be loaded as settings: for the global config file it reads as no file.
  if (cheap.kind === 'directory') return isGlobal ? NO_KEYS_PROJECTION : 'directory';
  if (cheap.kind === 'other') return 'unreadable';
  const read = readSettingsBytes(file.path, options.maxFileBytes ?? SETTINGS_ENV_MAX_FILE_BYTES, io);
  // A link that points at nothing: the CLI loads nothing through it.
  if (read === 'missing') return isGlobal ? NO_KEYS_PROJECTION : 'missing';
  if (read === 'unreadable') return 'unreadable';
  return isGlobal ? globalProjection(read, options) : `sha256:${sha256(read)}`;
}

const sameCheap = (a: CheapState, b: CheapState): boolean => a.kind === b.kind && a.link === b.link && a.real === b.real && a.statKey === b.statKey;

/** The path's state now. With `last`, a path whose pre-filter fields are the ones last seen keeps the content last read. */
function stateOf(file: SettingsEnvFile, options: SettingsSnapshotOptions, io: SettingsSnapshotIo, last?: FileState): FileState {
  const cheap = cheapState(file.path, io);
  if (last !== undefined && sameCheap(cheap, last)) return { ...cheap, content: last.content };
  return { ...cheap, content: contentOf(file, cheap, options, io) };
}

/** What differs between a path's state at the snapshot and now, or null. One line per compared attribute. */
function changeKindOf(source: SettingsEnvSource, before: FileState, now: FileState): SettingsChangeKind | null {
  if (source === 'global') return before.content === now.content ? null : 'global-config';
  if (before.kind === 'absent') return now.kind === 'absent' || now.kind === 'directory' ? null : 'appeared';
  if (now.kind === 'absent') return 'deleted';
  if (before.kind !== now.kind) return 'kind';
  if (before.link !== now.link || before.real !== now.real) return 'symlink-target';
  return before.content === now.content ? null : 'content';
}

/** A link's text can be as long as a path; its hash keeps a fingerprint short. */
const LINK_HASH_CHARS = 16;
const fileFingerprint = (source: SettingsEnvSource, state: FileState): string =>
  source === 'global' ? state.content : `${state.kind}|${state.link === null ? '' : sha256(state.link).slice(0, LINK_HASH_CHARS)}|${state.content}`;

/** The names in a directory as one string, or null when it cannot be listed (absent included). */
function listingOf(dir: string, io: SettingsSnapshotIo): string | null {
  const names = attempt(() => io.readdirSync(dir));
  return names === null ? null : [...names].sort().join('\0');
}

const listingFingerprint = (listing: string | null): string => (listing === null ? 'listing|unlistable' : `listing|${sha256(listing)}`);

/**
 * The present state of one path in the form the marker keeps: equal to the
 * entry's `baseline` once the path is back as it was at the start of the
 * run that saw it change. Never throws.
 */
export function settingsFingerprint(change: Pick<SettingsChange, 'source' | 'path' | 'kind'>, options: SettingsSnapshotOptions): string {
  const io = options.io ?? NODE_SNAPSHOT_IO;
  if (change.kind === 'drop-in-listing') return listingFingerprint(listingOf(change.path, io));
  return fileFingerprint(change.source, stateOf({ source: change.source, path: change.path }, options, io));
}

export interface SettingsSnapshot {
  /**
   * EVERY difference from the snapshot, in list order; empty when there is
   * none. `force` reads a global config file whatever was read lately: the
   * checks that end a run pass it. Never throws.
   */
  changes(force?: boolean): SettingsChange[];
  /** The start-of-run state of a path on the list, in the marker's form; `UNKNOWN_BASELINE` for any other path. */
  baselineOf(path: string): string;
  /** How many paths are compared (the drop-in directory not counted). */
  readonly size: number;
}

/**
 * The state of `files` and of the drop-in directory's listing, now. `files`
 * is the scan's list for EVERY source (`settingsEnvFiles` with
 * `ALL_SETTING_SOURCES`), so a file the run does not load is watched too: a
 * file written there is loaded by the operator's next session.
 */
export function takeSettingsSnapshot(files: readonly SettingsEnvFile[], dropInDir: string, options: SettingsSnapshotOptions): SettingsSnapshot {
  const io = options.io ?? NODE_SNAPSHOT_IO;
  const baseline = files.map((file) => ({ file, state: stateOf(file, options, io) }));
  const baseListing = listingOf(dropInDir, io);
  // The state last read per path: the pre-filter compares with it, so a file that changed once is not re-read on every check.
  const last = new Map<string, FileState>(baseline.map((entry) => [entry.file.path, entry.state]));
  // When each global config file was last read: the CLI rewrites it often, and it can be megabytes.
  const lastGlobalRead = new Map<string, number>();

  /** The path's state now, or null for a global config file that was read too lately to read again. */
  function stateNow(file: SettingsEnvFile, force: boolean): FileState | null {
    const previous = last.get(file.path);
    if (file.source !== 'global') return stateOf(file, options, io, previous);
    const cheap = cheapState(file.path, io);
    if (previous !== undefined && sameCheap(cheap, previous)) return { ...cheap, content: previous.content };
    const readAt = lastGlobalRead.get(file.path);
    if (!force && readAt !== undefined && io.now() - readAt < GLOBAL_REREAD_MIN_MS) return null;
    lastGlobalRead.set(file.path, io.now());
    return { ...cheap, content: contentOf(file, cheap, options, io) };
  }

  return {
    size: baseline.length,
    baselineOf: (path) => {
      if (path === dropInDir) return listingFingerprint(baseListing);
      const entry = baseline.find((held) => held.file.path === path);
      return entry === undefined ? UNKNOWN_BASELINE : fileFingerprint(entry.file.source, entry.state);
    },
    changes: (force = false) => {
      const found: SettingsChange[] = [];
      for (const { file, state: before } of baseline) {
        let now = stateNow(file, force);
        if (now === null) continue;
        last.set(file.path, now);
        let kind = changeKindOf(file.source, before, now);
        if (kind !== null && file.source === 'global') {
          io.sleepSync(GLOBAL_CONFIRM_MS);
          now = stateOf(file, options, io);
          last.set(file.path, now);
          kind = changeKindOf(file.source, before, now);
        }
        if (kind !== null) found.push({ source: file.source, path: file.path, kind, fingerprint: fileFingerprint(file.source, now), baseline: fileFingerprint(file.source, before) });
      }
      const listing = listingOf(dropInDir, io);
      if (listing !== baseListing) {
        found.push({ source: 'managed', path: dropInDir, kind: 'drop-in-listing', fingerprint: listingFingerprint(listing), baseline: listingFingerprint(baseListing) });
      }
      return found;
    },
  };
}
