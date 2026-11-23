import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { CHILD_ENV_NAME_POLICY } from '../internal/child-env.js';
import {
  ALL_SETTING_SOURCES,
  managedDropInDir,
  mergeMarkerEntries,
  readSettingsChangeMarker,
  REFUSED_SETTINGS_KEYS,
  reportSettingsPath,
  SETTINGS_CHANGE_MARKER_MAX_ENTRIES,
  settingsChangeMarkerPath,
  settingsEnvFiles,
  settingsFingerprint,
  takeSettingsSnapshot,
  UNKNOWN_BASELINE,
  updateSettingsChangeMarker,
} from '../security/index.js';
import type { SettingsChange, SettingsEnvFile, SettingsEnvSource, SettingsSnapshotOptions } from '../security/index.js';
import { settingsFilesInputFor } from './settings-env-gate.js';
import type { ChildKillOutcome, ChildOwner } from './child-process.js';
import { describeError } from './describe-error.js';
import type { SdkConfigChangeCallback, SdkConfigChangeOutput, SdkPreToolDenyOutput, SettingsWatch } from './types.js';

/**
 * The settings-change stop (issue #264; ADR-0040 D-8 as amended 23/11/2026,
 * owner rulings of that day).
 *
 * The settings-env scan and self-protection both work from one list of the
 * files the bundled CLI loads as settings. The scan reads them once, before
 * the SDK is called, and self-protection refuses a tool call that NAMES one.
 * A call that names only a directory, an archive, a branch or a script puts
 * a file there all the same, and the CLI re-reads a settings file that
 * changes while it runs. So the session also watches the files for as long
 * as the child runs, in two layers that share this module, one stop and one
 * error class.
 *
 * Every OBSERVED below is a keyless run of 23/11/2026: a loopback mock of the
 * Messages API driving the real CLI 2.1.312 on macOS. The names in brackets
 * are run directories under `tasks/issue-264-evidence/`, which is not
 * tracked: `runs/` holds the design pass's runs on the build before this
 * change, some with a prototype of a layer in the probe's wrapper;
 * `impl/runs/` the runs of the first build of this change; `impl2/runs/`
 * and `impl3/runs/` the runs of this build.
 *
 * Layer 1, the CLI's own gate. The CLI calls its `ConfigChange` hooks when a
 * settings file it watches has changed and BEFORE it applies the file, and
 * does not apply a file a hook blocked (READ in the 2.1.312 binary; OBSERVED
 * on the build before, with a callback added by the probe: the event came
 * 1.0 to 1.1 s after the write, `runs/a2-cp-dir-cchook-log`, and with the
 * child killed inside the callback no hook in the written file ran in 15
 * runs of 15, the `runs/*cchook-kill*` and `runs/g-cc-kill-*` directories).
 * The session registers one callback: it kills the child and answers block.
 * The order is the CLI's, not a race, and it follows the CLI's own idea of
 * which files are settings. It is also the vendor's gate: a CLI that stops
 * calling it fails silently, it is blind when hooks are off, and it did not
 * fire for the global config file (OBSERVED, 1 run each,
 * `runs/i2-user-global-config-hot-env`, `runs/i3-default-global-config-hot-env`).
 *
 * Layer 2, the harness's re-check. A snapshot of the scan's list for every
 * source (`src/security/settings-snapshot.ts`), taken right after the scan
 * and compared on a timer, at the entry of every tool hook, at the result
 * message and at the end of the stream. The timer is what beats the reload:
 * the CLI waits until a changed file has been still for 1000 ms before it
 * runs the hooks and applies it (READ, the vendor's constant; nothing here
 * pins it), and the timer looks every `SETTINGS_RECHECK_MS`. It does not
 * depend on hooks. Hook points alone lose to one command that writes, waits
 * and writes again, and to a writer left in the background (OBSERVED with a
 * prototype that checked only at hook points: a hook in the written file ran
 * first in 4 runs of 4, `runs/b5-samecall-twowrites-postcheck`,
 * `runs/g-postonly-samecall-2` to `-4`, and in 1 of 1, `runs/c2-bg-postcheck`).
 *
 * The stop is the canary's: kill the child through the process the harness
 * started, then abort, then read no more. Aborting alone leaves the child
 * about two seconds (`hook-canary.ts`). After the kill the stop compares
 * every listed file once more and writes a marker that names all that
 * differs, each with its state at the start of the run. A later run is
 * refused until the file is back in that state or the operator deletes the
 * marker; a later write does not clear it, and a deleted file keeps
 * refusing (`src/security/settings-change-marker.ts`; owner rulings R2-1,
 * R2-2 and R2-5 of 23/11/2026). When a stop coincides with a missed hook
 * canary, the settings stop is the one the run ends with: it carries the
 * marker and stops an eval pack.
 *
 * OBSERVED with the tracked probe's `hot-*` scenarios and `control`. On
 * this build (`impl3/runs/`): 12 scenarios, 3 runs each, 36 runs of 36
 * ended with exit 2, the child ended by SIGKILL and no hook in the written
 * file run; three controls, 3 runs each, did not stop; the run after a stop
 * was refused in 4 runs of 4, one of them after a shell the stopped call
 * left behind had written the file again. On the second build
 * (`impl2/runs/`; the stubs were made in scratch copies of it, and the
 * guard, kill and compare are this build's): with layer 1 stubbed out,
 * layer 2 alone stopped 17 runs of 17 (`nol1-*`); with layer 2 stubbed out,
 * layer 1 alone stopped 15 of 17, the two global config scenarios being the
 * ones it cannot see (`nol2-*`); with the kill stubbed out the run still
 * ended with exit 2, and a `SessionEnd` hook in the written file ran in 4
 * runs of 6 (`nokill-*`): the kill is needed. On the first build only
 * (`impl/runs/`): with bare mode on and the canary stubbed out, the timer
 * stopped 6 runs of 6 with hooks off (`bare-nocanary-*`).
 *
 * What a stop does not do. It does not undo the write: the file is still
 * changed on disk. It kills the CLI process only: a process the agent
 * started is not reaped, and one that outlives the kill, or waits for the
 * harness to exit, can write afterwards. A file the stop recorded keeps
 * refusing the next run while the marker is there; a file first written
 * after the stop's last compare is not in the marker; and such a process
 * can delete the marker itself, after which the next run is not refused
 * (OBSERVED by the re-check of this change, 1 run,
 * `review2/recheck/runs/rc-unmark` and `rc-unmark-next`). Killing the
 * child's process group is the fix for that, and is not built. And it cannot tell who
 * wrote: the operator's editor, or another Claude Code session, changing a
 * listed file during a run stops that run (accepted by the owner).
 */

