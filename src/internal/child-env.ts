/**
 * The environment the primary session hands the bundled CLI (issue #250,
 * ADR-0040 D-8 as amended 12/11/2026).
 *
 * The SDK's `Options.env` REPLACES the child's environment; it is not merged
 * with `process.env` (sdk.d.ts, SDK 0.3.312). So the builder carries every
 * inherited variable and then applies the harness's own table on top, and the
 * harness value wins over whatever the operator's environment holds.
 *
 * The builder is deliberately a pipeline of one step today (apply
 * FORCED_CHILD_ENV). A later rule that must REMOVE an inherited variable is
 * another step here, with its own table and tests; nothing is stripped now.
 */

/**
 * The bundled CLI's switch for background tasks. With it set, CLI 2.1.312
 * (OBSERVED, loopback mock API driving the real CLI, 12/11/2026):
 * - rejects a Bash call that passes `run_in_background` as an unexpected parameter;
 * - kills a foreground Bash command at its timeout instead of moving it to the
 *   background (the move is what armed the stall notice without the flag);
 * - runs a plain `Agent` call in the foreground, so the subagent's report comes
 *   back as a tool result (issue #252).
 * No type declares the name; tool-targets.sdk-parity.test.ts checks the
 * installed binary still holds it.
 */
export const BACKGROUND_TASKS_SWITCH = 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS';

/** Variables the harness sets in the child whatever the inherited environment says. Frozen; one entry today. */
export const FORCED_CHILD_ENV: Readonly<Record<string, string>> = Object.freeze({
  [BACKGROUND_TASKS_SWITCH]: '1',
});

/** A process environment as Node and the SDK type it: a name maps to a string, or to undefined when unset. */
export type ChildEnv = Record<string, string | undefined>;

/**
 * The child environment: every inherited variable, then FORCED_CHILD_ENV over
 * it. Pure: a fresh object each call, the input untouched.
 */
export function buildChildEnv(inherited: Readonly<ChildEnv>): ChildEnv {
  return { ...inherited, ...FORCED_CHILD_ENV };
}
