import type { PreToolLike } from './pre-tool-like.js';

export const REMOTE_AGENT_DENY_REASON =
  'remote agent deny: a subagent must run locally, in the harness working directory, where the harness hooks see its tool calls (#225)';

export class RemoteAgentDenied extends Error {
  constructor() {
    super(REMOTE_AGENT_DENY_REASON);
    this.name = 'RemoteAgentDenied';
  }
}

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
 * Pre-tool hook refusing an Agent call whose own arguments do not keep it
 * local (issue #225, ADR-0045 D4; its own hook since #230, because the
 * name-based denies read no arguments). Every other tool passes. An agent
 * definition can also set `isolation: remote` in its frontmatter, which the
 * CLI applies when the call omits the field; this hook cannot see that (the
 * agent-definition scan covers the files it can read, ADR-0046).
 */
export function remoteAgentDenyHook(): (payload: PreToolLike) => Promise<void> {
  return (payload) => {
    const denial = remoteAgentDenial(payload);
    return denial === undefined ? Promise.resolve() : Promise.reject(denial);
  };
}

/**
 * The remote-agent refusal for a call, or undefined: the argument-reading
 * counterpart of the name checks' `*Denial(tool)` functions (#230). A later
 * built-in deny that reads arguments becomes another step composed with this
 * one in the same hook, so it does not shift `handlerIndex`.
 */
export function remoteAgentDenial(payload: PreToolLike): RemoteAgentDenied | undefined {
  return payload.tool === 'Agent' && !isLocalAgentCall(payload.args) ? new RemoteAgentDenied() : undefined;
}