/** How often the re-check runs while the child is alive, in milliseconds. */
export const SETTINGS_RECHECK_MS = 250;

/** Fixed text: it names no file and echoes nothing from the run. The lines warned with it name the file. */
export const SETTINGS_CHANGED_REASON =
  "A settings file the bundled CLI loads, or a watched key of its global config file, changed while the run was in progress, so the run " +
  'was stopped. The harness cannot tell who changed it: the agent, a process the agent started, you in an editor and another Claude ' +
  'Code session editing the file all stop the run. The file is STILL changed on disk: read it before you start another Claude Code ' +
  'session or harness run. A process the agent started may still be running. The next run is refused until that file is back as it was ' +
  "at the start of this run, or you delete the marker file settings-changed.json in the harness's user directory, ~/.harness (#264)";

/** Fixed text for a run refused at its start because an earlier stop's marker still matches. */
export const SETTINGS_CHANGE_PENDING_REASON =
  'An earlier run was stopped because a settings file the bundled CLI loads changed during it, and that file is not back in the state ' +
  'it was in before that run. Read the file, then put it back as it was; or, if you want it as it is now, delete the marker file ' +
  "settings-changed.json in the harness's user directory, ~/.harness. Then run again (#264)";

/** Fixed text for a run refused at its start because the marker exists and cannot be read. */
export const SETTINGS_CHANGE_MARKER_UNREADABLE_REASON =
  "The marker file an earlier settings-change stop leaves (settings-changed.json in the harness's user directory, ~/.harness) exists and " +
  'cannot be read as one, so the harness cannot tell whether a changed settings file is still in place. Read the settings files the ' +
  'bundled CLI loads, then delete the marker file and run again (#264)';

/** Which control saw the change: the CLI's `ConfigChange` event, the harness's re-check, or the marker of an earlier stop. */
export type SettingsChangeLayer = 'config-change' | 'snapshot' | 'marker';

