import { CODE_EXECUTING_TOOLS } from '../internal/tool-targets.js';

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

const DENIED_CODE_TOOLS: ReadonlySet<string> = new Set(
  Object.entries(CODE_EXECUTING_TOOLS)
    .filter(([, gate]) => gate === 'denied')
    .map(([name]) => name),
);

/**
 * The refusal for a CODE_EXECUTING_TOOLS member whose gate is `denied` (today
 * REPL; issue #211), or undefined. A pure function of the name, applied by
 * `toolNameDenyHook` (#230). Without it, withholding the grant would refuse
 * nothing for such a tool, since the CLI's own check is `allow`.
 */
export const codeExecutionDenial = (tool: string): CodeExecutionDenied | undefined =>
  DENIED_CODE_TOOLS.has(tool) ? new CodeExecutionDenied() : undefined;
