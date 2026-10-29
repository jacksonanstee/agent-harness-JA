import { CODE_EXECUTING_TOOLS } from '../internal/tool-targets.js';
import type { PreToolLike } from './pre-tool-like.js';

/** The one reason the model reads. Fixed text: it never echoes an argument (ADR-0031). */
export const CODE_EXECUTION_DENY_REASON =
  'built-in deny: this tool runs code that no harness gate can check, ' +
  'so the harness refuses it whatever the rules say (ADR-0040 D-8)';

export class CodeExecutionDenied extends Error {
  constructor() {
    super(CODE_EXECUTION_DENY_REASON);
    this.name = 'CodeExecutionDenied';
  }
}

const DENIED_TOOLS: ReadonlySet<string> = new Set(
  Object.entries(CODE_EXECUTING_TOOLS)
    .filter(([, gate]) => gate === 'denied')
    .map(([name]) => name),
);

/**
 * Pre-tool hook denying every CODE_EXECUTING_TOOLS member whose gate is
 * `denied` (today REPL; issue #211). It reads no settings, so no rule, grant
 * or sandbox list can let one through. Without it, withholding the grant would
 * refuse nothing for such a tool, since the CLI's own check is `allow`.
 */
export function codeExecutionDenyHook(): (payload: PreToolLike) => Promise<void> {
  return (payload) =>
    DENIED_TOOLS.has(payload.tool) ? Promise.reject(new CodeExecutionDenied()) : Promise.resolve();
}
