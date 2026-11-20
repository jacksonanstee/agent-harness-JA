import type { ChildKillOutcome, ChildOwner } from './child-process.js';
import type { SdkUserPromptSubmitCallback } from './types.js';

/**
 * The hook canary and the child-stop rules (issue #251; ADR-0040 D-8 as
 * amended 13/11/2026 and 20/11/2026).
 *
 * Every model-facing control the session has is an SDK hook callback, and the
 * bundled CLI can be put in a mode where it runs none of them (see
 * `BARE_MODE_SWITCH` in `src/internal/child-env.ts`). The harness strips and
 * refuses the names it knows that do this. The canary is the check that does
 * not depend on knowing the name: the session registers one more callback, on
 * `UserPromptSubmit`, that does nothing but record that it ran. If the CLI
 * starts the turn and that callback has not run, hooks are off, whatever
 * turned them off, and the session stops the run.
 *
 * Every OBSERVED below is a keyless run of 20/11/2026: a loopback mock of the
 * Messages API driving the real CLI 2.1.312. The names in brackets are run
 * directories under `tasks/issue-251-evidence/impl2/out`, which is not
 * tracked. In the kill and abort runs the name stripping and the forced value were
 * stubbed out of a scratch copy of the build, so that bare mode could come on
 * and the canary was the only layer left.
 *
 * Where the session checks, and why. With hooks on, the callback ran BEFORE
 * the SDK's init message in every run looked at; with bare mode on, the init
 * message arrived and the callback never ran (OBSERVED; `r3-nostrip-control`,
 * `r3-nostrip-bare-kill-1` to `-6`). So the session checks when the init
 * message arrives, again when an assistant message arrives in case a CLI
 * sends no init message, and again at a result message and at the end of the
 * stream, so that no run completes with the callback silent (the last two
 * are from the code and its tests; no CLI was seen to skip the first two).
 *
 * The order is the CLI's, not a race between the two messages. The CLI WAITS
 * for the prompt hook's answer before it sends the init message: with the
 * callback held for 1.5 s the init message arrived 1.5 s later, after the
 * callback had returned (OBSERVED, 2 runs; `r3-hold1500-1`, `-2`). READ,
 * SDK 0.3.312: the SDK calls a hook callback from its control-request handler
 * with no timer before the call, and hands messages to the caller in the
 * order it read them. So a healthy CLI's init message cannot overtake the
 * callback, and the check needs no waiting period, which would be a window
 * for a tool to run in.
 *
 * How the session stops the child, and why aborting is not enough. The SDK's
 * abort closes the child's stdin and waits about two seconds before it
 * signals the process (READ: sdk.d.ts says so of `SpawnOptions.signal`;
 * sdk.mjs holds a 2000 ms timer before SIGTERM). In that window the child
 * carried on: with the abort alone the mock received the first request AND
 * the second, which carried the Read's raw result (OBSERVED, 3 runs of 3,
 * the kill stubbed out; `r3-nostrip-nokill-bare-abort-only-1` to `-3`). So
 * the session kills the child process itself, with SIGKILL, the moment the
 * check fails. With the kill the mock received NO request: the child died
 * before its first one (OBSERVED, 6 runs of 6, `r3-nostrip-bare-kill-1` to
 * `-6`, against a mock that answers at once, which is the hardest case; this
 * is still two processes racing, not an ordering the CLI guarantees).
 * SIGKILL reaches the CLI process only: a process the CLI had started is not
 * reaped by it. At the init message the CLI has run no tool, so it has none
 * of the agent's.
 *
 * The session can kill the child because it started it (owner ruling
 * 20/11/2026; `child-process.ts`): it passes the SDK's `spawnClaudeCodeProcess`
 * option, the SDK calls that in place of its own spawn, and the run's owner
 * keeps the process. Nothing has to be reported back. The build before asked
 * the SDK for the child's process id and killed by id; with no id it could
 * only abort, and a CLI with bare mode on then leaked in 4 runs of 4
 * (OBSERVED on that build; `nostrip-nopid-bare-1` to `-3`,
 * `final-nostrip-nopid-bare-1`).
 *
 * A turn that starts with no process held is stopped there, whether or not
 * the callback ran: the query function did not start its process through
 * the session's spawn function, so a CLI with its hooks off could not be
 * killed. The SDK called the function in every run made, so this is a
 * caller's own query function. That stop does NOT close the window for such
 * a CLI: nothing is held to signal, so the stop is the abort. OBSERVED with
 * the function withheld from the SDK: a healthy CLI was stopped with exit 2
 * (`r3-notowned-healthy`); a CLI with bare mode on was stopped with exit 2
 * as well, and in 3 runs of 3 the mock had by then received the second
 * request with the Read's raw result (`r3-nostrip-notowned-bare-1` to `-3`).
 * The rule's worth is that the first, healthy run of such a set-up fails,
 * and says why.
 *
 * Cost: a prompt the CLI handles without the model, and so without the prompt
 * hook, stops the run too (OBSERVED, 1 run; `r3-local-prompt`). A
 * harness run of such a prompt did nothing useful before.
 *
 * What reaches the endpoint before the check. With the traffic opt-out in
 * the operator's environment, nothing did. Without it a healthy CLI sent a
 * session-title request before its init message, carrying the operator's
 * prompt and no tool (OBSERVED; `after-control-notraffic-1`, `-2`,
 * `r3-control-notraffic`),
 * and so did a run of a prompt the CLI handles without the model, which the
 * canary then stopped (`after-local-prompt-notraffic`). A CLI with bare mode
 * on sent no request before the kill without the opt-out either (OBSERVED,
 * 3 runs of 3; `r3-nostrip-bare-kill-notraffic-1` to `-3`).
 *
 * The tool-less children (the judge, the eval adversary) carry no canary:
 * their only hook is a deny-all behind `tools: []`, and with bare mode on
 * their init message still listed no tool (OBSERVED on the build before this
 * change, which did not hold bare mode off; `before-judge-at`,
 * `before-adversary-at`), so there is no tool call or tool result for a
 * missing hook to let through.
 */

