// Issue #188 (ADR-0042): a built-in, non-configurable deny on agent writes to
// the harness's own state, so a model cannot change the policy, budget,
// telemetry or skills that govern this run or the next. No settings key reads
// or removes it; `registerSecurityHooks` registers it first.
//
// Protected (Jackson's ruling 29/10/2026): both `.harness` directories whole
// (`~/.harness/`, `<cwd>/.harness/`), the run's skills root, and the `--db`
// file with its SQLite sidecars when it lies outside them.
//
// Unlike the paths gate (ADR-0015 §2, lexical only) this guard ALSO compares
// real paths, so an alias set up before the call (a symlinked file or parent
// directory) is caught. It cannot close a link created between the check and
// the write, nor a hard link: TOCTOU and inode aliasing are documented limits.
// The Bash/Monitor check denies any MENTION of a protected path; it is
// defence in depth, bypassable by variables, globs, `cd` and interpreters.
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { CASE_INSENSITIVE_PLATFORM, canonicalizePath, TOOL_TARGET_FIELDS } from '../internal/tool-targets.js';
import type { PreToolLike } from './pre-tool-like.js';

/** The one reason the model reads. Fixed text: it never echoes a path (ADR-0031). */
export const SELF_PROTECTION_REASON =
  "self-protection: the agent may not change the harness's own settings, telemetry or skills; " +
  'edit the file yourself if the change is intended (ADR-0042)';

export class SelfProtectionViolation extends Error {
  constructor() {
    super(SELF_PROTECTION_REASON);
    this.name = 'SelfProtectionViolation';
  }
}

/** SQLite's sidecars for a WAL database (the telemetry store sets journal_mode = WAL). */
const DB_SIDECARS = ['', '-wal', '-shm', '-journal'] as const;

interface ProtectedRoot {
  /** 'dir' protects the path and everything under it; 'file' only the path itself. */
  readonly kind: 'dir' | 'file';
  /** Canonical forms: as written, and by real path when that differs. */
  readonly forms: readonly string[];
  /** Spellings a shell command could use for it (absolute, `~`, `$HOME`, cwd-relative). */
  readonly needles: readonly Needle[];
}

interface Needle {
  readonly text: string;
  /** A relative spelling must start at a word boundary, or `skills` would match `myskills`. */
  readonly relative: boolean;
}

export interface ProtectedRoots {
  readonly roots: readonly ProtectedRoot[];
  /** Canonical home, for expanding a `~` target. */
  readonly home: string;
}

export interface ProtectedRootsInput {
  userDir: string;
  projectDir: string;
  /** The run's skills root, resolved against `projectDir`; null when the run loads none. */
  skillsDir: string | null;
  /** The telemetry DB path; `:memory:` or null protects nothing extra. */
  dbPath: string | null;
}

function fold(text: string): string {
  const nfc = text.normalize('NFC');
  return CASE_INSENSITIVE_PLATFORM ? nfc.toLowerCase() : nfc;
}

/**
 * The real path of `path`, or of its nearest existing ancestor with the rest
 * appended, so a file that does not exist yet under a symlinked directory
 * still resolves. Null only when no ancestor resolves (never "allow").
 */
function realNearest(path: string): string | null {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      tail.push(basename(current));
      current = parent;
    }
  }
}

function forms(path: string): string[] {
  const lexical = canonicalizePath(path);
  const real = realNearest(path);
  const realForm = real === null ? null : canonicalizePath(real);
  return realForm === null || realForm === lexical ? [lexical] : [lexical, realForm];
}

