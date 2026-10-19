import { realpathSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import { GuardedReadError, refuseSymlink } from '../internal/guarded-read.js';
import { MAX_SKILL_PROMPT_CHARS } from '../internal/limits.js';
import { SKILL_NONCE_BYTES, skillSection } from '../internal/skill-section.js';
import { sanitizeControlChars, stripBidi } from '../internal/sanitize.js';
import { load } from './load.js';
import type { Skill, SkillErrorKind } from './types.js';

/**
 * Read-only static checks over a skills directory (issue #196). Everything the
 * loader already decides (read, parse and schema errors, the per-file size cap,
 * the symlink containment below the root) is REUSED by calling `load()`, never
 * re-implemented, so lint and a real run can never disagree about what a valid
 * skill is. Lint adds only the checks the loader has no reason to make:
 * duplicate names, a skill the session would drop for the prompt budget (alone or in aggregate), and relative
 * references that do not resolve.
 *
 * "Trigger condition first" from the issue is deliberately absent: it is not
 * mechanically checkable.
 */
export type LintRule =
  | SkillErrorKind
  | 'duplicate-name'
  | 'body-size'
  | 'aggregate-budget'
  | 'dangling-reference';

export interface LintFinding {
  /** Path relative to the linted root ('.' for the root itself). */
  file: string;
  rule: LintRule;
  /** JSON pointer to the failing frontmatter field, for schema findings. */
  field?: string;
  message: string;
}

export interface LintReport {
  root: string;
  /** Skills that passed the loader (the ones the semantic checks ran over). */
  skillsChecked: number;
  findings: LintFinding[];
}

/** The root cannot be linted at all (CLI exit 2), as opposed to a finding (exit 1). */
export class SkillsLintRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillsLintRootError';
  }
}