/** Fixed text: it names no variable and echoes nothing from the run. */
export const HOOK_CANARY_REASON =
  "The bundled CLI began the turn without running the harness's prompt hook, so its hooks are off and no tool call or " +
  'tool result would be checked. The run was stopped. Look for a CLI setting or environment variable that disables ' +
  'hooks, or a prompt the CLI handles without the model (#251)';

/** Fixed text for a turn that starts with no process started through the harness's spawn function. */
export const CHILD_NOT_OWNED_REASON =
  "The bundled CLI was not started through the harness's spawn function before the turn started, so the harness holds " +
  'no process it could kill at once if the hooks turned out to be off. The run was stopped. A query function of your ' +
  'own must start its process by calling options.spawnClaudeCodeProcess, as the SDK does (#251)';

/** Said with the not-owned stop: that stop is the SDK's abort, and the child is not gone when the run ends. */
const NOT_OWNED_STOP_WARNING =
  'child not owned: the harness holds no process to signal, so the CLI process was asked to stop and may have run for about two more seconds';

const KILL_WARNINGS: Readonly<Record<ChildKillOutcome, string>> = Object.freeze({
  killed: 'hook canary missed: the CLI process was killed at once',
  'not-owned': 'hook canary missed: the harness held no process to kill, so the CLI process was asked to stop and may have run for about two more seconds',
  'already-gone': 'hook canary missed: the CLI process had already exited',
  failed: 'hook canary missed: the CLI process could not be killed; it was asked to stop and may have run for about two more seconds',
});

/** Thrown by `Session.run` when the canary did not fire. The run is stopped first; the stop hook and the telemetry rows are still written. */
export class HookCanaryMissed extends Error {
  /** What the kill did. */
  readonly killOutcome: ChildKillOutcome;
  /** True when SIGKILL was sent, or every process had already exited: no CLI process was left running. */
  readonly childKilled: boolean;
  constructor(killOutcome: ChildKillOutcome) {
    super(`hook canary missed: ${HOOK_CANARY_REASON}`);
    this.name = 'HookCanaryMissed';
    this.killOutcome = killOutcome;
    this.childKilled = killOutcome === 'killed' || killOutcome === 'already-gone';
  }
}

/** Thrown by `Session.run` when the turn starts and the query function has started no process through the harness's spawn function. */
export class ChildNotOwned extends Error {
  constructor() {
    super(`child not owned: ${CHILD_NOT_OWNED_REASON}`);
    this.name = 'ChildNotOwned';
  }
}

/** Where in the stream the session asks. `turn-start` is an init or an assistant message. */
export type CanaryCheckpoint = 'turn-start' | 'result' | 'stream-end';

/** A failed check: the error the run ends with, and the lines to warn with. The child has been dealt with already. */
export interface CanaryStop {
  readonly error: HookCanaryMissed | ChildNotOwned;
  readonly warnings: readonly string[];
}

export interface HookCanary {
  /** Registered by the session under `UserPromptSubmit`. Reads nothing; returns an empty output, which leaves the prompt as it is. */
  readonly callback: SdkUserPromptSubmitCallback;
  /** True once the CLI has called the callback. */
  fired(): boolean;
  /**
   * The check, made BEFORE the session uses the message. Null to carry on.
   * Otherwise the child has been killed where it could be, and the caller
   * must abort the query, read nothing more and end the run with `error`.
   */
  check(at: CanaryCheckpoint): CanaryStop | null;
}

/** A fresh canary for one run, over the processes that run's owner holds. */
export function createHookCanary(child: Pick<ChildOwner, 'owned' | 'kill'>): HookCanary {
  let fired = false;
  return {
    callback: async () => {
      fired = true;
      return {};
    },
    fired: () => fired,
    check: (at) => {
      // No process held at the start of the turn: stop, whether or not the hook ran. Nothing can be killed.
      if (at === 'turn-start' && !child.owned()) {
        return { error: new ChildNotOwned(), warnings: [`child not owned: ${CHILD_NOT_OWNED_REASON}`, NOT_OWNED_STOP_WARNING] };
      }
      if (fired) return null;
      const outcome = child.kill();
      return { error: new HookCanaryMissed(outcome), warnings: [`hook canary missed: ${HOOK_CANARY_REASON}`, KILL_WARNINGS[outcome]] };
    },
  };
}