/**
 * Thrown by `Session.run` when a settings file the CLI loads changed during
 * the run (the run is stopped first; the stop hook and the telemetry rows are
 * still written), and at the start of a run while an earlier stop's marker
 * still matches. The message is one of three fixed texts.
 */
export class SettingsChangeDetected extends Error {
  readonly layer: SettingsChangeLayer;
  /** What the kill did; null for `marker`, where no child had been started. */
  readonly killOutcome: ChildKillOutcome | null;
  /** The changes seen. Paths are as found, not cleaned for printing. Empty when the CLI named no file and the re-check found none. */
  readonly changes: readonly SettingsChange[];
  constructor(layer: SettingsChangeLayer, killOutcome: ChildKillOutcome | null, changes: readonly SettingsChange[], reason: string = SETTINGS_CHANGED_REASON) {
    super(`settings changed: ${reason}`);
    this.name = 'SettingsChangeDetected';
    this.layer = layer;
    this.killOutcome = killOutcome;
    this.changes = [...changes];
  }
}

const SNAPSHOT_OPTIONS: SettingsSnapshotOptions = Object.freeze({ policy: CHILD_ENV_NAME_POLICY, refusedTopLevelKeys: REFUSED_SETTINGS_KEYS });

export interface SettingsWatchInput {
  readonly homeDir: string;
  readonly cwd: string;
  readonly env: { readonly CLAUDE_CONFIG_DIR?: string | undefined };
  readonly managedDir: string;
  /** Where the marker is. Default: `<homeDir>/.harness/settings-changed.json`. */
  readonly markerPath?: string;
  readonly now?: () => number;
}

/** The sources whose marker entries refuse EVERY run; a project or local entry refuses only a run whose own list holds its path (owner ruling R2-2). */
const EVERY_RUN_SOURCES: ReadonlySet<SettingsEnvSource> = new Set<SettingsEnvSource>(['user', 'global', 'managed']);

/**
 * The watch over real files. The list is the scan's own, for EVERY source,
 * whatever the run inherits: a file written where the run loads nothing is
 * loaded by the operator's next Claude Code session.
 */
export function createSettingsWatch(input: SettingsWatchInput): SettingsWatch {
  const markerPath = input.markerPath ?? settingsChangeMarkerPath(input.homeDir);
  const now = input.now ?? Date.now;
  const absolute = (path: string): string => resolve(input.cwd, path);
  /** This run's list, for every source, as absolute paths; read when asked, since the drop-in listing is part of it. */
  const listed = (): SettingsEnvFile[] =>
    settingsEnvFiles({ settingSources: ALL_SETTING_SOURCES, cwd: input.cwd, homeDir: input.homeDir, env: input.env, managedDir: input.managedDir }).map((file) => ({
      source: file.source,
      path: absolute(file.path),
    }));
  const dropInDir = absolute(managedDropInDir(input.managedDir));
  const atBaseline = (entry: SettingsChange): boolean => settingsFingerprint(entry, SNAPSHOT_OPTIONS) === entry.baseline;
  return {
    markerPath,
    pending: () => {
      const read = readSettingsChangeMarker(markerPath);
      if (read.state === 'absent') return [];
      if (read.state === 'unreadable') return 'unreadable';
      // The marker is rewritten only to drop an entry whose path is back at its start-of-run state; a path
      // that was written again, or deleted, keeps its entry (R2-1, R2-5).
      if (read.entries.some(atBaseline)) {
        try {
          updateSettingsChangeMarker(markerPath, (fresh) => (fresh.state === 'entries' ? fresh.entries.filter((entry) => !atBaseline(entry)) : null));
        } catch {
          // The cleared entries stay in the marker and are judged again, and found clear again, by the next run.
        }
      }
      const paths = new Set([...listed().map((file) => file.path), dropInDir]);
      return read.entries.filter((entry) => !atBaseline(entry) && (EVERY_RUN_SOURCES.has(entry.source) || paths.has(entry.path)));
    },
    snapshot: () => takeSettingsSnapshot(listed(), dropInDir, SNAPSHOT_OPTIONS),
    reported: (source, path) => {
      const subject = { source, path: absolute(path), kind: 'reported' as const };
      return { ...subject, fingerprint: settingsFingerprint(subject, SNAPSHOT_OPTIONS), baseline: UNKNOWN_BASELINE };
    },
    record: (changes) => {
      const detectedAt = new Date(now()).toISOString();
      const added = changes.map((change) => ({ ...change, detectedAt }));
      let held = 0;
      // A marker that cannot be read is replaced: what it held is lost, and the new entries refuse the next run as it would have.
      updateSettingsChangeMarker(markerPath, (read) => {
        const merged = mergeMarkerEntries(read.state === 'entries' ? read.entries : [], added);
        held = merged.length;
        return merged;
      });
      return held > SETTINGS_CHANGE_MARKER_MAX_ENTRIES ? 'over-cap' : 'ok';
    },
  };
}

