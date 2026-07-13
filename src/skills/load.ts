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
import { sanitizeControlChars, stripBidi } from '../internal/sanitize.js';

import {
  hasUnsafeFenceLanguage,
  MAX_FILE_BYTES,
  SAFE_MATTER_OPTIONS,
} from '../internal/frontmatter.js';

const ajv = new Ajv2020({ allErrors: true });
const validateFrontmatter = ajv.compile(skillSchema);

type Frontmatter = Omit<Skill, 'body' | 'path'>;

// Compile-time parity guard between schema.json and the Frontmatter type:
// the `parsed.data as Frontmatter` cast below is only sound while the two
// hand-maintained shapes agree on their top-level keys. Renaming a field in
// one without the other now fails typecheck instead of drifting silently.
type KeysMatch<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
true satisfies KeysMatch<keyof typeof skillSchema.properties, keyof Frontmatter>;

// Diagnostics carry attacker-influenced strings (filenames, frontmatter keys,
// parser messages) to the operator's terminal: strip C0/C1 AND bidi controls
// (issue #24, Trojan-Source) so a hostile name cannot render reversed.
const sanitize = (text: string): string => stripBidi(sanitizeControlChars(text));

// Frontmatter safety guards (fence-language RCE, engine neutralization, size
// cap) are shared with the eval task parser: src/internal/frontmatter.ts.

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function skillError(
  file: string,
  kind: SkillError['kind'],
  message: string,
  field?: string,
): SkillError {
  return {
    file: sanitize(file),
    kind,
    ...(field !== undefined && { field: sanitize(field) }),
    message: sanitize(message),
  };
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
 * Refuse to examine more than this many directory entries in total across
 * the whole scan (resource-exhaustion guard, the breadth counterpart to
 * MAX_SCAN_DEPTH): depth bounds nesting but not the number of files/dirs at
 * or below any one level, so a shallow pack shipping tens of thousands of
 * entries would otherwise still turn a load() call into a denial-of-service
 * nuisance.
 */
const MAX_SCAN_ENTRIES = 10_000;

/**
 * Collect .md files under `root` with a manual walk instead of
 * readdirSync({recursive: true}): whether recursive readdir descends into
 * symlinked directories differs across Node versions (Node 20 does not,
 * Node 25 does), so relying on it makes the symlink containment gate
 * version-dependent. Walking ourselves gives one behavior everywhere: any
 * symlink is resolved at the point it is encountered and refused if its real
 * path escapes the skills root; symlinks resolving inside the root are
 * followed normally.
 *
 * `maxEntries` defaults to MAX_SCAN_ENTRIES; the parameter exists so the cap
 * can be exercised in tests without generating a MAX_SCAN_ENTRIES-sized
 * tree. Production code (`load`) always calls this with the default, so the
 * cap is not new configuration surface — just a testable seam.
 */
export function scanMarkdownFiles(
  root: string,
  realRoot: string,
  maxEntries: number = MAX_SCAN_ENTRIES,
): { files: string[]; errors: SkillError[] } {
  const files: string[] = [];
  const errors: SkillError[] = [];
  // Guard against symlink cycles that stay inside the root (e.g.
  // pack/sub/loop -> pack/sub): each directory is visited once by real path.
  // The parent's real path is threaded through the walk so a plain (non-
  // symlink) subdirectory's real path is a cheap join, not a realpath call.
  const visitedDirs = new Set<string>([realRoot]);
  let entryCount = 0;
  let entryCapHit = false;

  /**
   * Order contract: within one directory, entries are sorted ordinally by
   * bare name (not localeCompare — see below) and walked in that order,
   * descending into a subdirectory the moment it's reached (preorder,
   * depth-first) rather than after finishing the rest of the level. So a
   * directory sorts before a sibling file only when its bare name does —
   * e.g. `sub` (dir) sorts before `sub.md` (file) because "sub" < "sub.md"
   * ordinally, so every file under `sub/` is emitted before `sub.md`. This
   * differs from sorting fully-materialized file paths, where `sub.md`
   * would sort before `sub/nested.md` ('.' < '/').
   */
  const walk = (
    currentDir: string,
    currentRealDir: string,
    depth: number,
    ancestorRealDirs: ReadonlySet<string>,
  ): void => {
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
      entryCount += 1;
      if (entryCount > maxEntries) {
        // Fail-open, like EACCES above: stop scanning and keep whatever was
        // already found rather than throwing away partial results.
        if (!entryCapHit) {
          entryCapHit = true;
          errors.push(
            skillError(
              root,
              'read',
              `refusing to scan: exceeds maximum entry count of ${maxEntries}`,
            ),
          );
        }
        return;
      }
      const path = join(currentDir, entry.name);
      let realPath = join(currentRealDir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      const isSymlink = entry.isSymbolicLink();
      if (isSymlink) {
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
        if (visitedDirs.has(realPath)) {
          // Diamond symlink: a second in-root symlink resolving to a real
          // directory already loaded via a different path. A cycle back
          // onto an ancestor (already on the current walk stack) stays
          // silent — that's the same content we're already inside, nothing
          // goes missing. A symlink resolving to a real directory visited
          // elsewhere in the tree does mean this path's skills are only
          // reachable via the other one, which is worth a non-fatal
          // diagnostic rather than a silent drop.
          if (isSymlink && !ancestorRealDirs.has(realPath)) {
            errors.push(
              skillError(
                path,
                'read',
                'refusing to load a second time: already reachable via a different symlink to the same real directory',
              ),
            );
          }
          continue;
        }
        visitedDirs.add(realPath);
        walk(path, realPath, depth + 1, new Set([...ancestorRealDirs, realPath]));
      } else if (isFile && entry.name.endsWith('.md')) {
        files.push(path);
      }
    }
  };
  walk(root, realRoot, 0, new Set([realRoot]));
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