function under(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function needlesFor(rootForms: readonly string[], homeForms: readonly string[], projectForms: readonly string[]): Needle[] {
  const out: Needle[] = [];
  for (const form of rootForms) {
    out.push({ text: form, relative: false });
    for (const home of homeForms) {
      if (form !== home && under(form, home)) {
        const rest = form.slice(home.length);
        for (const prefix of ['~', '$HOME', '${HOME}']) out.push({ text: fold(prefix) + rest, relative: false });
      }
    }
    for (const project of projectForms) {
      if (form !== project && under(form, project)) {
        const rel = form.slice(project.length + 1);
        out.push({ text: rel, relative: true }, { text: `./${rel}`, relative: true });
      }
    }
  }
  return out;
}

/** Builds the protected set once per session, before any tool call. */
export function buildProtectedRoots(input: ProtectedRootsInput): ProtectedRoots {
  const homeForms = forms(input.userDir);
  const projectForms = forms(input.projectDir);
  const dirs = [join(input.userDir, '.harness'), join(input.projectDir, '.harness')];
  if (input.skillsDir !== null) dirs.push(resolve(input.projectDir, input.skillsDir));
  const files: string[] = [];
  if (input.dbPath !== null && input.dbPath !== ':memory:' && input.dbPath !== '') {
    const db = resolve(input.projectDir, input.dbPath);
    for (const suffix of DB_SIDECARS) files.push(db + suffix);
  }
  const root = (kind: 'dir' | 'file', path: string): ProtectedRoot => {
    const f = forms(path);
    return { kind, forms: f, needles: needlesFor(f, homeForms, projectForms) };
  };
  return {
    roots: [...dirs.map((d) => root('dir', d)), ...files.map((f) => root('file', f))],
    home: homeForms[0] ?? canonicalizePath(input.userDir),
  };
}

function targetIsProtected(target: string, roots: ProtectedRoots): boolean {
  const expanded = target === '~' || target.startsWith('~/') ? roots.home + target.slice(1) : target;
  const candidates = forms(expanded);
  return roots.roots.some((root) =>
    root.forms.some((form) => candidates.some((c) => (root.kind === 'dir' ? under(c, form) : c === form))),
  );
}

// After a needle: end of the command, a path separator, or anything a shell
// treats as a word or redirection boundary. A db needle is a 'file' root, so
// `tel.db.txt` (followed by `.`) is not a mention of `tel.db`.
const AFTER = /^($|[\s/'"`<>|;&)(:=,])/u;
// Before a RELATIVE needle only: an absolute or `~` spelling is unambiguous.
const BEFORE = /[\s'"`<>|;&(=:,]$/u;

function commandMentions(command: string, roots: ProtectedRoots): boolean {
  const folded = fold(command);
  return roots.roots.some((root) =>
    root.needles.some((needle) => {
      for (let at = folded.indexOf(needle.text); at !== -1; at = folded.indexOf(needle.text, at + 1)) {
        const before = folded.slice(0, at);
        const after = folded.slice(at + needle.text.length);
        if (needle.relative && before !== '' && !BEFORE.test(before)) continue;
        if (AFTER.test(after)) return true;
      }
      return false;
    }),
  );
}

/**
 * The pre-tool handler. A writer tool (`writes: true` in the shared table)
 * whose target is protected, or whose target is not a string, is denied; a
 * command tool that mentions a protected path, or whose command is not a
 * string, is denied. Reads and every other tool pass to the next gate.
 */
export function selfProtectionHook(roots: ProtectedRoots): (payload: PreToolLike) => Promise<void> {
  return (payload) => {
    const gate = TOOL_TARGET_FIELDS[payload.tool];
    if (gate === undefined) return Promise.resolve();
    const value = (payload.args as Record<string, unknown> | null | undefined)?.[gate.field];
    if (gate.kind === 'command') {
      if (typeof value !== 'string' || commandMentions(value, roots)) return Promise.reject(new SelfProtectionViolation());
      return Promise.resolve();
    }
    if (gate.writes !== true) return Promise.resolve();
    if (typeof value !== 'string' || targetIsProtected(value, roots)) return Promise.reject(new SelfProtectionViolation());
    return Promise.resolve();
  };
}
