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
   *
   * TWO PASSES, NOT ONE, and the second is a property of THIS FIELD rather
   * than of session.ts. Flattened is not the same as harmless: a flattened
   * description still occupies a whole line at COLUMN 0 (the section's second),
   * so a fence marker there opens a block that swallows every later skill,
   * including the operator policy. `defangFenceOpener` breaks that marker, and
   * it must run AFTER `cleanSkillText`, never before, because cleaning turns a
   * tab into the space the fence grammar counts as indentation. A consumer that
   * copies only the charset half reopens the vector at its own sink
   * (ADR-0028 decision 8).
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
   * charset contract: session.ts `cleanSkillBody` strips control/bidi/
   * invisible chars before the system prompt, scans the raw text first, and
   * bounds the aggregate injected size. A new consumer of this field must do
   * the same at its own boundary.
   *
   * NOT `cleanSkillText`, which is what this comment said until issue #45.
   * The body keeps tab and newline, because it IS markdown and ADR-0006 makes
   * it the thing the agent reads; `cleanSkillText` is the single-line contract
   * that still applies to `name` and `description`. A consumer that copies the
   * wrong one either flattens the markdown or admits newlines into a label.
   * The consequences of the body reaching column 0 are ADR-0028's subject.
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
  /**
   * The resolved root the walk actually used (`resolve(dir)`, captured once
   * inside `load()`), threaded back so the telemetry write site can compute
   * `relative(root, skillPath)` from a HELD operand instead of a fresh
   * ambient `resolve()` — a second independent cwd read would re-open the
   * process.chdir window (ADR-0031 decision 6, issue #59 round 2). Null only
   * for a result that ran no scan (the session's skillsDir-null literal);
   * `load()` itself always sets it, including on its early error returns,
   * where it is the root the scan WOULD have used.
   */
  root: string | null;
}
