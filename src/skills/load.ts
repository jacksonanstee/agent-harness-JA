import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import matter from 'gray-matter';
import skillSchema from './schema.json' with { type: 'json' };
import type {
  LoadResult,
  Skill,
  SkillError,
  ValidationResult,
} from './types.js';

const ajv = new Ajv2020({ allErrors: true });
const validateFrontmatter = ajv.compile(skillSchema);

type Frontmatter = Omit<Skill, 'body' | 'path'>;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Always names a concrete field: for a missing required property, ajv's
 * instancePath is '' — append params.missingProperty so the pointer stays
 * useful (ADR-0006: errors point to the file and the failing field).
 */
function failingField(): string | undefined {
  const first = validateFrontmatter.errors?.[0];
  if (!first) return undefined;
  if (first.keyword === 'required') {
    const missing = (first.params as { missingProperty: string }).missingProperty;
    return `${first.instancePath}/${missing}`;
  }
  return first.instancePath || undefined;
}

export function validate(file: string): ValidationResult {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError(`file must be a non-empty string, got ${String(file)}`);
  }
  const path = resolve(file);

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause: unknown) {
    return fail({ file: path, kind: 'read', message: errorMessage(cause) });
  }

  let parsed: { data: unknown; content: string };
  try {
    parsed = matter(raw);
  } catch (cause: unknown) {
    return fail({ file: path, kind: 'parse', message: errorMessage(cause) });
  }

  if (!validateFrontmatter(parsed.data)) {
    return fail({
      file: path,
      kind: 'schema',
      field: failingField(),
      message: ajv.errorsText(validateFrontmatter.errors),
    });
  }

  // Safe: the frontmatter just passed schema validation against the same shape.
  const frontmatter = parsed.data as Frontmatter;
  return { ok: true, value: { ...frontmatter, body: parsed.content.trim(), path } };
}

function fail(error: SkillError): ValidationResult {
  return { ok: false, error };
}

export function load(dir: string): LoadResult {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new TypeError(`dir must be a non-empty string, got ${String(dir)}`);
  }
  const root = resolve(dir);

  try {
    if (!statSync(root).isDirectory()) {
      return {
        skills: [],
        errors: [{ file: root, kind: 'read', message: `not a directory: ${root}` }],
      };
    }
  } catch (cause: unknown) {
    return {
      skills: [],
      errors: [{ file: root, kind: 'read', message: errorMessage(cause) }],
    };
  }

  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();

  const skills: Skill[] = [];
  const errors: SkillError[] = [];
  for (const file of files) {
    const result = validate(file);
    if (result.ok) {
      skills.push(result.value);
    } else {
      errors.push(result.error);
    }
  }
  return { skills, errors };
}
