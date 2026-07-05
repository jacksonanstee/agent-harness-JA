import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
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

// Compile-time parity guard between schema.json and the Frontmatter type:
// the `parsed.data as Frontmatter` cast below is only sound while the two
// hand-maintained shapes agree on their top-level keys. Renaming a field in
// one without the other now fails typecheck instead of drifting silently.
type KeysMatch<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
true satisfies KeysMatch<keyof typeof skillSchema.properties, keyof Frontmatter>;

/** Refuse to read skill files larger than this (resource-exhaustion guard). */
const MAX_FILE_BYTES = 1_000_000;

// Keep in lockstep with CONTROL_CHARS in src/router/route.ts. Same
// log-injection defence, more hostile sink: YAML parse errors embed raw
// snippets of the offending file, so untrusted skill packs control bytes of
// every SkillError message (ANSI escapes, fake log lines) unless stripped.
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F\u2028\u2029]/g;

function sanitize(text: string): string {
  return text.replace(CONTROL_CHARS, ' ');
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function skillError(
  file: string,
  kind: SkillError['kind'],
  message: string,
  field?: string,
): SkillError {
  return { file: sanitize(file), kind, ...(field !== undefined && { field }), message: sanitize(message) };
}

/**
 * Always names a concrete field (ADR-0006: errors point to the file and the
 * failing field). An unknown key is preferred over a missing required one:
 * a typo'd key (`naem:`) raises both, and pointing at the typo is more
 * useful than pointing at the field it shadowed. For missing required
 * properties ajv's instancePath is '' — append params.missingProperty.
 */
function failingField(): string | undefined {
  const errors = validateFrontmatter.errors ?? [];
  const unknownKey = errors.find((e) => e.keyword === 'additionalProperties');
  if (unknownKey) {
    const extra = (unknownKey.params as { additionalProperty: string }).additionalProperty;
    return `${unknownKey.instancePath}/${extra}`;
  }
  const first = errors[0];
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
    const { size } = statSync(path);
    if (size > MAX_FILE_BYTES) {
      return fail(
        skillError(path, 'read', `skill file exceeds ${MAX_FILE_BYTES} bytes (got ${size})`),
      );
    }
    raw = readFileSync(path, 'utf8');
  } catch (cause: unknown) {
    return fail(skillError(path, 'read', errorMessage(cause)));
  }

  let parsed: { data: unknown; content: string };
  try {
    // The empty options object is load-bearing: gray-matter only caches
    // (process-wide, keyed by content, never evicted) when called with NO
    // options. Cached results also share one mutable `data` object across
    // identical files.
    parsed = matter(raw, {});
  } catch (cause: unknown) {
    return fail(skillError(path, 'parse', errorMessage(cause)));
  }

  if (!validateFrontmatter(parsed.data)) {
    return fail(
      skillError(path, 'schema', ajv.errorsText(validateFrontmatter.errors), failingField()),
    );
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

  let realRoot: string;
  try {
    if (!statSync(root).isDirectory()) {
      return {
        skills: [],
        errors: [skillError(root, 'read', `not a directory: ${root}`)],
      };
    }
    realRoot = realpathSync(root);
  } catch (cause: unknown) {
    return {
      skills: [],
      errors: [skillError(root, 'read', errorMessage(cause))],
    };
  }

  let files: string[];
  try {
    files = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
  } catch (cause: unknown) {
    // e.g. EACCES on a subdirectory mid-scan: environmental, not programmer
    // error — surface it, don't crash the whole load.
    return {
      skills: [],
      errors: [skillError(root, 'read', errorMessage(cause))],
    };
  }

  const skills: Skill[] = [];
  const errors: SkillError[] = [];
  for (const file of files) {
    // Containment gate: Node's recursive readdir DOES descend into symlinked
    // directories (verified on Node 25), so a skill pack shipping a dir
    // symlink could otherwise exfiltrate arbitrary .md files into the agent's
    // context. Only load files whose real path stays under the skills root.
    let real: string;
    try {
      real = realpathSync(file);
    } catch (cause: unknown) {
      errors.push(skillError(file, 'read', errorMessage(cause)));
      continue;
    }
    if (!real.startsWith(realRoot + sep)) {
      errors.push(
        skillError(file, 'read', 'refusing to load: resolves outside the skills directory'),
      );
      continue;
    }
    const result = validate(file);
    if (result.ok) {
      skills.push(result.value);
    } else {
      errors.push(result.error);
    }
  }
  return { skills, errors };
}
