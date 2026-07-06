export interface SandboxAllowlist {
  readonly allow: readonly string[];
}

/**
 * Each dimension is independently enabled by presence: `paths` present →
 * path gate enforced for file tools; `commands` present → command gate
 * enforced for Bash. Absent everywhere → sandbox off (ADR-0015 §1). There is
 * deliberately no on/off switch a project settings file could flip.
 */
export interface SandboxConfig {
  readonly paths?: SandboxAllowlist;
  readonly commands?: SandboxAllowlist;
}

export interface Sandbox {
  /** True if `path` is inside an allowlisted base, or the paths dimension is disabled. */
  allowPath(path: string): boolean;
  /** True if the command's first token is allowlisted (and no shell runner / metacharacter), or the commands dimension is disabled. */
  allowCommand(cmd: string): boolean;
  readonly pathsEnabled: boolean;
  readonly commandsEnabled: boolean;
}
