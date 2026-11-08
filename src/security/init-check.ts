import {
  ALLOWED_TOOL_NAMES,
  CODE_EXECUTING_TOOLS,
  DENIED_TOOLS,
  MCP_TOOL_PREFIX,
  REVIEWED_REFUSED_TOOLS,
} from '../internal/tool-targets.js';
import { sanitizeControlChars, stripBidi, truncateWellFormed } from '../internal/sanitize.js';

/**
 * Run-time check of the SDK's `system/init` message (issue #229, ADR-0046).
 * `init.tools` is the CLI's own statement of the tools a session has, so it
 * catches a tool an SDK bump adds on an operator's machine, which the CI count
 * of definition sites cannot (ADR-0045 D6). `init.agents` lists the agent
 * names that won precedence; a name that is neither bundled nor defined by a
 * scanned file came from somewhere the scan does not read (a plugin, a plugin
 * registering one at run time). Both stay refused: the default-deny refuses an
 * unruled tool, and the session refuses an Agent call naming an unscanned
 * agent. This check only makes them visible.
 */

/** didn't run / ran clean / ran and found something. */
export type InitCheckState = 'not-run' | 'clean' | 'found';

export interface InitCheck {
  readonly state: InitCheckState;
  /** At most INIT_CHECK_LIST_MAX names, cleaned and bounded. */
  readonly unruledTools: readonly string[];
  readonly unknownAgents: readonly string[];
  /** How many distinct names each list had before the cap, so a truncated list says so. */
  readonly unruledToolCount: number;
  readonly unknownAgentCount: number;
}

export const INIT_CHECK_NOT_RUN: InitCheck = Object.freeze({
  state: 'not-run',
  unruledTools: [],
  unknownAgents: [],
  unruledToolCount: 0,
  unknownAgentCount: 0,
});

/** At most this many names per list are kept; each name at most INIT_CHECK_NAME_MAX characters, the ellipsis included. */
export const INIT_CHECK_LIST_MAX = 16;
export const INIT_CHECK_NAME_MAX = 64;
const NON_STRING = '(non-string)';

/** True when the harness has a ruling for `name`: allowed, denied, reviewed-refused, or an MCP tool (ruled by the server list). */
export function isRuledTool(name: string): boolean {
  if (name.startsWith(MCP_TOOL_PREFIX) && name.length > MCP_TOOL_PREFIX.length) return true;
  return (
    ALLOWED_TOOL_NAMES.has(name) ||
    Object.hasOwn(DENIED_TOOLS, name) ||
    Object.hasOwn(CODE_EXECUTING_TOOLS, name) ||
    Object.hasOwn(REVIEWED_REFUSED_TOOLS, name)
  );
}

const display = (name: unknown): string =>
  typeof name === 'string' ? truncateWellFormed(stripBidi(sanitizeControlChars(name)), INIT_CHECK_NAME_MAX - 1) : NON_STRING;

/** Each entry failing `isKnown`, judged on the raw value and shown cleaned, deduplicated; the list is capped, the count is not. */
function unknownNames(list: readonly unknown[], isKnown: (name: string) => boolean): { names: string[]; count: number } {
  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry === 'string' && isKnown(entry)) continue;
    seen.add(display(entry));
  }
  return { names: [...seen].slice(0, INIT_CHECK_LIST_MAX), count: seen.size };
}

/** Checks an init message's tools against the rulings and its agents against the admitted names. */
export function checkInit(message: unknown, admittedAgents: ReadonlySet<string>): InitCheck {
  if (typeof message !== 'object' || message === null) return INIT_CHECK_NOT_RUN;
  const { tools, agents } = message as Record<string, unknown>;
  if (!Array.isArray(tools) || !Array.isArray(agents)) return INIT_CHECK_NOT_RUN;
  const toolNames = unknownNames(tools as unknown[], isRuledTool);
  const agentNames = unknownNames(agents as unknown[], (name) => admittedAgents.has(name));
  const state: InitCheckState = toolNames.count === 0 && agentNames.count === 0 ? 'clean' : 'found';
  return {
    state,
    unruledTools: toolNames.names,
    unknownAgents: agentNames.names,
    unruledToolCount: toolNames.count,
    unknownAgentCount: agentNames.count,
  };
}

/** The operator line for a check, or null when it ran clean. */
export function initCheckWarning(check: InitCheck): string | null {
  if (check.state === 'clean') return null;
  if (check.state === 'not-run') {
    return 'init check did not run: the SDK sent no init message with tool and agent lists, so new tools and unscanned agents are not reported (they are still refused) (#229)';
  }
  const parts: string[] = [];
  const listed = (names: readonly string[], count: number): string =>
    `${names.join(', ')}${count > names.length ? ` and ${count - names.length} more` : ''}`;
  if (check.unruledToolCount > 0) {
    parts.push(`tools the harness has not ruled on, refused by the default-deny: ${listed(check.unruledTools, check.unruledToolCount)}`);
  }
  if (check.unknownAgentCount > 0) {
    parts.push(
      `agents no scanned file or bundled definition names (a plugin?), refused if called: ${listed(check.unknownAgents, check.unknownAgentCount)}`,
    );
  }
  return `init check: ${parts.join('; ')} (#229)`;
}
