import type { PreToolLike } from './pre-tool-like.js';
import { remoteAgentDenyHook } from './remote-agent-deny.js';
import { type ProtectedRoots, selfProtectionHook } from './self-protection.js';
import { type ToolNameDenyOptions, toolNameDenyHook } from './tool-name-deny.js';

/**
 * The built-in, non-configurable pre-tool denies, in the one order the harness
 * ships: self-protection (#188), the tool-name deny (#230: the code-execution,
 * ungated-tool and unreviewed-tool denies of #211, #219 and #225, one
 * classifier), then the remote-agent deny (#225, the one built-in deny besides
 * self-protection that reads arguments). Register them before any configurable gate, so no rule,
 * grant or sandbox list can let one through. `registerSecurityHooks` consumes
 * this, passing the USER layer's `sdk.allowedMcpServers` (#225); a library
 * caller that composes its own stack should too, rather than re-typing the
 * order (issue #219, architecture review).
 */
export function builtInDenyHooks(
  roots: ProtectedRoots,
  options: ToolNameDenyOptions = {},
): readonly ((payload: PreToolLike) => Promise<void>)[] {
  return [selfProtectionHook(roots), toolNameDenyHook(options), remoteAgentDenyHook()];
}
