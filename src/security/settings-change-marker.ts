import { randomBytes } from 'node:crypto';
import { closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { SettingsEnvSource } from './settings-env.js';
import type { SettingsChange, SettingsChangeKind } from './settings-snapshot.js';

/**
 * The marker a settings-change stop leaves behind (issue #264, owner ruling
 * 4 of 23/11/2026).
 *
 * When the session sees a settings file change during a run it stops the run
 * and leaves the file as it is: the harness does not write the operator's
 * Claude Code settings. The file is then still on disk for the next run, and
 * the start-of-run scan reads `env` blocks and one key, not hooks. So the
 * stop also writes this marker, under the harness's own user directory
 * (`<home>/.harness/settings-changed.json`). Each entry is a path, the state
 * it was in at the START of the run that saw it change (`baseline`), and the
 * state seen at the stop (`fingerprint`, for the operator; nothing compares
 * it).
 *
 * An entry clears in two ways only (owner ruling R2-1 of 23/11/2026): the
 * path is back in its start-of-run state, or the operator deletes the
 * marker. A later write does NOT clear it: a process the agent left running
 * can write the file again after the stop, and the first build, which
 * compared with the state seen at the stop, then dropped the entry and let
 * the next run load the rewritten file (OBSERVED by the security review,
 * loopback mock, CLI 2.1.312, `review1/sec/runs/m1-orphan-rewrite-1` and
 * `-next` under `tasks/issue-264-evidence/`, not tracked). A file that was
 * deleted keeps refusing until it is put back (R2-5). An entry for a path
 * the snapshot did not hold has no known start state and clears only with
 * the marker.
 *
 * Which runs an entry refuses is the session's rule (`settings-watch.ts`,
 * owner ruling R2-2): a user, global or managed entry refuses every run; a
 * project or local entry refuses the runs whose own list holds that path.
 *
 * Writers take a lock file beside the marker (`.lock`) around read, merge
 * and rename, so two runs that stop at once both keep their entries. The
 * lock holds its owner's token, a fresh random string, and is put in place
 * whole (a hard link from a file already written, which fails when a lock
 * exists). A holder removes the lock only while it still holds its own
 * token. A lock older than `MARKER_LOCK_STALE_MS` was left by a writer that
 * died, and is taken over by ONE waiter: the one that creates the claim file
 * named after the stale lock's token, checks the lock still holds that
 * token, and renames its own lock over it; every other waiter keeps
 * waiting. Staleness is judged from the lock's mtime before the token is
 * read, so a waiter whose view is outdated (or whose clock is ahead) can
 * still replace a lock another waiter has just taken, and one concurrent
 * entry may then be lost; a claim file left by a waiter that died is never
 * cleared, after which every update waits and writes without the lock.
 * Both are tracked with the process-group follow-up. A writer that cannot get the lock within `MARKER_LOCK_WAIT_MS`
 * writes anyway, since a marker that may lose a concurrent entry is better
 * than no marker. What this does not cover: a holder that is alive but
 * stalled for longer than the stale time can finish after its lock was
 * taken over.
 *
 * The marker never drops an entry. Past `SETTINGS_CHANGE_MARKER_MAX_ENTRIES`
 * it is still written whole, a reader takes it as unreadable, and every run
 * is then refused until the operator deals with it (owner ruling R3-4): a
 * cap that dropped the oldest entries would have been a third way to clear
 * one.
 *
 * The marker is under `.harness`, which self-protection refuses the agent's
 * writes to, as far as that guard reaches (ADR-0042).
 */

export const SETTINGS_CHANGE_MARKER_NAME = 'settings-changed.json';

/** Where the marker is for a home directory: beside the harness's user settings. */
export function settingsChangeMarkerPath(homeDir: string): string {
  return join(homeDir, '.harness', SETTINGS_CHANGE_MARKER_NAME);
}

export interface SettingsChangeMarkerEntry extends SettingsChange {
  /** When the change was seen, as an ISO timestamp. For the operator; nothing compares it. */
  readonly detectedAt: string;
}

/** Three states on purpose: a marker that cannot be read is not an empty one. */
export type SettingsChangeMarkerRead =
  | { readonly state: 'absent' }
  | { readonly state: 'entries'; readonly entries: readonly SettingsChangeMarkerEntry[] }
  | { readonly state: 'unreadable' };

const MARKER_VERSION = 1;
/** A marker is small; a larger file at its path is not one this module wrote. */
export const SETTINGS_CHANGE_MARKER_MAX_BYTES = 4 * 1024 * 1024;
/** Entries a reader accepts, one per path: far more than stops write. A marker with more is unreadable, which refuses every run; none is dropped. */
export const SETTINGS_CHANGE_MARKER_MAX_ENTRIES = 256;
const MAX_FIELD_CHARS = 4096;

const SOURCES: ReadonlySet<string> = new Set<SettingsEnvSource>(['managed', 'global', 'user', 'project', 'local']);
const KINDS: ReadonlySet<string> = new Set<SettingsChangeKind>(['appeared', 'deleted', 'kind', 'symlink-target', 'content', 'global-config', 'drop-in-listing', 'reported']);

const isBoundedString = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_CHARS;

function parseEntry(value: unknown): SettingsChangeMarkerEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { source, path, kind, fingerprint, baseline, detectedAt } = value as Record<string, unknown>;
  if (!isBoundedString(source) || !SOURCES.has(source)) return null;
  if (!isBoundedString(kind) || !KINDS.has(kind)) return null;
  if (!isBoundedString(path) || !isAbsolute(path) || path.includes('\0')) return null;
  if (!isBoundedString(fingerprint) || !isBoundedString(baseline) || !isBoundedString(detectedAt)) return null;
  return { source: source as SettingsEnvSource, path, kind: kind as SettingsChangeKind, fingerprint, baseline, detectedAt };
}

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && ['ENOENT', 'ENOTDIR'].includes(String((error as { code?: unknown }).code));