/** The real watch for a home directory, for this process's cwd, env and platform, read when it is called. The CLI passes its `userDir` seam. */
export function settingsWatchFor(homeDir: string): SettingsWatch {
  const build = (): SettingsWatch => {
    // The same reading of cwd, config directory and managed directory as the start-of-run scan.
    const { cwd, env, managedDir } = settingsFilesInputFor(homeDir, ALL_SETTING_SOURCES);
    return createSettingsWatch({ homeDir, cwd, env, managedDir });
  };
  return {
    markerPath: settingsChangeMarkerPath(homeDir),
    pending: () => build().pending(),
    snapshot: () => build().snapshot(),
    reported: (source, path) => build().reported(source, path),
    record: (changes) => build().record(changes),
  };
}

/** The real watch for the current user's home directory. */
export function defaultSettingsWatch(): SettingsWatch {
  return settingsWatchFor(homedir());
}

const describeChange = (change: SettingsChange): string => `${change.source}:${reportSettingsPath(change.path)} (${change.kind})`;

/**
 * The start-of-run check: throws `SettingsChangeDetected` (layer `marker`)
 * while an earlier stop's marker still stands for this run, or cannot be
 * read. The lines that name the files go to `warn` first.
 */
export function assertNoPendingSettingsChange(watch: SettingsWatch, warn: (line: string) => void): void {
  const pending = watch.pending();
  if (pending === 'unreadable') {
    warn(`settings changed: the marker file at ${reportSettingsPath(watch.markerPath)} cannot be read`);
    throw new SettingsChangeDetected('marker', null, [], SETTINGS_CHANGE_MARKER_UNREADABLE_REASON);
  }
  if (pending.length === 0) return;
  for (const change of pending) warn(`settings changed: ${describeChange(change)} is not back in the state it was in before an earlier run was stopped`);
  warn(`settings changed: the marker file is ${reportSettingsPath(watch.markerPath)}`);
  throw new SettingsChangeDetected('marker', null, pending, SETTINGS_CHANGE_PENDING_REASON);
}

/** Where the re-check was made. */
export type SettingsCheckpoint = 'timer' | 'tool-hook' | 'config-change' | 'result' | 'stream-end';
/** The checks that end a run read a global config file whatever was read lately. */
const FORCED_CHECKPOINTS: ReadonlySet<SettingsCheckpoint> = new Set<SettingsCheckpoint>(['result', 'stream-end']);

/** A stop: the error the run ends with, and the lines to warn with. The child has been dealt with already. */
export interface SettingsStop {
  readonly error: SettingsChangeDetected;
  readonly warnings: readonly string[];
}

const KILL_WARNINGS: Readonly<Record<ChildKillOutcome, string>> = Object.freeze({
  killed: 'settings changed: the CLI process was killed at once',
  'not-owned': 'settings changed: the harness held no process to kill, so the CLI process was asked to stop and may have run for about two more seconds',
  'already-gone': 'settings changed: the CLI process had already exited',
  failed: 'settings changed: the CLI process could not be killed; it was asked to stop and may have run for about two more seconds',
});

const CHECKPOINT_TEXT: Readonly<Record<SettingsCheckpoint, string>> = Object.freeze({
  timer: "seen by the harness's re-check, on its timer",
  'tool-hook': "seen by the harness's re-check, at a tool hook",
  'config-change': "seen by the harness's re-check, when the CLI reported a change",
  result: "seen by the harness's re-check, at the result message",
  'stream-end': "seen by the harness's re-check, at the end of the run",
});
const AFTER_STOP_TEXT = "seen by the harness's re-check, just after the stop";

