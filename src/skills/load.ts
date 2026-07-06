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

// gray-matter picks its parse engine from a language tag on the opening
// fence (`---js`, `---coffee`, ...). Its built-in `javascript` engine
// `eval()`s the frontmatter body — arbitrary code execution from an
// untrusted skill file, BEFORE schema validation ever runs. Two independent
// guards close this:
//   1. FENCE_LANGUAGE rejects any fence whose language is not empty/yaml/yml
//      before matter() is called at all.
//   2. SAFE_MATTER_OPTIONS replaces the `javascript`/`js` engines with ones
//      that throw, so no eval happens even if guard (1) is ever bypassed.
// Only YAML frontmatter is a valid skill (ADR-0006), so this loses nothing.
// Matches exactly `---` (gray-matter's delimiter), not `---+`: the greedy
// `---+` shared a `-` with the `[^\r\n]*` capture, giving O(n^2) backtracking
// on a long dash run (a ~1 MB dash file hung validate() for minutes). Exactly
// three dashes is also gray-matter's real behavior — it early-returns when the
// 4th char is another dash — so this is stricter-or-equal, never looser.
const FENCE_LANGUAGE = /^\uFEFF?---([^\r\n]*)(?:\r?\n|$)/;

function refuseNonYaml(): never {
  throw new Error('non-YAML frontmatter engine is disabled');
}

const refuseEngine = { parse: refuseNonYaml, stringify: refuseNonYaml };

const SAFE_MATTER_OPTIONS = {
  engines: { javascript: refuseEngine, js: refuseEngine },
} as const;

function hasUnsafeFenceLanguage(raw: string): boolean {
  const match = FENCE_LANGUAGE.exec(raw);
  if (match === null) return false;
  const language = (match[1] ?? '').trim();
  return language !== '' && !/^ya?ml$/i.test(language);
}

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

  if (hasUnsafeFenceLanguage(raw)) {
    return fail(
      skillError(path, 'parse', 'frontmatter must be YAML; non-YAML fence language is refused'),
    );
  }

  let parsed: { data: unknown; content: string };
  try {
    // SAFE_MATTER_OPTIONS neutralizes the js engine (see above). Passing any
    // options object also disables gray-matter's process-wide, content-keyed,
    // never-evicted parse cache, which additionally shares one mutable `data`
    // object across identical files.
    parsed = matter(raw, SAFE_MATTER_OPTIONS);
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

/**
 * Refuse to descend past this many directory levels (resource-exhaustion
 * guard): an untrusted pack shipping thousands of nested directories would
 * otherwise overflow the call stack before the containment gate could act.
 */
const MAX_SCAN_DEPTH = 64;

/**
 * Collect .md files under `root` with a manual walk instead of
 * readdirSync({recursive: true}): whether recursive readdir descends into
 * symlinked directories differs across Node versions (Node 20 does not,
 * Node 25 does), so relying on it makes the symlink containment gate
 * version-dependent. Walking ourselves gives one behavior everywhere: any
 * symlink is resolved at the point it is encountered and refused if its real
 * path escapes the skills root; symlinks resolving inside the root are
 * followed normally.
 */
function scanMarkdownFiles(
  root: string,
  realRoot: string,
): { files: string[]; errors: SkillError[] } {
  const files: string[] = [];
  const errors: SkillError[] = [];
  // Guard against symlink cycles that stay inside the root (e.g.
  // pack/sub/loop -> pack/sub): each directory is visited once by real path.
  // The parent's real path is threaded through the walk so a plain (non-
  // symlink) subdirectory's real path is a cheap join, not a realpath call.
  const visitedDirs = new Set<string>([realRoot]);
  const walk = (currentDir: string, currentRealDir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) {
      errors.push(
        skillError(
          currentDir,
          'read',
          `refusing to scan: exceeds maximum directory depth of ${MAX_SCAN_DEPTH}`,
        ),
      );
      return;
    }
    let entries;
    try {
      // Ordinal comparator, not localeCompare: locale-aware order varies with
      // the host's ICU data, and this walk exists to be host-independent.
      entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    } catch (cause: unknown) {
      // e.g. EACCES on a subdirectory mid-scan: environmental, not programmer
      // error — surface it, don't crash the whole load.
      errors.push(skillError(currentDir, 'read', errorMessage(cause)));
      return;
    }
    for (const entry of entries) {
      const path = join(currentDir, entry.name);
      let realPath = join(currentRealDir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        // Containment gate: a skill pack shipping a symlink could otherwise
        // exfiltrate arbitrary .md files into the agent's context.
        try {
          realPath = realpathSync(path);
        } catch (cause: unknown) {
          errors.push(skillError(path, 'read', errorMessage(cause)));
          continue;
        }
        if (!realPath.startsWith(realRoot + sep)) {
          errors.push(
            skillError(path, 'read', 'refusing to load: resolves outside the skills directory'),
          );
          continue;
        }
        try {
          const stat = statSync(path);
          isDir = stat.isDirectory();
          isFile = stat.isFile();
        } catch (cause: unknown) {
          errors.push(skillError(path, 'read', errorMessage(cause)));
          continue;
        }
      }
      if (isDir) {
        if (visitedDirs.has(realPath)) continue;
        visitedDirs.add(realPath);
        walk(path, realPath, depth + 1);
      } else if (isFile && entry.name.endsWith('.md')) {
        files.push(path);
      }
    }
  };
  walk(root, realRoot, 0);
  return { files, errors };
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

  const { files, errors } = scanMarkdownFiles(root, realRoot);

  const skills: Skill[] = [];
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
