import { spawn } from 'node:child_process';

import type { Readable } from 'node:stream';

import type { SdkSpawnedProcess, SdkSpawnOptions, SpawnChildFn } from './types.js';

/**
 * The harness starts the bundled CLI itself (issue #251; ADR-0040 D-8 as
 * amended 20/11/2026, owner ruling of that day).
 *
 * The SDK's `spawnClaudeCodeProcess` option replaces its own spawn: the SDK
 * builds the command, the arguments and the environment and hands them to
 * the function, which returns the process. Every bundled-CLI child the
 * harness starts (the primary session, the judge, the eval adversary) goes
 * through `spawnChildProcess`, so the harness holds the process object and
 * can kill it without being told a process id. The build before this asked
 * the SDK for the id through an option its declarations do not list, and a
 * run in which no id arrived could only be stopped by the SDK's abort, which
 * waits about two seconds (`hook-canary.ts` has the runs).
 *
 * What the SDK's own spawn did, and what this one does about it (READ,
 * sdk.mjs 0.3.312). It kept the tail of the child's stderr and put it in the
 * message of its exit error (`. stderr: ...`, 2,048 characters); under a
 * spawn function of the caller's it has no stderr to keep. So this module
 * drains the child's stderr as it arrives, keeps the last whole lines of it
 * within `STDERR_TAIL_MAX_BYTES`, and the session puts that tail on the error
 * the SDK throws when the child ended badly (owner ruling 20/11/2026). The
 * drain does not wait for a failure: an unread pipe fills, and a child that
 * writes more than the pipe holds would stop on the write. The SDK's spawn
 * also checked that the executable exists before starting it; here a missing
 * executable shows as the spawn's own error event.
 *
 * The tail is the CLI's own words, not the harness's, and the session does
 * not redact it: it goes where the SDK's tail went before this change, into
 * the message of the error `Session.run` rejects with, and a library caller
 * gets it as it is. The command line redacts that message at every place it
 * prints or stores it (`redactedErrorMessage` in `src/cli/shared.ts`; the
 * eval scorecard's cleaner).
 */

/**
 * Starts the CLI as the SDK's own spawn does (READ, sdk.mjs 0.3.312: the same
 * command, arguments, working directory, environment and signal, three
 * pipes, no shell, no window on Windows). Its stderr is drained from the
 * start into a bounded tail (`stderrTailOf`). The signal is the SDK's
 * forwarded one, which aborts only after its two-second grace.
 */
export const spawnChildProcess: SpawnChildFn = (options: SdkSpawnOptions): SdkSpawnedProcess => {
  const child = spawn(options.command, options.args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    signal: options.signal,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  drainStderr(child, child.stderr);
  return child;
};

/** How much of a child's stderr is kept: the last 4 KiB. */
export const STDERR_TAIL_MAX_BYTES = 4096;
/** How long a reader waits for a child's stderr to close before it takes the tail as it stands. The exit event can come first. */
const STDERR_SETTLE_MS = 250;

/** What stands in for a tail that is one line longer than the cap: no part of such a line can be shown safely. */
export const STDERR_LINE_TOO_LONG = '(the last line of stderr was longer than the kept tail, so none of it is shown)';

interface StderrState {
  tail: Buffer;
  /** Bytes read in all. More than the cap means the tail has been cut. */
  total: number;
  readonly closed: Promise<void>;
}
const stderrStates = new WeakMap<SdkSpawnedProcess, StderrState>();

/** One byte more than the tail is held: the byte before it says whether the tail starts on a whole line. */
const STDERR_HELD_BYTES = STDERR_TAIL_MAX_BYTES + 1;
const LINE_FEED = 0x0a;

/** The last `STDERR_HELD_BYTES` of `held` followed by `chunk`. A fresh buffer; neither input is changed. */
function keepLast(held: Buffer, chunk: Buffer): Buffer {
  const joined = Buffer.concat([held, chunk]);
  return joined.length <= STDERR_HELD_BYTES ? joined : Buffer.from(joined.subarray(joined.length - STDERR_HELD_BYTES));
}

/**
 * Reads the stream from now on, whatever happens to the child, and keeps the
 * last bytes. A read error is swallowed, however many come: the listener is
 * permanent, because an `error` event with no listener throws.
 *
 * When the child exits, the pipe is let go, as the SDK's own spawn does
 * (READ, sdk.mjs 0.3.312): a process the child left behind can hold the
 * write end open long after, and a pipe still being read would keep this
 * process alive with it (OBSERVED by the security review, `t-hang`: 6 s). It
 * is unref'd at once, so it no longer holds the event loop, and destroyed a
 * short while later, which gives bytes already written time to arrive.
 */
function drainStderr(child: SdkSpawnedProcess, stderr: Readable & { unref?: () => unknown }): void {
  const state: StderrState = {
    tail: Buffer.alloc(0),
    total: 0,
    closed: new Promise((resolve) => stderr.once('close', resolve)),
  };
  stderr.on('error', () => undefined);
  stderr.on('data', (chunk: Buffer | string) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    state.tail = keepLast(state.tail, bytes);
    state.total += bytes.length;
  });
  child.once('exit', () => {
    stderr.unref?.();
    setTimeout(() => stderr.destroy(), STDERR_SETTLE_MS).unref();
  });
  stderrStates.set(child, state);
}

