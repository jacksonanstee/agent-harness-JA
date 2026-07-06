import { basename, resolve, sep } from 'node:path';

import { canonicalizePath, TOOL_TARGET_FIELDS } from '../../internal/tool-targets.js';
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
 * starts, so the command is denied outright (ADR-0015 §3). `\` (escape /
 * line continuation) and `!` (history expansion) are included since the
 * review round; `*`/`~` are deliberately NOT — glob/tilde expansion happens
 * inside the allowed program's argument list and does not change which
 * program starts (documented non-goal).
 */
const SHELL_METACHARACTERS = [
  ';', '|', '&', '$', '`', '(', ')', '{', '}', '<', '>', '\n', '\r', '\\', '!',
];

/**
 * Binaries that defeat first-token enforcement by construction: allowing a
 * shell or a run-anything wrapper makes argv[0] analysis meaningless, so
 * these are DENIED even when an allowlist names them (review escalation —
 * the previous warn-only stance was security theater for a bypass class the
 * ADR itself names). Compared by basename, so `/bin/sh` is caught too.
 */
export const SHELL_RUNNER_BINARIES: readonly string[] = [
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'fish', 'env', 'xargs',
];

/** Boundary-safe prefix check: /allowed matches /allowed/x but never /allowed-extra. */
function isUnder(target: string, base: string): boolean {
  return target === base || target.startsWith(base + sep);
}

/** Path-shaped entries (contain a separator) and bare names have distinct identity grammars. */
function isPathShaped(entry: string): boolean {
  return entry.includes('/') || entry.includes(sep);
}

/**
 * Pure gate over a sandbox config. Allow entries are canonicalised once at
 * construction (lexical resolve + case folding on case-insensitive
 * platforms — ADR-0015 §2; symlink escapes remain documented, not solved).
 * A dimension whose key is absent is disabled and allows everything — its
 * gate is `permissions`' job; a PRESENT dimension with an empty allow list
 * denies everything (fail closed).
 */
export function createSandbox(config: SandboxConfig = {}): Sandbox {
  const pathBases = config.paths?.allow.map((entry) => canonicalizePath(entry));
  const commandEntries = config.commands?.allow;

  return {
    pathsEnabled: pathBases !== undefined,
    commandsEnabled: commandEntries !== undefined,

    allowPath(path: string): boolean {
      if (pathBases === undefined) return true;
      if (typeof path !== 'string' || path === '') return false;
      const target = canonicalizePath(path);
      return pathBases.some((base) => isUnder(target, base));
    },

    allowCommand(cmd: string): boolean {
      if (commandEntries === undefined) return true;
      if (typeof cmd !== 'string') return false;
      const trimmed = cmd.trim();
      if (trimmed === '') return false;
      if (SHELL_METACHARACTERS.some((ch) => trimmed.includes(ch))) return false;
      const argv0 = trimmed.split(/\s+/, 1)[0] ?? '';
      // Static blocklist beats the allowlist: shells and run-anything
      // wrappers defeat first-token analysis no matter what settings say.
      if (SHELL_RUNNER_BINARIES.includes(basename(argv0))) return false;
      return commandEntries.some((entry) =>
        isPathShaped(entry)
          ? isPathShaped(argv0) && resolve(entry) === resolve(argv0)
          : entry === argv0,
      );
    },
  };
}

/**
 * Entry identity for intersection MUST match allowCommand/allowPath's own
 * grammar (review finding: blanket resolve() turned bare command names into
 * cwd-anchored paths, so `git` and `./git` wrongly intersected).
 */
function entryKey(entry: string, kind: 'path' | 'command'): string {
  if (kind === 'path') return canonicalizePath(entry);
  return isPathShaped(entry) ? `p:${resolve(entry)}` : `b:${entry}`;
}

function intersectDimension(
  user: SandboxAllowlist | undefined,
  project: SandboxAllowlist | undefined,
  kind: 'path' | 'command',
): SandboxAllowlist | undefined {
  if (user === undefined) return project;
  if (project === undefined) return user;
  // Both layers define the dimension: an entry survives only if BOTH allow it.
  const projectKeys = new Set(project.allow.map((entry) => entryKey(entry, kind)));
  return { allow: user.allow.filter((entry) => projectKeys.has(entryKey(entry, kind))) };
}

/**
 * Allowlists merge by INTERSECTION, the allowlist analogue of permissions'
 * sticky deny: concatenation would let a cloned repo's settings file widen
 * the sandbox to `/`. When only one layer defines a dimension, that layer
 * applies alone — a restriction the other layer never opted into, never a
 * widening; when both do, an entry must appear in both (ADR-0015 §1).
 */
export function mergeSandboxLayers(user: SandboxConfig, project: SandboxConfig): SandboxConfig {
  const paths = intersectDimension(user.paths, project.paths, 'path');
  const commands = intersectDimension(user.commands, project.commands, 'command');
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

/**
 * Pre-tool hook enforcing the sandbox over every path/command-taking tool in
 * the shared TOOL_TARGET_FIELDS table. Unknown tools pass through (the
 * permissions layer governs them). A gated tool with a missing or non-string
 * target field is DENIED — fail closed, never guess — EXCEPT where the SDK
 * defines "missing" as cwd (Glob/Grep), in which case the cwd is what gets
 * gated (ADR-0015 §2).
 */
export function sandboxHook(sandbox: Sandbox): (payload: PreToolLike) => Promise<void> {
  return (payload) => {
    const gate = TOOL_TARGET_FIELDS[payload.tool];
    if (gate === undefined) return Promise.resolve();
    const enabled = gate.kind === 'path' ? sandbox.pathsEnabled : sandbox.commandsEnabled;
    if (!enabled) return Promise.resolve();

    const args = payload.args;
    const raw =
      typeof args === 'object' && args !== null
        ? (args as Record<string, unknown>)[gate.field]
        : undefined;
    const value =
      raw === undefined && gate.missingMeansCwd === true ? process.cwd() : raw;
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