/**
 * The marker's entries. `absent` only when nothing is at the path. A path
 * that is not a regular file (a symlink included), is too large, is not this
 * module's JSON, holds one entry that does not validate, or holds more than
 * `maxEntries` entries, is `unreadable`:
 * the caller refuses the run rather than treat it as empty. Never throws.
 */
export function readSettingsChangeMarker(markerPath: string, maxEntries: number = SETTINGS_CHANGE_MARKER_MAX_ENTRIES): SettingsChangeMarkerRead {
  try {
    const stats = lstatSync(markerPath);
    if (!stats.isFile() || stats.size > SETTINGS_CHANGE_MARKER_MAX_BYTES) return { state: 'unreadable' };
  } catch (error: unknown) {
    return isMissing(error) ? { state: 'absent' } : { state: 'unreadable' };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { state: 'unreadable' };
    const { version, entries } = parsed as Record<string, unknown>;
    if (version !== MARKER_VERSION || !Array.isArray(entries) || entries.length > maxEntries) return { state: 'unreadable' };
    const read = Array.from(entries, parseEntry);
    if (read.some((entry) => entry === null)) return { state: 'unreadable' };
    return { state: 'entries', entries: read.filter((entry) => entry !== null) };
  } catch {
    return { state: 'unreadable' };
  }
}

/**
 * Writes the marker with exactly these entries, however many, or removes it
 * when there are none. The write goes to a new file beside it and is renamed into place, so
 * a reader sees the old marker or the new one, and a symlink left at the
 * marker's path is replaced, not followed. Throws when the directory cannot
 * be made or written.
 */
