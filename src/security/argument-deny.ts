import { backgroundBashDenial } from './background-bash-deny.js';
import type { PreToolLike } from './pre-tool-like.js';
import { remoteAgentDenial } from './remote-agent-deny.js';

/**
 * Pre-tool hook for the built-in denies that read a call's ARGUMENTS (the
 * name-only denies are `toolNameDenyHook`'s). One hook, so adding a step does
 * not shift `handlerIndex` for the hooks registered after it. The two steps
 * name different tools, so at most one can match a call:
 * 1. an Agent call whose arguments do not keep it local (#225, `remoteAgentDenial`);
 * 2. a Bash call that asks to run in the background (#250, `backgroundBashDenial`).
 * It reads no settings, so no rule, grant or sandbox list can let a refused
 * call through.
 */
export function argumentDenyHook(): (payload: PreToolLike) => Promise<void> {
  return (payload) => {
    const denial = remoteAgentDenial(payload) ?? backgroundBashDenial(payload);
    return denial === undefined ? Promise.resolve() : Promise.reject(denial);
  };
}