/**
 * The kept tail of a child's stderr, as text. Waits a short while for the
 * stream to close, since the exit event can arrive before the last bytes.
 *
 * Once the tail has been cut, its first line is a partial one, and it is
 * dropped: the cut can land inside a secret, and the half that is left is
 * not something a redactor can recognise (OBSERVED by the security review,
 * run `headcut`: 88 characters of an API key survived that way). The same
 * drop removes a multi-byte character the cut broke. A cut that falls
 * exactly on a line break drops nothing. A tail that is all one line, with
 * or without a break at its end, has no whole line to show, and
 * `STDERR_LINE_TOO_LONG` stands in for it. Empty for a process `spawnChildProcess` did not start. Never throws.
 */
export async function stderrTailOf(child: SdkSpawnedProcess): Promise<string> {
  const state = stderrStates.get(child);
  if (state === undefined) return '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([state.closed, new Promise<void>((resolve) => (timer = setTimeout(resolve, STDERR_SETTLE_MS)))]);
  clearTimeout(timer);
  if (state.total <= STDERR_TAIL_MAX_BYTES) return state.tail.toString('utf8');
  // Cut: more than the cap was read, so what is held is the one byte before the tail, then the tail.
  const tail = state.tail.subarray(1);
  // The cut fell exactly on a line break: the tail starts on a whole line and nothing is dropped.
  if (state.tail[0] === LINE_FEED) return tail.toString('utf8');
  const text = tail.toString('utf8');
  const firstBreak = text.indexOf('\n');
  const whole = firstBreak < 0 ? '' : text.slice(firstBreak + 1);
  // Nothing whole is left when the tail is one over-long line, whether or not that line ends in a break.
  return whole.trim() === '' ? STDERR_LINE_TOO_LONG : whole;
}

/**
 * The error with the child's stderr tail on its message, as the SDK's own
 * spawn wrote it (`. stderr: ...`). The SAME object, so its class and stack
 * are the SDK's; only an `Error` with a non-empty tail is touched. Never
 * throws.
 */
export function withStderrTail<T>(error: T, tail: string): T {
  const text = tail.trim();
  try {
    if (error instanceof Error && text !== '') error.message = `${error.message}. stderr: ${text}`;
  } catch {
    // A message that cannot be written (a frozen error, a setter that throws): the error goes on as it was.
  }
  return error;
}

/** What became of the processes when the harness tried to kill them. */
export type ChildKillOutcome =
  /** SIGKILL was sent. */
  | 'killed'
  /** The harness started no process for this run, so there was nothing to signal. */
  | 'not-owned'
  /** Every process had already ended. */
  | 'already-gone'
  /** A process was still running and the signal could not be sent. */
  | 'failed';

/** The processes the harness started for one run of one child. */
export interface ChildOwner {
  /** Passed to the SDK as `spawnClaudeCodeProcess`. Starts the process and keeps it. */
  readonly spawn: SpawnChildFn;
  /** True once `spawn` has returned a process. */
  owned(): boolean;
  /**
   * Kill every process started, at once, and say what happened. Never throws.
   * SIGKILL cannot be caught, so the child gets no grace period. It reaches
   * the CLI process only: a process the CLI had started is not reaped by it.
   */
  kill(): ChildKillOutcome;
  /**
   * What a child that ended badly wrote last on stderr: the tail of the most
   * recent process that exited non-zero, or on a signal this owner did not
   * send. Empty when there is none. For the message of the SDK's exit error.
   */
  stderrTail(): Promise<string>;
}

function killOne(child: SdkSpawnedProcess): Exclude<ChildKillOutcome, 'not-owned'> {
  if (child.exitCode !== null || (child.signalCode ?? null) !== null) return 'already-gone';
  try {
    return child.kill('SIGKILL') ? 'killed' : 'failed';
  } catch {
    return 'failed';
  }
}

/** A fresh owner for one run. `spawnChild` is the seam the session's `spawnChild` dependency fills. */
export function createChildOwner(spawnChild: SpawnChildFn = spawnChildProcess): ChildOwner {
  const children: SdkSpawnedProcess[] = [];
  let killSent = false;
  const endedBadly = (child: SdkSpawnedProcess): boolean =>
    (child.exitCode !== null && child.exitCode !== 0) || (!killSent && (child.signalCode ?? null) !== null);
  return {
    spawn: (options) => {
      const child = spawnChild(options);
      children.push(child);
      return child;
    },
    owned: () => children.length > 0,
    kill: () => {
      if (children.length === 0) return 'not-owned';
      const outcomes = children.map(killOne);
      killSent = killSent || outcomes.includes('killed');
      if (outcomes.includes('failed')) return 'failed';
      return outcomes.includes('killed') ? 'killed' : 'already-gone';
    },
    stderrTail: async () => {
      const failed = children.filter(endedBadly).at(-1);
      return failed === undefined ? '' : stderrTailOf(failed);
    },
  };
}