export function writeSettingsChangeMarker(markerPath: string, entries: readonly SettingsChangeMarkerEntry[]): void {
  if (entries.length === 0) {
    rmSync(markerPath, { force: true });
    return;
  }
  mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 });
  const temporary = `${markerPath}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: MARKER_VERSION, entries }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, markerPath);
  } catch (error: unknown) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** The entries with `added` merged in, one per path: a newer entry replaces the older one and KEEPS its baseline, the earliest start state on record. */
export function mergeMarkerEntries(
  existing: readonly SettingsChangeMarkerEntry[],
  added: readonly SettingsChangeMarkerEntry[],
): SettingsChangeMarkerEntry[] {
  const merged = new Map<string, SettingsChangeMarkerEntry>(existing.map((entry) => [entry.path, entry]));
  for (const entry of added) {
    const older = merged.get(entry.path);
    // Removed first, so the newer entry also moves to the end: the cap drops from the front.
    merged.delete(entry.path);
    merged.set(entry.path, older === undefined ? entry : { ...entry, baseline: older.baseline });
  }
  return [...merged.values()];
}

/** How long a writer waits for the lock before it writes without it. */
export const MARKER_LOCK_WAIT_MS = 2000;
/** A lock older than this was left by a writer that died; it is taken over. */
export const MARKER_LOCK_STALE_MS = 10_000;
const MARKER_LOCK_POLL_MS = 25;
const LOCK_OWNER_BYTES = 12;
const LOCK_HEX = /^[0-9a-f]{24}$/u;

/** The calls the lock waits with; a seam so a test can act while a writer waits. */
export interface MarkerLockIo {
  sleepSync(ms: number): void;
  now(): number;
  /** Called between a waiter's look at a stale lock and its claim on it. For a test that has another waiter act in that gap; unset otherwise. */
  beforeClaim?: () => void;
}
const lockCell = new Int32Array(new SharedArrayBuffer(4));
const NODE_LOCK_IO: MarkerLockIo = { sleepSync: (ms) => void Atomics.wait(lockCell, 0, 0, ms), now: () => Date.now() };

/** The token a lock file holds, or null when there is no lock or it holds none. */
function lockOwner(lockPath: string): string | null {
  try {
    const text = readFileSync(lockPath, 'utf8').trim();
    return LOCK_HEX.test(text) ? text : null;
  } catch {
    return null;
  }
}

/**
 * Takes over a stale lock, as the one waiter allowed to. The claim file is
 * named after the token the stale lock holds, and is created exclusively,
 * so of the waiters that saw that lock only one gets past it. That one
 * checks the lock still holds that token and renames its own lock file over
 * it, which replaces it in one step. A lock that holds no token (one that
 * is not this module's) is claimed under a fixed name. True when the lock is
 * now this writer's.
 */
function takeOverStale(lockPath: string, mine: string, owner: string, io: MarkerLockIo): boolean {
  const stale = lockOwner(lockPath);
  const claim = `${lockPath}.claim.${stale ?? 'untokened'}`;
  io.beforeClaim?.();
  try {
    closeSync(openSync(claim, 'wx', 0o600));
  } catch {
    return false;
  }
  try {
    // Another waiter may have claimed, taken over and let its claim go since the look above: then the lock is no longer the stale one.
    if (lockOwner(lockPath) !== stale) return false;
    renameSync(mine, lockPath);
    return lockOwner(lockPath) === owner;
  } catch {
    return false;
  } finally {
    rmSync(claim, { force: true });
  }
}

/** Takes the lock, waiting, and taking over a stale one. The token when it is held; null when the wait ran out, and the caller goes on without it. */
function acquireLock(lockPath: string, io: MarkerLockIo): string | null {
  const owner = randomBytes(LOCK_OWNER_BYTES).toString('hex');
  const mine = `${lockPath}.${owner}.tmp`;
  const deadline = io.now() + MARKER_LOCK_WAIT_MS;
  try {
    writeFileSync(mine, owner, { flag: 'wx', mode: 0o600 });
    for (;;) {
      try {
        // A hard link puts the lock in place already holding the token, and fails when a lock exists.
        linkSync(mine, lockPath);
        return owner;
      } catch {
        // Held by another writer, or stale: looked at below.
      }
      let age = 0;
      try {
        age = io.now() - lstatSync(lockPath).mtimeMs;
      } catch {
        // Gone between the two calls: the next try takes it.
      }
      if (age > MARKER_LOCK_STALE_MS && takeOverStale(lockPath, mine, owner, io)) return owner;
      if (io.now() >= deadline) return null;
      io.sleepSync(MARKER_LOCK_POLL_MS);
    }
  } catch {
    return null;
  } finally {
    rmSync(mine, { force: true });
  }
}

/**
 * Reads the marker, hands what was read to `update`, and writes what it
 * returns, all under the lock, so that a second writer's entries are read
 * before this one's are merged. `update` is handed every entry the marker
 * holds, past the reader's cap too, and returns null to leave the marker as
 * it is. The lock is removed afterwards only if it still holds this writer's
 * token. Throws when the directory cannot be made or the marker written.
 */
export function updateSettingsChangeMarker(
  markerPath: string,
  update: (read: SettingsChangeMarkerRead) => readonly SettingsChangeMarkerEntry[] | null,
  io: MarkerLockIo = NODE_LOCK_IO,
): void {
  mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 });
  const lockPath = `${markerPath}.lock`;
  const owner = acquireLock(lockPath, io);
  try {
    // Read without the entry cap: a writer merges into everything the marker holds, so that nothing is dropped.
    const next = update(readSettingsChangeMarker(markerPath, Number.POSITIVE_INFINITY));
    if (next !== null) writeSettingsChangeMarker(markerPath, next);
  } finally {
    // Another writer's lock is never removed: this one's may have been taken over while it worked.
    if (owner !== null && lockOwner(lockPath) === owner) rmSync(lockPath, { force: true });
  }
}
