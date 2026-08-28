export type PermissionDecision = 'allow' | 'ask' | 'deny';

export interface PermissionRule {
  /** Tool name, exact ('Bash') or trailing-* glob ('mcp__*', '*'). */
  readonly tool: string;
  /**
   * Optional argument prefix-glob, matched against a canonical string
   * extracted from the tool args: `args.command` for Bash, `args.file_path`
   * for Read/Write/Edit, else `JSON.stringify(args)`. Same trailing-* glob
   * semantics as `tool`. Deep path/command allowlisting is S-4's job
   * (ADR-0014 §1).
   */
  readonly match?: string;
  readonly decision: PermissionDecision;
}

/**
 * Which settings layer a rule came from. Layer is load-bearing, not
 * cosmetic: winners are resolved per layer and combined by max severity, so
 * a project layer can tighten but never loosen user policy through RULES
 * (ADR-0014 §5). The scalar `defaultDecision` is the exemption: it composes
 * by override, project over user, which is the widening channel recorded as
 * security-model R-8, not a tighten-only value.
 */
export type SettingsLayer = 'user' | 'project';

export interface LayeredRule extends PermissionRule {
  readonly layer: SettingsLayer;
}

export interface PermissionSettings {
  readonly defaultDecision?: PermissionDecision;
  readonly rules: readonly PermissionRule[];
}

export interface EvaluatorOptions {
  readonly rules?: readonly LayeredRule[];
  /** Decision for tools no rule matches. Default 'allow' (ADR-0014 §3). */
  readonly defaultDecision?: PermissionDecision;
}

export interface Evaluation {
  readonly decision: PermissionDecision;
  /**
   * The winning rule's position within its OWN layer's settings file (the
   * order in that file), NOT the combined user+project list — the reason
   * string's `[rule N, layer]` must index into the one file the layer tag
   * names (ADR-0031). Null when defaultDecision applied. `ruleIndex` is only
   * a complete identity together with `layer`: the same index exists in both
   * files.
   */
  readonly ruleIndex: number | null;
  /**
   * The layer the winning rule came from; the structured half of the reason
   * string's `[rule N, layer]`. Null when defaultDecision applied (review
   * finding on ADR-0031: a per-layer index without its layer recreates for
   * API consumers the mis-attribution the per-layer change fixed for
   * operators).
   */
  readonly layer: SettingsLayer | null;
  /** Human-readable reason, safe to surface in denial messages. */
  readonly reason: string;
}

export interface PermissionEvaluator {
  evaluate(tool: string, args: unknown): Evaluation;
}

export interface PromptRequest {
  readonly tool: string;
  readonly args: unknown;
  readonly reason: string;
}

/**
 * Resolves an 'ask' decision. Absent prompter, a thrown error, or a rejected
 * promise all fail closed to deny (ADR-0014 §4).
 */
export type Prompter = (req: PromptRequest) => Promise<boolean>;