const sanitize = (text: string): string => stripBidi(sanitizeControlChars(text));

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Same root semantics as the `run` wiring (R-20 / #114, leaf-only): a symlink
 * AT the named directory is refused, anything below it is left to the loader's
 * own containment walk. A root that is missing, unreadable or not a directory
 * is a usage error, not a finding.
 */
function resolveRoot(dir: string): { root: string; realRoot: string } {
  const root = resolve(dir);
  try {
    refuseSymlink(root, 'skills directory');
  } catch (error: unknown) {
    if (error instanceof GuardedReadError) {
      throw new SkillsLintRootError(`refusing to lint skills: ${error.message}`);
    }
    throw error;
  }
  try {
    if (!statSync(root).isDirectory()) {
      throw new SkillsLintRootError(`not a directory: ${root}`);
    }
    return { root, realRoot: realpathSync(root) };
  } catch (cause: unknown) {
    if (cause instanceof SkillsLintRootError) throw cause;
    throw new SkillsLintRootError(`cannot read ${root}: ${errorMessage(cause)}`);
  }
}

/** Blank out fenced code blocks and inline code spans: links there are examples, not references. */
function stripCode(markdown: string): string {
  const kept: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of markdown.split('\n')) {
    if (fence === null) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (open?.[1] !== undefined) {
        fence = { char: open[1].charAt(0), length: open[1].length };
        continue;
      }
      kept.push(line.replace(/`[^`\n]*`/g, ''));
    } else {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close?.[1] !== undefined && close[1].charAt(0) === fence.char && close[1].length >= fence.length) {
        fence = null;
      }
    }
  }
  return kept.join('\n');
}

const INLINE_LINK = /\]\(\s*(<[^>\n]*>|[^)\s]*)/g;
const LINK_DEFINITION = /^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The distinct relative file references in a body, as written. */
function relativeReferences(body: string): string[] {
  const text = stripCode(body);
  const found = new Set<string>();
  for (const pattern of [INLINE_LINK, LINK_DEFINITION]) {
    for (const match of text.matchAll(pattern)) {
      const raw = (match[1] ?? '').replace(/^<|>$/g, '');
      if (raw === '' || raw.startsWith('#') || raw.startsWith('/') || URL_SCHEME.test(raw)) continue;
      found.add(raw);
    }
  }
  return [...found];
}

function decodeTarget(raw: string): string {
  const path = raw.split(/[#?]/, 1)[0] ?? '';
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** True when `reference` resolves, through symlinks, to a regular file inside the root. */
function resolvesInsideRoot(skill: Skill, reference: string, realRoot: string): boolean {
  const target = resolve(dirname(skill.path), decodeTarget(reference));
  try {
    const real = realpathSync(target);
    return real.startsWith(realRoot + sep) && statSync(real).isFile();
  } catch {
    return false;
  }
}

export function lintSkills(dir: string): LintReport {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new TypeError(`dir must be a non-empty string, got ${String(dir)}`);
  }
  const { root, realRoot } = resolveRoot(dir);
  const loaded = load(root);
  const cleanRoot = sanitize(root);
  const rel = (file: string): string => {
    const path = relative(cleanRoot, file);
    return sanitize(path === '' ? '.' : path.split(sep).join('/'));
  };

  const findings: LintFinding[] = loaded.errors.map((error) => ({
    file: rel(error.file),
    rule: error.kind,
    ...(error.field !== undefined && { field: error.field }),
    message: error.message,
  }));

  // The session injects `skillSection(...).section` joined by a 2-character
  // separator and drops a skill whose `section.length + 2` exceeds what is
  // left of MAX_SKILL_PROMPT_CHARS, in load order (buildSystemPrompt). The
  // nonce is fixed-length hex (SKILL_NONCE_BYTES * 2 characters), so any
  // value of that length yields the exact section length a real run sees.
  // Not modelled: skills a run blocks for an injection hit are dropped BEFORE
  // this budget loop, so a run's remaining budget can be larger than the one
  // computed here (the README says so).
  const nonce = '0'.repeat(SKILL_NONCE_BYTES * 2);
  let remaining = MAX_SKILL_PROMPT_CHARS;
  const budgetFindings = new Map<Skill, LintFinding>();
  for (const skill of loaded.skills) {
    const cost = skillSection(skill, nonce).section.length + 2;
    if (cost <= remaining) {
      remaining -= cost;
    } else {
      budgetFindings.set(skill, {
        file: rel(skill.path),
        rule: cost > MAX_SKILL_PROMPT_CHARS ? 'body-size' : 'aggregate-budget',
        message:
          cost > MAX_SKILL_PROMPT_CHARS
            ? `skill section is ${cost} characters including its 2-character separator; more than the ` +
              `${MAX_SKILL_PROMPT_CHARS}-character skill prompt budget, so a run always drops this skill`
            : `skill section is ${cost} characters including its 2-character separator; only ${remaining} ` +
              `of the ${MAX_SKILL_PROMPT_CHARS}-character skill prompt budget are left after the earlier ` +
              'skills in load order, so a run drops this skill',
      });
    }
  }

  const byName = new Map<string, Skill[]>();
  for (const skill of loaded.skills) {
    byName.set(skill.name, [...(byName.get(skill.name) ?? []), skill]);
  }
  for (const skill of loaded.skills) {
    const file = rel(skill.path);
    const twins = (byName.get(skill.name) ?? []).filter((other) => other !== skill);
    if (twins.length > 0) {
      findings.push({
        file,
        rule: 'duplicate-name',
        message: sanitize(
          `duplicate skill name '${skill.name}'; also defined in ${twins.map((t) => rel(t.path)).join(', ')}`,
        ),
      });
    }
    const budget = budgetFindings.get(skill);
    if (budget !== undefined) findings.push(budget);
    for (const reference of relativeReferences(skill.body)) {
      if (!resolvesInsideRoot(skill, reference, realRoot)) {
        findings.push({
          file,
          rule: 'dangling-reference',
          message: sanitize(
            `relative reference ${JSON.stringify(reference)} does not resolve to a file inside the skills directory`,
          ),
        });
      }
    }
  }
  return { root, skillsChecked: loaded.skills.length, findings };
}
