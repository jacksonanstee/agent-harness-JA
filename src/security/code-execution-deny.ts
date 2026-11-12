import { CODE_EXECUTING_TOOLS } from '../internal/tool-targets.js';

/** The shared reason the model reads for a `denied` tool with no text of its own (today REPL). Fixed text: it never echoes an argument (ADR-0031). */
export const CODE_EXECUTION_DENY_REASON =
  'built-in deny: this tool runs code that no harness gate can check, ' +
  'so the harness refuses it whatever the rules say (ADR-0040 D-8)';

/**
 * Monitor's own reason (issue #248, owner 12/11/2026). Its command can be
 * checked; what cannot is its output, which the CLI hands the model as
 * notification text that no post-tool hook sees. Fixed text, no argument.
 */
export const MONITOR_DENY_REASON =
  'built-in deny: Monitor delivers command output outside a tool result, so no harness gate can check it (#248)';

/** A `denied` tool whose reason is not the shared one. Every other `denied` member reads CODE_EXECUTION_DENY_REASON. */
const REASON_BY_TOOL: ReadonlyMap<string, string> = new Map([['Monitor', MONITOR_DENY_REASON]]);

export class CodeExecutionDenied extends Error {
  constructor(reason: string = CODE_EXECUTION_DENY_REASON) {
    super(reason);
    this.name = 'CodeExecutionDenied';
  }
}

const DENIED_CODE_TOOLS: ReadonlySet<string> = new Set(
  Object.entries(CODE_EXECUTING_TOOLS)
    .filter(([, gate]) => gate === 'denied')
    .map(([name]) => name),
);

/**
 * The refusal for a CODE_EXECUTING_TOOLS member whose gate is `denied` (today
 * REPL, issue #211, and Monitor, issue #248), or undefined. A pure function of
 * the name, applied by `toolNameDenyHook` (#230). Without it, withholding the
 * grant would refuse nothing for REPL, since the CLI's own check is `allow`;
 * for Monitor no grant condition helps, because its output reaches the model
 * outside every post-tool hook. Each tool's reason is fixed: Monitor's own
 * text, the shared one for the rest.
 */
export const codeExecutionDenial = (tool: string): CodeExecutionDenied | undefined =>
  DENIED_CODE_TOOLS.has(tool) ? new CodeExecutionDenied(REASON_BY_TOOL.get(tool)) : undefined;
