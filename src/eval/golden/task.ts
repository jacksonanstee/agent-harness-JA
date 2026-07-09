import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import matter from 'gray-matter';
import taskSchema from './schema.json' with { type: 'json' };
import type { TaskDescriptor } from '../../router/index.js';
import {
  hasUnsafeFenceLanguage,
  MAX_FILE_BYTES,
  SAFE_MATTER_OPTIONS,
} from '../../internal/frontmatter.js';
import { sanitizeControlChars as sanitize } from '../../internal/sanitize.js';
import { stripBidi, truncateWellFormed } from '../scorecard/index.js';

const ajv = new Ajv2020({ allErrors: true });
const validateFrontmatter = ajv.compile(taskSchema);

export const DEFAULT_MAX_TURNS = 10;

interface TaskFrontmatter {
  id: string;
  descriptor?: TaskDescriptor;
  maxTurns?: number;
  skillsDir?: string;
}

// Compile-time parity guard between schema.json and TaskFrontmatter keys
// (same pattern as src/skills/load.ts). Enum VALUES are runtime-guarded by
// the schema/router lockstep test — JSON imports widen literal values.
type KeysMatch<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
true satisfies KeysMatch<keyof typeof taskSchema.properties, keyof TaskFrontmatter>;

export interface GoldenTask {
  id: string;
  /** The Markdown body below the frontmatter, trimmed. */
  prompt: string;
  descriptor?: TaskDescriptor;
  maxTurns: number;
  /** Resolved absolute; default `<task file dir>/skills` (spec decision #25). */
  skillsDir: string;
  /** Absolute path of the source file. */
  path: string;
  /** Sibling `<name>.oracle.mjs`, derived — existence checked at load time. */
  oraclePath: string;
}

export type TaskParseResult =
  | { ok: true; value: GoldenTask }
  | { ok: false; rowId: string; message: string };

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Row key for a failed parse (spec: arbiter condition 1): the frontmatter id
 * when one is extractable, else the file's basename — stable either way.
 */
function fallbackRowId(data: unknown, path: string): string {
  if (data !== null && typeof data === 'object') {
    const id = (data as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return truncateWellFormed(sanitize(id), 64);
  }
  return basename(path);
}

// Second copy of the skills loader's failingField pattern; extract to
// src/internal on a third consumer (the settings.ts / frontmatter.ts rule).
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

/**
 * Two-stage containment: a cheap lexical check (catches absolute paths and
 * `..` traversal with a clear message, no filesystem access) followed by a
 * realpath-based re-check that closes the gap the lexical check can't see —
 * a repo-committed symlink at the accepted lexical path whose TARGET escapes
 * the task directory. Without this, src/skills/load.ts's `load()` calls
 * `realpathSync(root)` and walks the symlink's target directly (e.g.
 * `skills -> /etc`), scanning and injecting arbitrary files into the system
 * prompt from pure repo data. Both sides are realpath'd, not just skillsDir,
 * because taskFileDir itself may legitimately sit behind a symlink (e.g.
 * macOS `/tmp` -> `/private/tmp`) — comparing a real path against a lexical
 * one would false-reject that case.
 */
function containSkillsDir(skillsDir: string, taskFileDir: string): string | undefined {
  if (skillsDir !== taskFileDir && !skillsDir.startsWith(taskFileDir + sep)) {
    return `skillsDir must stay within the task directory (got ${skillsDir})`;
  }
  let realSkillsDir: string;
  try {
    realSkillsDir = realpathSync(skillsDir);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // Doesn't exist (yet): nothing to walk, so nothing can escape via a
      // symlink target. src/skills/load.ts's load() already treats a missing
      // directory as a non-fatal empty load (a warning, not a crash or scan),
      // so deferring the real-path check here doesn't reopen the gap.
      return undefined;
    }
    // EACCES, ELOOP, anything else: containment can't be proven, so refuse
    // rather than silently skipping the re-check. load() would fail on the
    // same path anyway; this keeps the guard itself fail-closed.
    return `skillsDir could not be resolved for containment (${code ?? 'unknown error'})`;
  }
  const realTaskDir = realpathSync(taskFileDir);
  if (realSkillsDir !== realTaskDir && !realSkillsDir.startsWith(realTaskDir + sep)) {
    return `skillsDir must stay within the task directory (symlink escapes to ${realSkillsDir})`;
  }
  return undefined;
}

