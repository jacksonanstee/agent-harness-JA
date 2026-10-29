// Issue #188 (ADR-0042): a built-in, non-configurable deny on agent writes to
// the harness's own state, so a model cannot change the policy, budget,
// telemetry or skills that govern this run or the next. No settings key reads
// or removes it; `registerSecurityHooks` registers it first.
//
// Protected (Jackson's ruling 29/10/2026): both `.harness` directories whole
// (`~/.harness/`, `<cwd>/.harness/`), the run's skills root, and the `--db`
// file with its SQLite sidecars when it lies outside them.
//
// Unlike the paths gate (ADR-0015 §2, lexical only) this guard ALSO resolves
// real paths, walking the RAW components as the kernel does: each symlink is
// followed (a dangling one too) BEFORE a later `..` is applied, so an alias
// set up before the call is caught. It cannot close a link created between
// the check and the write, nor a hard link: TOCTOU and inode aliasing are the
// documented limits (R-23). The Bash/Monitor check expands `HOME` and `~`
// spellings, splits the command into shell-style words and runs every
// candidate path (a word with a `/`, its pieces, and a bare argument,
// quoted or not) through the same real-path test, plus any absolute mention; it is
// defence in depth, bypassable by a path built at run time.
import { lstatSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

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
/**
 * Symlink hops followed in TOTAL per path before giving up, as Linux counts
 * them (40; macOS's own limit is 32). A per-nesting limit is not enough: a doubling link tree
 * (`Ln -> L(n-1)/L(n-1)`) is exponential in total hops (docs parity H1).
 */
const MAX_LINK_HOPS = 40;

export interface ProtectedRoot {
  /** 'dir' protects the path and everything under it; 'file' only the path itself. */
  readonly kind: 'dir' | 'file';
  /** Canonical forms: as written, and by real path when that differs. */
  readonly forms: readonly string[];
}

export interface ProtectedRoots {
  readonly roots: readonly ProtectedRoot[];
  /** The user directory as given, for expanding `~` and `$HOME`. */
  readonly home: string;
  /** The base a relative target or command word resolves against. */
  readonly cwd: string;
}

export interface ProtectedRootsInput {
  userDir: string;
  /**
   * The working directory the SDK child inherits: relative targets and
   * relative command words resolve against it, never `process.cwd()`.
   */
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

/** Joins without normalising, so a `..` survives to the component walk. */
function rawAbsolute(path: string, cwd: string): string {
  return isAbsolute(path) ? path : `${cwd}${sep}${path}`;
}

/**
 * The real path of `path` as the kernel would resolve it: components are
 * taken left to right, each existing symlink is followed (a dangling link's
 * target too), and `..` is applied to the RESOLVED prefix. A component that
 * does not exist is kept as written. Null when the shared hop budget runs out
 * or a link vanishes while it is read.
 */
function realResolve(path: string, budget: { hops: number } = { hops: MAX_LINK_HOPS }): string | null {
  const { root } = parse(path);
  let current = root;
  for (const part of path.slice(root.length).split(sep)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    let isLink = false;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch {
      // Missing (or unreadable): keep it as written; later parts are kept too.
    }
    if (!isLink) {
      current = next;
      continue;
    }
    if (budget.hops <= 0) return null;
    budget.hops -= 1;
    let target: string;
    try {
      target = readlinkSync(next);
    } catch {
      return null; // the link changed under us: unresolvable, never "allow"
    }
    const resolved = realResolve(isAbsolute(target) ? target : `${current}${sep}${target}`, budget);
    if (resolved === null) return null;
    current = resolved;
  }
  return current;
}

/**
 * Canonical forms of an ABSOLUTE path: as written (lexically resolved) and by
 * real path. `resolved` is false when the real path could not be followed
 * (hop limit, a link that vanished), which a TARGET treats as protected.
 */
function forms(absolute: string): { forms: string[]; resolved: boolean } {
  const lexical = canonicalizePath(absolute);
  const real = realResolve(absolute);
  if (real === null) return { forms: [lexical], resolved: false };
  const realForm = canonicalizePath(real);
  return { forms: realForm === lexical ? [lexical] : [lexical, realForm], resolved: true };
}

function under(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Builds the protected set once per session, before any tool call. */
export function buildProtectedRoots(input: ProtectedRootsInput): ProtectedRoots {
  const cwd = resolve(input.projectDir);
  const dirs = [join(input.userDir, '.harness'), join(cwd, '.harness')];
  if (input.skillsDir !== null) dirs.push(resolve(cwd, input.skillsDir));
  const files: string[] = [];
  if (input.dbPath !== null && input.dbPath !== ':memory:' && input.dbPath !== '') {
    const db = resolve(cwd, input.dbPath);
    for (const suffix of DB_SIDECARS) files.push(db + suffix);
  }
  const root = (kind: 'dir' | 'file', path: string): ProtectedRoot => ({ kind, forms: forms(resolve(path)).forms });
  return {
    roots: [...dirs.map((d) => root('dir', d)), ...files.map((f) => root('file', f))],
    home: resolve(input.userDir),
    cwd,
  };
}

function expandTilde(path: string, home: string): string {
  return path === '~' || path.startsWith('~/') ? home + path.slice(1) : path;
}

function isProtected(path: string, roots: ProtectedRoots): boolean {
  const target = forms(rawAbsolute(expandTilde(path, roots.home), roots.cwd));
  if (!target.resolved) return true;
  return roots.roots.some((root) =>
    root.forms.some((form) => target.forms.some((c) => (root.kind === 'dir' ? under(c, form) : c === form))),
  );
}

/**
 * The command with `HOME` and `~` spellings replaced, for matching only:
 * every `${HOME…}` form (one nesting level) and `$HOME` become the user
 * directory, a word-initial `~` too and `~+` the working directory; the `$`
 * of ANSI-C `$'…'` quoting is dropped. Not a shell: a path built at run time
 * still gets past it (R-23).
 */
function expandHome(command: string, roots: ProtectedRoots): string {
  return command
    .replace(/\$(?=['"])/gu, '')
    .replace(/\$\{HOME(?:[^{}]|\{[^{}]*\})*\}/gu, roots.home)
    .replace(/\$HOME(?![A-Za-z0-9_])/gu, roots.home)
    .replace(/(^|[\s=:(<>|;&`'"])~\+(?=\/|$|[\s;&|)<>'"])/gu, `$1${roots.cwd}`)
    .replace(/(^|[\s=:(<>|;&`'"])~(?=\/|$|[\s;&|)<>'"])/gu, `$1${roots.home}`);
}

/**
 * Shell-style words: quotes and backslashes are removed and quoted parts
 * join their neighbours (`"$HOME"/.harness` is one word), split at unquoted
 * whitespace and operators. Not a parser: no expansion, no here-docs.
 */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? '';
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) word += command[(i += 1)] ?? '';
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === '\\' && i + 1 < command.length) {
      word += command[(i += 1)] ?? '';
      started = true;
    } else if (/[\s;&|()<>`]/u.test(ch)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += ch;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/**
 * The candidate paths in a command. A word with a `/` is a path, and so is
 * each piece of it split at spaces, commas, quotes, brackets, `;` and braces
 * (code inside one quoted argument), each `=`-separated piece, and the value
 * of a short option glued to it (`-C.harness`). A word with no space and no
 * `/`, quoted or not, is an argument, so a bare `skills` or `.harness` counts
 * as that folder (owner ruling, revised 29/10/2026: `cp -r x skills` writes);
 * quoted text with a space in it (`-m "add skills"`) is not.
 */
function candidatePaths(command: string): string[] {
  const out: string[] = [];
  for (const word of shellWords(command)) {
    const bareArgument = !/\s/u.test(word) && !word.includes('/');
    for (const piece of word.split(/[\s,'"()[\]{};]+/u)) {
      // A short option glued to its value (`-o.harness/x`, `-C.harness`).
      const glued = /^-[A-Za-z]./u.test(piece) ? [piece.slice(2)] : [];
      for (const part of [piece, ...piece.split('='), ...glued]) {
        if (part !== '' && (part.includes('/') || bareArgument)) out.push(part);
      }
    }
  }
  return out;
}

// After an absolute mention: end, a path separator, whitespace, a quote, a
// shell operator or a glob/brace character, so `~/.harness*` is a mention.
const AFTER = /^($|[\s/'"`<>|;&)(:=,*?[\]{}\\])/u;

function mentionsAbsolute(folded: string, roots: ProtectedRoots): boolean {
  return roots.roots.some((root) =>
    root.forms.some((form) => {
      for (let at = folded.indexOf(form); at !== -1; at = folded.indexOf(form, at + 1)) {
        if (AFTER.test(folded.slice(at + form.length))) return true;
      }
      return false;
    }),
  );
}

function commandIsProtected(command: string, roots: ProtectedRoots): boolean {
  const expanded = expandHome(command, roots);
  return (
    candidatePaths(expanded).some((path) => isProtected(path, roots)) ||
    mentionsAbsolute(fold(expanded.replace(/["'\\]/gu, '')), roots)
  );
}

/**
 * The pre-tool handler. A writer tool (`writes` in the shared table) whose
 * target is protected, or is not a string, is denied. A command tool whose
 * command mentions a protected path, or is present but not a string, is
 * denied; an absent command (Monitor's websocket mode) has nothing to match.
 * Reads and every tool outside the table pass to the next gate.
 */
export function selfProtectionHook(roots: ProtectedRoots): (payload: PreToolLike) => Promise<void> {
  return (payload) => {
    const gate = TOOL_TARGET_FIELDS[payload.tool];
    if (gate === undefined) return Promise.resolve();
    const value = (payload.args as Record<string, unknown> | null | undefined)?.[gate.field];
    if (gate.kind === 'command') {
      if (value === undefined) return Promise.resolve();
      if (typeof value !== 'string' || commandIsProtected(value, roots)) return Promise.reject(new SelfProtectionViolation());
      return Promise.resolve();
    }
    if (!gate.writes) return Promise.resolve();
    if (typeof value !== 'string' || isProtected(value, roots)) return Promise.reject(new SelfProtectionViolation());
    return Promise.resolve();
  };
}
