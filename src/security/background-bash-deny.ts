import { BASH_BACKGROUND_FIELD } from '../internal/tool-targets.js';
import type { PreToolLike } from './pre-tool-like.js';

/** Fixed text: it never echoes an argument (ADR-0031). */
export const BACKGROUND_BASH_DENY_REASON =
  'background bash deny: a background command can deliver its output outside a tool result, where no harness gate can check it; run it in the foreground (#250)';

export class BackgroundBashDenied extends Error {
  constructor() {
    super(BACKGROUND_BASH_DENY_REASON);
    this.name = 'BackgroundBashDenied';
  }
}

/**
 * True when a Bash call's own arguments keep it in the foreground: an object
 * (not null, not an array) whose own `run_in_background` field is absent,
 * undefined, or the literal `false`. Anything else fails closed, including a
 * non-object (the field cannot be read) and every other value, not only
 * `true`. An inherited field is ignored; JSON arguments cannot carry one.
 */
function isForegroundBashCall(args: unknown): boolean {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return false;
  if (!Object.hasOwn(args, BASH_BACKGROUND_FIELD)) return true;
  const value: unknown = (args as Record<string, unknown>)[BASH_BACKGROUND_FIELD];
  return value === undefined || value === false;
}

/**
 * The refusal for a Bash call that asks to run in the background, or undefined
 * (issue #250, ADR-0040 D-8 as amended 12/11/2026). A background shell's
 * output can reach the model as task-notification text (the CLI's stall
 * notice inlines the tail of the raw output), which no post-tool hook sees:
 * no redaction, no injection scan, no judge, no tool-trace row (R-28).
 *
 * This is the harness-owned half of the fix and covers ONE path: the explicit
 * flag. The CLI also moves a foreground command to the background by itself
 * when it reaches its timeout, which no pre-tool hook can see; that path is
 * closed by FORCED_CHILD_ENV (`src/internal/child-env.ts`). With the switch
 * set, CLI 2.1.312 rejects the flag itself and this deny does not fire
 * (OBSERVED, mock API, 12/11/2026), so this deny is the backstop for a CLI
 * that stops honouring the switch.
 * Every other tool passes, Agent included: its `run_in_background` is not
 * read here.
 */
export function backgroundBashDenial(payload: PreToolLike): BackgroundBashDenied | undefined {
  return payload.tool === 'Bash' && !isForegroundBashCall(payload.args) ? new BackgroundBashDenied() : undefined;
}