export function parseTaskFile(file: string): TaskParseResult {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError(`file must be a non-empty string, got ${String(file)}`);
  }
  const path = resolve(file);
  // rowId is bidi-stripped HERE, before assertUniqueIds ever sees it: a
  // fallback id is a hostile-repo-controllable filename/frontmatter string,
  // and cleaning after the uniqueness check would let two bidi-distinct
  // names alias to one cleaned id in the final scorecard. The message needs
  // no bidi strip — it only reaches sinks through cleanForScorecard.
  const fail = (rowId: string, message: string): TaskParseResult => ({
    ok: false,
    rowId: stripBidi(sanitize(rowId)),
    message: sanitize(message),
  });

  let raw: string;
  try {
    const { size } = statSync(path);
    if (size > MAX_FILE_BYTES) {
      return fail(basename(path), `task file exceeds ${MAX_FILE_BYTES} bytes (got ${size})`);
    }
    raw = readFileSync(path, 'utf8');
  } catch (cause: unknown) {
    return fail(basename(path), errorMessage(cause));
  }

  if (hasUnsafeFenceLanguage(raw)) {
    return fail(
      basename(path),
      'frontmatter must be YAML; non-YAML fence language is refused',
    );
  }

  let parsed: { data: unknown; content: string };
  try {
    parsed = matter(raw, SAFE_MATTER_OPTIONS);
  } catch (cause: unknown) {
    return fail(basename(path), errorMessage(cause));
  }

  if (!validateFrontmatter(parsed.data)) {
    const field = failingField();
    const detail = ajv.errorsText(validateFrontmatter.errors);
    return fail(
      fallbackRowId(parsed.data, path),
      field === undefined ? detail : `${field}: ${detail}`,
    );
  }

  // Safe: just validated against the schema whose keys the compile-time
  // guard pins to this type; descriptor enums are pinned by the lockstep
  // test. The `as unknown as` (not a plain `as`) is required because ajv's
  // `compile<T>` infers T structurally from taskSchema against
  // `JSONSchemaType<T>`; since descriptor.properties.{shape,sensitivity} use
  // `enum` without a `type`, that inference collapses to a synthetic
  // `{ [x: string]: {} }` (not `unknown`), which TS then refuses to cast
  // directly to TaskFrontmatter as an insufficient-overlap error. Routing
  // through `unknown` is the same idiom src/skills/load.ts's schema (no bare
  // `enum` fields) doesn't need.
  const frontmatter = parsed.data as unknown as TaskFrontmatter;

  const prompt = parsed.content.trim();
  if (prompt === '') {
    return fail(frontmatter.id, 'task body (the prompt) is empty');
  }

  const taskFileDir = dirname(path);
  const skillsDir = resolve(taskFileDir, frontmatter.skillsDir ?? 'skills');
  const containmentError = containSkillsDir(skillsDir, taskFileDir);
  if (containmentError !== undefined) {
    return fail(frontmatter.id, containmentError);
  }

  return {
    ok: true,
    value: {
      id: frontmatter.id,
      prompt,
      ...(frontmatter.descriptor !== undefined && { descriptor: frontmatter.descriptor }),
      maxTurns: frontmatter.maxTurns ?? DEFAULT_MAX_TURNS,
      skillsDir,
      path,
      oraclePath: join(taskFileDir, `${basename(path, '.task.md')}.oracle.mjs`),
    },
  };
}
