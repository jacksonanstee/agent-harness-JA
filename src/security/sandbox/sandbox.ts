import { resolve, sep } from 'node:path';

import type { Sandbox, SandboxAllowlist, SandboxConfig } from './types.js';

/**
 * Thrown by sandboxHook to deny a tool call. Own class, NOT the hook
 * runtime's HookDenial — security and hooks are import-free peers, and the
 * runtime denies on ANY pre-tool throw with `message` as the reason (same
 * rationale as permissions' PermissionDenied, ADR-0014 §7).
 */
export class SandboxViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxViolation';
  }
}

/**
 * Shell metacharacters that end first-token analysis: any of these in a
 * sandboxed command means we can no longer claim to know which program
 * starts, so the command is denied outright (ADR-0015 §3).
 */
const SHELL_METACHARACTERS = [';', '|', '&', '$', '`', '(', ')', '{', '}', '<', '>', '\n', '\r'];

/** Boundary-safe prefix check: /allowed matches /allowed/x but never /allowed-extra. */
function isUnder(target: string, base: string): boolean {
  return target === base || target.startsWith(base + sep);
}

/**
 * Pure gate over a sandbox config. Allow entries are canonicalised once at
 * construction (lexical `resolve`, same base and same limits as the S-3
 * evaluator — symlink escapes are documented, not solved, ADR-0015 §2).
 * A dimension whose key is absent is disabled and allows everything — its
 * gate is `permissions`' job; a PRESENT dimension with an empty allow list
 * denies everything (fail closed).
 */
export function createSandbox(config: SandboxConfig = {}): Sandbox {
  const pathBases = config.paths?.allow.map((entry) => resolve(entry));
  const commandEntries = config.commands?.allow;

  return {
    pathsEnabled: pathBases !== undefined,
    commandsEnabled: commandEntries !== undefined,

    allowPath(path: string): boolean {
      if (pathBases === undefined) return true;
      if (typeof path !== 'string' || path === '') return false;
      const target = resolve(path);
      return pathBases.some((base) => isUnder(target, base));
    },

    allowCommand(cmd: string): boolean {
      if (commandEntries === undefined) return true;
      if (typeof cmd !== 'string') return false;
      const trimmed = cmd.trim();
      if (trimmed === '') return false;
      if (SHELL_METACHARACTERS.some((ch) => trimmed.includes(ch))) return false;
      const argv0 = trimmed.split(/\s+/, 1)[0] ?? '';
      return commandEntries.some((entry) =>
        entry.includes('/') || entry.includes(sep)
          ? argv0.includes('/') || argv0.includes(sep)
            ? resolve(entry) === resolve(argv0)
            : false
          : entry === argv0,
      );
    },
  };
}

function intersectDimension(
  user: SandboxAllowlist | undefined,
  project: SandboxAllowlist | undefined,
): SandboxAllowlist | undefined {
  if (user === undefined) return project;
  if (project === undefined) return user;
  // Both layers define the dimension: an entry survives only if BOTH allow
  // it. Compared post-resolve so equivalent spellings intersect correctly.
  const projectResolved = new Set(project.allow.map((entry) => resolve(entry)));
  return { allow: user.allow.filter((entry) => projectResolved.has(resolve(entry))) };
}

/**
 * Allowlists merge by INTERSECTION, the allowlist analogue of permissions'
 * sticky deny: concatenation would let a cloned repo's settings file widen
 * the sandbox to `/`. When only one layer defines a dimension, that layer
 * applies alone; when both do, an entry must appear in both (ADR-0015 §1).
 */
export function mergeSandboxLayers(user: SandboxConfig, project: SandboxConfig): SandboxConfig {
  const paths = intersectDimension(user.paths, project.paths);
  const commands = intersectDimension(user.commands, project.commands);
  return {
    ...(paths === undefined ? {} : { paths }),
    ...(commands === undefined ? {} : { commands }),
  };
}

/** Structural subset of the hooks PreToolPayload (peer-leaf rule, no hooks import). */
export interface PreToolLike {
  readonly tool: string;
  readonly args: unknown;
}

/** Tool → args field the sandbox gates. Local duplicate of permissions' table by design. */
const GATED_FIELDS: Readonly<Record<string, { field: string; kind: 'path' | 'command' }>> = {
  Bash: { field: 'command', kind: 'command' },
  Read: { field: 'file_path', kind: 'path' },
  Write: { field: 'file_path', kind: 'path' },
  Edit: { field: 'file_path', kind: 'path' },
};

/**
 * Pre-tool hook enforcing the sandbox. Unknown tools pass through (the
 * permissions layer governs them); a gated tool with a missing or non-string
 * target field is DENIED when its dimension is enabled — fail closed, never
 * guess (ADR-0015 §2).
 */
export function sandboxHook(sandbox: Sandbox): (payload: PreToolLike) => Promise<void> {
  return (payload) => {
    const gate = GATED_FIELDS[payload.tool];
    if (gate === undefined) return Promise.resolve();
    const enabled = gate.kind === 'path' ? sandbox.pathsEnabled : sandbox.commandsEnabled;
    if (!enabled) return Promise.resolve();

    const args = payload.args;
    const value =
      typeof args === 'object' && args !== null
        ? (args as Record<string, unknown>)[gate.field]
        : undefined;
    if (typeof value !== 'string') {
      return Promise.reject(
        new SandboxViolation(
          `sandbox: ${payload.tool} requires a string ${gate.field}; refusing to guess`,
        ),
      );
    }
    const allowed = gate.kind === 'path' ? sandbox.allowPath(value) : sandbox.allowCommand(value);
    if (!allowed) {
      return Promise.reject(
        new SandboxViolation(`sandbox: ${payload.tool} ${gate.field} not in allowlist`),
      );
    }
    return Promise.resolve();
  };
}