const STILL_CHANGED_WARNING = 'settings changed: the file is STILL changed on disk; read it before the next Claude Code session or harness run';
const WRITER_WARNING = 'settings changed: a process the agent started may still be running, and the harness has not stopped it';
const WHO_WARNING = 'settings changed: an operator or another Claude Code session editing the file during a run stops the run too';
const NO_MARKER_WARNING =
  'settings changed: no marker was written: no listed file differs from its state at the start of the run, and the CLI named no file the marker could hold. The next run will NOT be refused';

/** The `ConfigChange` sources that stop the run, as the scan's sources (owner ruling 3). `skills` is not one. */
const STOPPING_SOURCES: Readonly<Record<string, SettingsEnvSource>> = Object.freeze({
  user_settings: 'user',
  project_settings: 'project',
  local_settings: 'local',
  policy_settings: 'managed',
});
/** The one source that does not stop the run: left to a follow-up (owner ruling 3). */
const SKILLS_SOURCE = 'skills';
const SOURCE_NAME = /^[a-z_]{1,40}$/u;
const MAX_REPORTED_PATH_CHARS = 4096;

const BLOCK_OUTPUT: SdkConfigChangeOutput = Object.freeze({
  decision: 'block',
  reason: 'harness: a settings file changed during the run, so the run was stopped (#264)',
});

/** What a pre-tool hook answers once the run has been stopped: no further tool runs, whatever became of the kill. */
export const SETTINGS_STOP_DENY: SdkPreToolDenyOutput = Object.freeze({
  hookSpecificOutput: Object.freeze({
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'harness: a settings file changed during the run, so the run was stopped (#264)',
  }),
});

export interface SettingsGuard {
  /** Registered by the session under `ConfigChange`. */
  readonly configChangeCallback: SdkConfigChangeCallback;
  /** Starts the timer. It is unref'd, and cleared by a stop and by `dispose`. */
  start(): void;
  /**
   * The re-check. Null to carry on; otherwise the run has been stopped (now,
   * or earlier) and the caller ends it with `error`. After `dispose` it
   * compares nothing and returns what `stopped` does. Never throws.
   */
  check(at: SettingsCheckpoint): SettingsStop | null;
  /** The stop, once there has been one. Makes no check. */
  stopped(): SettingsStop | null;
  /** Clears the timer and ends the guard's work: no later call compares, kills or writes. Safe to call more than once. */
  dispose(): void;
}

/** The timer calls the guard makes; a seam for tests. */
export interface SettingsGuardTimers {
  setInterval(run: () => void, ms: number): { unref?: () => unknown };
  clearInterval(timer: { unref?: () => unknown }): void;
}

const NODE_TIMERS: SettingsGuardTimers = {
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
};

export interface SettingsGuardInput {
  readonly watch: SettingsWatch;
  /** The snapshot taken right after the start-of-run scan. */
  readonly snapshot: ReturnType<SettingsWatch['snapshot']>;
  readonly child: Pick<ChildOwner, 'kill'>;
  /** Called once, after the kill and the marker: the session aborts its query here. */
  readonly onStop: () => void;
  readonly intervalMs?: number;
  readonly timers?: SettingsGuardTimers;
}

/** One entry per path: a later sighting of a path replaces an earlier one. */
function byPath(changes: readonly SettingsChange[]): SettingsChange[] {
  return [...new Map(changes.map((change) => [change.path, change])).values()];
}

