import { argumentDenyHook } from './argument-deny.js';
import type { PreToolLike } from './pre-tool-like.js';
import { type ProtectedRoots, selfProtectionHook } from './self-protection.js';
import { type ToolNameDenyOptions, toolNameDenyHook } from './tool-name-deny.js';

/**
 * The built-in, non-configurable pre-tool denies, in the one order the harness
 * ships: self-protection (#188), the tool-name deny (#230: the code-execution,
 * ungated-tool and unreviewed-tool denies of #211, #219 and #225, one
 * classifier), then the argument deny (the built-in denies besides
 * self-protection that read arguments: the remote-agent deny, #225, and the
 * background-Bash deny, #250). Register them before any configurable gate, so no rule,
 * grant or sandbox list can let one through. `registerSecurityHooks` consumes
 * this, passing the USER layer's `sdk.allowedMcpServers` (#225); a library
 * caller that composes its own stack should too, rather than re-typing the
 * order (issue #219, architecture review).
 */
export function builtInDenyHooks(
  roots: ProtectedRoots,
  options: ToolNameDenyOptions = {},
): readonly ((payload: PreToolLike) => Promise<void>)[] {
  return [selfProtectionHook(roots), toolNameDenyHook(options), argumentDenyHook()];
}
