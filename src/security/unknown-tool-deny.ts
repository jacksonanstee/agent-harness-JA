import { ALLOWED_TOOL_NAMES, MCP_TOOL_PREFIX } from '../internal/tool-targets.js';

export const UNKNOWN_TOOL_DENY_REASON =
  'unreviewed tool deny: the harness has not reviewed this tool, so it refuses it whatever the rules say (#225)';

export const MCP_SERVER_DENY_REASON =
  'mcp server deny: this MCP server is not listed in sdk.allowedMcpServers in ~/.harness/settings.json, ' +
  'so the harness refuses its tools (#225)';

export class UnknownToolDenied extends Error {
  constructor() {
    super(UNKNOWN_TOOL_DENY_REASON);
    this.name = 'UnknownToolDenied';
  }
}

export class McpServerDenied extends Error {
  constructor() {
    super(MCP_SERVER_DENY_REASON);
    this.name = 'McpServerDenied';
  }
}

const MCP_SEGMENT_END = '__';

/**
 * True when `tool` is `mcp__<server>__<tool>` under one of `prefixes`, with a
 * tool segment that is non-empty and does not start with `_`. The CLI turns
 * every character outside [A-Za-z0-9_-] in a server name into `_`, so a server
 * configured as `github.` runs as `github_` and its tools read
 * `mcp__github___<tool>`; refusing a leading `_` keeps that out from under a
 * listed `github`. A server named `github__x` still aliases a listed `github`
 * (R-26): the CLI splits names the same ambiguous way. The other half of this
 * naming contract is MCP_SERVER_NAME in sdk-settings.ts: change both together.
 */
const underListedServer = (tool: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => tool.startsWith(prefix) && tool.length > prefix.length && tool[prefix.length] !== '_');

/** The `mcp__<server>__` prefix of each listed server, in a fresh array (the caller's list is not kept). */
export const mcpServerPrefixes = (servers: readonly string[]): readonly string[] =>
  servers.map((server) => `${MCP_TOOL_PREFIX}${server}${MCP_SEGMENT_END}`);

/**
 * The unreviewed-tool refusal for `tool`, or undefined (issue #225, ADR-0045):
 * an MCP tool must sit under one of `mcpPrefixes`, any other tool must be in
 * ALLOWED_TOOL_NAMES. The bundled CLI defines tools no SDK type lists and
 * allows a tool outright when it defines no permission check, so only an
 * allowlist fails closed when an SDK bump adds one. A pure function of the
 * name, applied by `toolNameDenyHook` (#230); the Agent argument check is
 * `remoteAgentDenyHook`'s.
 */
export function unreviewedToolDenial(tool: string, mcpPrefixes: readonly string[]): McpServerDenied | UnknownToolDenied | undefined {
  if (tool.startsWith(MCP_TOOL_PREFIX)) return underListedServer(tool, mcpPrefixes) ? undefined : new McpServerDenied();
  return ALLOWED_TOOL_NAMES.has(tool) ? undefined : new UnknownToolDenied();
}
