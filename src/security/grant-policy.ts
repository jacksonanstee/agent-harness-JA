import { CODE_EXECUTING_TOOLS } from '../internal/tool-targets.js';
import type { GrantPolicy } from './permissions/index.js';
import type { SandboxConfig } from './sandbox/index.js';

/**
 * ADR-0040 D-8 (#211, exported by #218): every CODE_EXECUTING_TOOLS member is
 * withheld from the grant unless its gate is `commands` and `userSandbox` has
 * a non-empty `commands.allow` list. The gates are documented on the map.
 *
 * Pass the USER layer's sandbox, never the merged one: the merge returns the
 * project's list when the user has none, so a cloned repository's commands
 * list would otherwise unlock the grant. It lives here, not in permissions/,
 * so the permissions module stays sandbox-free (permissions/types.ts GrantPolicy).
 */
export function grantPolicyFor(userSandbox: SandboxConfig): GrantPolicy {
  const commandsConfigured = (userSandbox.commands?.allow.length ?? 0) > 0;
  return {
    ungrantableTools: new Set(
      Object.entries(CODE_EXECUTING_TOOLS)
        .filter(([, gate]) => gate !== 'commands' || !commandsConfigured)
        .map(([name]) => name),
    ),
  };
}
