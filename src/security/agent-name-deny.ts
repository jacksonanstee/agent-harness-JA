/**
 * The Agent-name half of the #229 gate (ADR-0046): an `Agent` call may name
 * only an agent the harness has seen, a bundled definition or a scanned agent
 * file. The admitted names come from the per-run scan, so the session applies
 * this before its hook chain fires (a static hook stack cannot hold per-run
 * state); the check and its reason live here, with the other denies.
 */

export const UNSCANNED_AGENT_DENY_REASON =
  'unscanned agent deny: no bundled definition or scanned agent file defines this agent, so the harness refuses it (#229)';

export class UnscannedAgentDenied extends Error {
  constructor() {
    super(UNSCANNED_AGENT_DENY_REASON);
    this.name = 'UnscannedAgentDenied';
  }
}

/**
 * The denial for an `Agent` call's arguments, or undefined when it may pass:
 * no own `subagent_type` (the CLI's default agent), `undefined`, or a name in
 * `admitted`, compared exactly as the CLI resolves it. A non-object passes
 * here because the default-deny refuses it (ADR-0045 D4).
 */
export function agentNameRefusal(args: unknown, admitted: ReadonlySet<string>): UnscannedAgentDenied | undefined {
  if (typeof args !== 'object' || args === null || !Object.hasOwn(args, 'subagent_type')) return undefined;
  const name: unknown = (args as Record<string, unknown>)['subagent_type'];
  if (name === undefined) return undefined;
  return typeof name === 'string' && admitted.has(name) ? undefined : new UnscannedAgentDenied();
}
