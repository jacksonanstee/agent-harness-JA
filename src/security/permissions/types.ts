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
 * a project layer can tighten but never loosen user policy (ADR-0014 §5).
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
  /** Index into the evaluator's rule list; null when defaultDecision applied. */
  readonly ruleIndex: number | null;
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
