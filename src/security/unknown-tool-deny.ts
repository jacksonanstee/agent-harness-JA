import { ALLOWED_TOOL_NAMES, MCP_TOOL_PREFIX } from '../internal/tool-targets.js';
import type { PreToolLike } from './pre-tool-like.js';

export const UNKNOWN_TOOL_DENY_REASON =
  'unreviewed tool deny: the harness has not reviewed this tool, so it refuses it whatever the rules say (#225)';

export const REMOTE_AGENT_DENY_REASON =
  'remote agent deny: a subagent must run locally, in the harness working directory, where the harness hooks see its tool calls (#225)';

export const MCP_SERVER_DENY_REASON =
  'mcp server deny: this MCP server is not listed in sdk.allowedMcpServers in ~/.harness/settings.json, ' +
  'so the harness refuses its tools (#225)';

export class UnknownToolDenied extends Error {
  constructor() {
    super(UNKNOWN_TOOL_DENY_REASON);
    this.name = 'UnknownToolDenied';
  }
}

export class RemoteAgentDenied extends Error {
  constructor() {
    super(REMOTE_AGENT_DENY_REASON);
    this.name = 'RemoteAgentDenied';
  }
}

export class McpServerDenied extends Error {
  constructor() {
    super(MCP_SERVER_DENY_REASON);
    this.name = 'McpServerDenied';
  }
}

const MCP_SEGMENT_END = '__';

/** The one isolation value known to keep a subagent local (`AgentInput.isolation`, SDK 0.3.312). */
const LOCAL_ISOLATION = 'worktree';

/**
 * True when an Agent call's own arguments keep it local: an object (not null,
 * not an array) with no own `cwd` field and whose own `isolation` field is
 * absent, undefined, or "worktree". Anything else fails closed, including a
 * non-object (the fields cannot be read) and any isolation value, not only
 * "remote". An inherited field is ignored; JSON arguments cannot carry one.
 */
function isLocalAgentCall(args: unknown): boolean {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return false;
  // `cwd` is in the CLI's Agent schema family but omitted from the model-facing one today; a subagent
  // in another directory would be judged against the harness cwd, so its presence alone refuses.
  if (Object.hasOwn(args, 'cwd')) return false;
  if (!Object.hasOwn(args, 'isolation')) return true;
  const isolation: unknown = (args as Record<string, unknown>).isolation;
  return isolation === undefined || isolation === LOCAL_ISOLATION;
}

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

function check(payload: PreToolLike, mcpPrefixes: readonly string[]): Error | undefined {
  if (payload.tool.startsWith(MCP_TOOL_PREFIX)) {
    return underListedServer(payload.tool, mcpPrefixes) ? undefined : new McpServerDenied();
  }
  if (!ALLOWED_TOOL_NAMES.has(payload.tool)) return new UnknownToolDenied();
  if (payload.tool === 'Agent' && !isLocalAgentCall(payload.args)) return new RemoteAgentDenied();
  return undefined;
}

export interface UnknownToolDenyOptions {
  /** MCP servers whose tools may pass (the USER layer's `sdk.allowedMcpServers`); default none. Copied. */
  readonly allowedMcpServers?: readonly string[];
}

/**
 * Pre-tool hook refusing every non-MCP tool not in ALLOWED_TOOL_NAMES, every
 * MCP tool whose server the operator did not list in `sdk.allowedMcpServers`,
 * and an Agent call whose own arguments do not keep it local (issue #225,
 * ADR-0045). The bundled CLI defines tools no SDK type lists and allows a tool
 * outright when it defines no permission check, so only an allowlist fails
 * closed when an SDK bump adds one. It reads no settings itself (the server
 * list is passed in), so no rule or grant can let a refused tool through. An
 * agent definition can also set `isolation: remote` in its frontmatter, which
 * the CLI applies when the call omits the field; this hook cannot see that
 * (ADR-0045 D4, R-26).
 */
export function unknownToolDenyHook(options: UnknownToolDenyOptions = {}): (payload: PreToolLike) => Promise<void> {
  const mcpPrefixes = (options.allowedMcpServers ?? []).map((server) => `${MCP_TOOL_PREFIX}${server}${MCP_SEGMENT_END}`);
  return (payload) => {
    const denial = check(payload, mcpPrefixes);
    return denial === undefined ? Promise.resolve() : Promise.reject(denial);
  };
}
