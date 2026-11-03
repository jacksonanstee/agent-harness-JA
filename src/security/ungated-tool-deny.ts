import { DENIED_TOOL_PREFIXES, DENIED_TOOLS } from '../internal/tool-targets.js';
import type { PreToolLike } from './pre-tool-like.js';

/**
 * The one reason the model reads. Fixed text: it never echoes an argument
 * (ADR-0031). Its prefix differs from the other built-in denies', so a
 * telemetry row is attributable by reason, not only by handler index.
 */
export const UNGATED_TOOL_DENY_REASON =
  'built-in tool deny: this tool reaches local files in ways no harness gate can check, ' +
  'so the harness refuses it whatever the rules say (#219)';

export class UngatedToolDenied extends Error {
  constructor() {
    super(UNGATED_TOOL_DENY_REASON);
    this.name = 'UngatedToolDenied';
  }
}

const PREFIXES: readonly string[] = Object.keys(DENIED_TOOL_PREFIXES);

const isRefused = (tool: string): boolean =>
  Object.hasOwn(DENIED_TOOLS, tool) || PREFIXES.some((prefix) => tool.startsWith(prefix));

/**
 * Pre-tool hook denying every DENIED_TOOLS member by exact name and every tool
 * under a DENIED_TOOL_PREFIXES prefix, whatever its arguments (today the
 * Artifact family and the CLI's own artifacts MCP server; issue #219).
 * Arguments are not read: the CLI can rewrite them after this hook runs, so
 * no argument check would hold. It reads no settings, so no rule or grant can let one through.
 */
export function ungatedToolDenyHook(): (payload: PreToolLike) => Promise<void> {
  return (payload) =>
    isRefused(payload.tool) ? Promise.reject(new UngatedToolDenied()) : Promise.resolve();
}
