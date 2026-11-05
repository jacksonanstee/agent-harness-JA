import { codeExecutionDenyHook } from './code-execution-deny.js';
import type { PreToolLike } from './pre-tool-like.js';
import { type ProtectedRoots, selfProtectionHook } from './self-protection.js';
import { ungatedToolDenyHook } from './ungated-tool-deny.js';
import { type UnknownToolDenyOptions, unknownToolDenyHook } from './unknown-tool-deny.js';

/**
 * The built-in, non-configurable pre-tool denies, in the one order the harness
 * ships: self-protection (#188), the code-execution deny (#211), the
 * ungated-tool deny (#219), the unreviewed-tool deny (#225, last: it also
 * refuses what the earlier denies refuse, so they keep their own reasons).
 * Register them before any configurable gate, so no rule, grant or sandbox
 * list can let one through. `registerSecurityHooks` consumes this, passing
 * the USER layer's `sdk.allowedMcpServers` (#225); a library caller that composes
 * its own stack should too, rather than re-typing the order (issue #219,
 * architecture review).
 */
export function builtInDenyHooks(
  roots: ProtectedRoots,
  options: UnknownToolDenyOptions = {},
): readonly ((payload: PreToolLike) => Promise<void>)[] {
  return [selfProtectionHook(roots), codeExecutionDenyHook(), ungatedToolDenyHook(), unknownToolDenyHook(options)];
}
