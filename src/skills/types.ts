export interface SkillTrigger {
  keywords?: string[];
  conditions?: string[];
}

export interface SkillRequires {
  tools?: string[];
}

export interface SkillMetadata {
  author?: string;
  tags?: string[];
}

export interface Skill {
  /** Schema-constrained (`^[a-z0-9]+(-[a-z0-9]+)*$`, ≤64) at load. */
  name: string;
  /**
   * RAW attacker-influenced free text (length-capped only). Deliberately not
   * sanitized at load — sinks opt in per charset contract: session.ts
   * `cleanSkillText` strips control/bidi/invisible chars before the system
   * prompt and scans the raw text. A new consumer of this field must do the
   * same at its own boundary.
   */
  description: string;
  version: string;
  trigger?: SkillTrigger;
  requires?: SkillRequires;
  metadata?: SkillMetadata;
  /**
   * Markdown body below the frontmatter, trimmed. Like `description`, this is
   * RAW attacker-influenced free text — bounded only by the loader's 1 MB
   * file cap, and deliberately not sanitized at load. Sinks opt in per
   * charset contract: session.ts `cleanSkillText` strips control/bidi/
   * invisible chars before the system prompt, scans the raw text first, and
   * bounds the aggregate injected size. A new consumer of this field must do
   * the same at its own boundary.
   */
  body: string;
  /** Absolute path of the source file. */
  path: string;
}

export type SkillErrorKind = 'read' | 'parse' | 'schema';

export interface SkillError {
  /** Absolute path of the offending file (or the directory, for a failed scan). */
  file: string;
  kind: SkillErrorKind;
  /** JSON pointer to the failing frontmatter field, e.g. '/version' or '/name' when required-missing. */
  field?: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: Skill }
  | { ok: false; error: SkillError };

export interface LoadResult {
  skills: Skill[];
  errors: SkillError[];
}
