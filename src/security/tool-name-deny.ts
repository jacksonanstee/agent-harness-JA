import { codeExecutionDenial } from './code-execution-deny.js';
import type { PreToolLike } from './pre-tool-like.js';
import { ungatedToolDenial } from './ungated-tool-deny.js';
import { mcpServerPrefixes, unreviewedToolDenial } from './unknown-tool-deny.js';

export interface ToolNameDenyOptions {
  /** MCP servers whose tools may pass (the USER layer's `sdk.allowedMcpServers`); default none. Copied. */
  readonly allowedMcpServers?: readonly string[];
}

/**
 * Pre-tool hook for every built-in deny that is a pure function of the tool
 * name (issue #230, ADR-0045). First match wins, in this order, so each tool
 * keeps the reason it had when these were separate hooks:
 * 1. a CODE_EXECUTING_TOOLS member whose gate is `denied` (REPL; #211);
 * 2. a DENIED_TOOLS name or DENIED_TOOL_PREFIXES prefix (the Artifact family
 *    and its MCP server; #219). Before step 3, so the artifacts server keeps
 *    the ungated reason rather than the MCP-server one;
 * 3. an MCP tool under a server not listed in `allowedMcpServers` (#225);
 * 4. any other tool not in ALLOWED_TOOL_NAMES (#225).
 * A new name step goes before step 3 unless it targets a tool on the
 * allowlist: steps 3 and 4 refuse every unlisted tool, so a step after them
 * would never see one, and the less specific reason would be reported.
 * It never reads arguments: the CLI can rewrite them after this hook runs. It
 * reads no settings itself (the server list is passed in), so no rule or
 * grant can let a refused tool through.
 */
export function toolNameDenyHook(options: ToolNameDenyOptions = {}): (payload: PreToolLike) => Promise<void> {
  const prefixes = mcpServerPrefixes(options.allowedMcpServers ?? []);
  return ({ tool }) => {
    const denial = codeExecutionDenial(tool) ?? ungatedToolDenial(tool) ?? unreviewedToolDenial(tool, prefixes);
    return denial === undefined ? Promise.resolve() : Promise.reject(denial);
  };
}
