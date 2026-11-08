import { DENIED_TOOL_PREFIXES, DENIED_TOOLS } from '../internal/tool-targets.js';

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
 * The refusal for a DENIED_TOOLS member (exact name) or a tool under a
 * DENIED_TOOL_PREFIXES prefix (today the Artifact family and the CLI's own
 * artifacts MCP server; issue #219), or undefined. A pure function of the
 * name, applied by `toolNameDenyHook` (#230): arguments are not read, since
 * the CLI can rewrite them after the hook runs, so no argument check would hold.
 */
export const ungatedToolDenial = (tool: string): UngatedToolDenied | undefined =>
  isRefused(tool) ? new UngatedToolDenied() : undefined;