/** A fresh guard for one run, over the processes that run's owner holds. */
export function createSettingsGuard(input: SettingsGuardInput): SettingsGuard {
  const timers = input.timers ?? NODE_TIMERS;
  let timer: { unref?: () => unknown } | null = null;
  let stop: SettingsStop | null = null;
  let disposed = false;

  const clearTimer = (): void => {
    if (timer !== null) timers.clearInterval(timer);
    timer = null;
  };

  /** Every difference from the snapshot. A re-check that throws is not a clean one. */
  function compare(force: boolean): { changes: SettingsChange[]; failure: string | null } {
    try {
      return { changes: input.snapshot.changes(force), failure: null };
    } catch (error: unknown) {
      return { changes: [], failure: describeError(error) };
    }
  }

  /**
   * The one stop path. The kill comes FIRST, before anything is read or
   * written. Then every listed file is compared once more, so that the
   * marker and the lines name all that differs and not only what was seen
   * first; then the marker; then the session's abort. Never throws.
   */
  function stopRun(
    layer: Exclude<SettingsChangeLayer, 'marker'>,
    seen: string,
    found: readonly SettingsChange[],
    foundFailure: string | null,
    named: () => SettingsChange | null = () => null,
  ): SettingsStop {
    if (stop !== null) return stop;
    const outcome = input.child.kill();
    clearTimer();
    const after = compare(true);
    const reported = named();
    // The file the CLI named is recorded with what the snapshot knows of it; a path the snapshot also saw is its entry.
    const changes = byPath([...(reported === null ? [] : [reported]), ...found, ...after.changes]);
    const first = new Set(found.map((change) => change.path));
    const lines = changes.map((change) => `settings changed: ${describeChange(change)}, ${first.has(change.path) || change === reported ? seen : AFTER_STOP_TEXT}`);
    if (changes.length === 0) lines.push(`settings changed: no file could be named, ${seen}`);
    const failure = foundFailure ?? after.failure;
    if (failure !== null) lines.push(`settings changed: the re-check itself failed (${failure}), so the files could not be vouched for`);
    let markerLine: string;
    try {
      const recorded = changes.length > 0 ? input.watch.record(changes) : null;
      markerLine =
        recorded === null
          ? NO_MARKER_WARNING
          : recorded === 'over-cap'
            ? `settings changed: the marker file now holds more entries than it may (${SETTINGS_CHANGE_MARKER_MAX_ENTRIES}), so EVERY run is refused until you have read it and deleted it: ${reportSettingsPath(input.watch.markerPath)}`
            : `settings changed: the next run is refused until each file named above is back as it was at the start of this run, or the marker file is deleted: ${reportSettingsPath(input.watch.markerPath)}`;
    } catch (error: unknown) {
      markerLine = `settings changed: the marker file could not be written (${describeError(error)}), so the next run will NOT be refused`;
    }
    stop = {
      error: new SettingsChangeDetected(layer, outcome, changes),
      warnings: [...lines, KILL_WARNINGS[outcome], STILL_CHANGED_WARNING, WRITER_WARNING, WHO_WARNING, markerLine],
    };
    try {
      input.onStop();
    } catch {
      // The child has been dealt with and the stop is recorded; an abort that throws changes neither.
    }
    return stop;
  }

  function check(at: SettingsCheckpoint): SettingsStop | null {
    if (stop !== null || disposed) return stop;
    const { changes, failure } = compare(FORCED_CHECKPOINTS.has(at));
    if (changes.length === 0 && failure === null) return null;
    return stopRun('snapshot', CHECKPOINT_TEXT[at], changes, failure);
  }

  /** The path the CLI named, as a change to record, or null when it named none the marker could hold. */
  function reportedChange(source: SettingsEnvSource | undefined, path: unknown): SettingsChange | null {
    if (source === undefined || typeof path !== 'string' || path === '' || path.length > MAX_REPORTED_PATH_CHARS || path.includes('\0') || !isAbsolute(path)) return null;
    try {
      const change = input.watch.reported(source, path);
      return { ...change, baseline: input.snapshot.baselineOf(change.path) };
    } catch {
      return null;
    }
  }

  const configChangeCallback: SdkConfigChangeCallback = async (event) => {
    if (stop !== null) return BLOCK_OUTPUT;
    if (disposed) return {};
    let source = '';
    let path: unknown;
    try {
      source = typeof event.source === 'string' ? event.source : '';
      path = event.file_path;
    } catch {
      // An input that cannot be read is treated as a source the harness does not know: the run stops.
    }
    // A skill file changing is not a settings change (owner ruling 3); the re-check still runs.
    if (source === SKILLS_SOURCE) return check('config-change') === null ? {} : BLOCK_OUTPUT;
    const label = SOURCE_NAME.test(source) ? source : 'a source the harness does not know';
    // Nothing is read before the kill: what changed is gathered by the stop itself.
    stopRun('config-change', `reported by the CLI's ConfigChange event (${label}) before it applied the file`, [], null, () =>
      reportedChange(Object.hasOwn(STOPPING_SOURCES, source) ? STOPPING_SOURCES[source] : undefined, path),
    );
    return BLOCK_OUTPUT;
  };

  return {
    configChangeCallback,
    start: () => {
      if (timer !== null || stop !== null || disposed) return;
      timer = timers.setInterval(() => void check('timer'), input.intervalMs ?? SETTINGS_RECHECK_MS);
      timer.unref?.();
    },
    check,
    stopped: () => stop,
    dispose: () => {
      disposed = true;
      clearTimer();
    },
  };
}
