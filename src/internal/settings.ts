/**
 * Shared settings-file mechanics (ADR-0015, hoisted from S-3's permissions
 * loader; ADR-0034 added the hostile-file envelope): guarded read →
 * ENOENT-is-empty → JSON.parse fail-loud (naming the file, never its content)
 * → module parser with path-prefixed rethrow. Zero repo dependencies beyond
 * the other `src/internal` leaves. Policy (what keys mean) stays in each
 * module's parser; only the mechanism lives here, including the unknown-key
 * helpers both parsers use so their messages cannot drift.
 */

import { GuardedReadError, readFileGuarded } from './guarded-read.js';
import {
  sanitizeControlChars,
  stripBidi,
  stripInvisibles,
  truncateWellFormed,
} from './sanitize.js';

export type ReadFile = (path: string) => string;

/**
 * Upper bound per settings file (ADR-0034 decision 3). Project settings are
 * attacker-influenced input; the baseline loader's own figure, and a
 * thousand rules at a hundred bytes each fit under it ten times over.
 */
export const MAX_SETTINGS_BYTES = 1_000_000;

/**
 * How much of an attacker-authored token (an unknown key, a refused entry) a
 * message echoes. The message is bound for stderr; the operator needs enough
 * to find the typo, not the whole string.
 */
export const MESSAGE_ECHO_MAX = 64;

/**
 * The production reader: the full envelope (symlink refusal at the leaf and
 * the parent, O_NOFOLLOW and O_NONBLOCK single-descriptor read, regular-file
 * check, byte cap). Every loader defaults to it (`loadJsonSettings` and the
 * two module loaders); a test seam may inject a plain reader.
 */
export function readSettingsFile(path: string): string {
  return readFileGuarded(path, MAX_SETTINGS_BYTES);
}

/**
 * Bounds a token for echoing in an error message (see MESSAGE_ECHO_MAX) and
 * makes it single-line and terminal-safe: control characters (a newline
 * would forge a second stderr line), bidi overrides and invisible code
 * points are neutralised BEFORE the cut, since a key or an allowlist entry
 * never legitimately contains any of them. The CLI's sanitizeForTerminal
 * keeps newlines by contract, so this is the one place the line is bound.
 */
export function boundEcho(text: string): string {
  return truncateWellFormed(
    stripInvisibles(stripBidi(sanitizeControlChars(text))),
    MESSAGE_ECHO_MAX,
  );
}

/** Own keys of `record` outside `known`, in document order. */
export function unknownKeys(
  record: Record<string, unknown>,
  known: readonly string[],
): string[] {
  return Object.keys(record).filter((key) => !known.includes(key));
}

/** One message shape for every level of every parser (ADR-0034 decision 1). */
export function unknownKeyMessage(where: string, key: string, known: readonly string[]): string {
  return `${where} has an unknown key '${boundEcho(key)}' (known keys: ${known.join(', ')})`;
}

/**
 * Loads and parses one settings layer. `readFile` defaults to the guarded
 * reader; it is a parameter so tests can feed a document without a disk
 * (ADR-0034 decision 5), and it is LAST so a caller cannot omit the parser
 * by accident while still omitting the reader on purpose.
 *
 * - Missing file (ENOENT) → `empty` (a settings file is optional).
 * - A read the envelope refuses (`GuardedReadError`: symlink, oversize,
 *   directory, unreadable) → a new `errorClass` whose message names the path
 *   and the reason; fail loud at startup, never fail open on a security config.
 * - Any other read error (programmer bugs) → propagated unwrapped.
 * - Invalid JSON → a new `errorClass` naming the file and NOTHING from inside
 *   it: V8's SyntaxError quotes a snippet of the input, and the input is
 *   whatever file the settings path points at (ADR-0034 decision 3).
 * - `parse` errors that are `instanceof errorClass` are rethrown
 *   path-prefixed; anything else propagates unwrapped.
 *   The class is an explicit parameter — a typed contract, not reflection.
 */
export function loadJsonSettings<T>(
  path: string,
  parse: (doc: unknown) => T,
  empty: T,
  errorClass: new (message: string) => Error,
  readFile: ReadFile = readSettingsFile,
): T {
  let body: string;
  try {
    body = readFile(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return empty;
    }
    if (error instanceof GuardedReadError) {
      throw new errorClass(`refusing settings: ${error.message}`);
    }
    throw error;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new errorClass(`${path} is not valid JSON`);
  }
  const duplicate = findDuplicateKey(body);
  if (duplicate !== null) {
    throw new errorClass(`${path}: ${duplicate}`);
  }
  try {
    return parse(doc);
  } catch (error: unknown) {
    if (error instanceof errorClass) {
      throw new errorClass(`${path}: ${error.message}`);
    }
    throw error;
  }
}

/** One open container during the duplicate-key scan. */
interface ScanFrame {
  /** How this container is reached from its parent: `.key` or `[index]`. */
  readonly segment: string;
  /** Present for an object; absent for an array. */
  readonly keys: Set<string> | null;
  expectKey: boolean;
  currentKey: string;
  index: number;
}

/** Index just past the string token that opens at `start` (a `"`). */
function endOfString(body: string, start: number): number {
  let i = start + 1;
  while (i < body.length && body[i] !== '"') i += body[i] === '\\' ? 2 : 1;
  return i + 1;
}

/** Path segments kept at each end of a duplicate-key message path. */
const PATH_EDGE_SEGMENTS = 4;

function pathOf(stack: readonly ScanFrame[]): string {
  const segments = stack.map((frame) => frame.segment);
  // Depth is attacker-controlled (the 1 MB cap allows ~200k levels), and each
  // segment is already capped by boundEcho, so cap the COUNT: first and last
  // PATH_EDGE_SEGMENTS with an ellipsis between keeps the message fixed-size.
  const shown =
    segments.length > 2 * PATH_EDGE_SEGMENTS
      ? [...segments.slice(0, PATH_EDGE_SEGMENTS), '…', ...segments.slice(-PATH_EDGE_SEGMENTS)]
      : segments;
  const joined = shown.join('').replace(/^\./, '');
  return joined === '' ? 'the top-level object' : joined;
}

function openFrame(stack: ScanFrame[], isObject: boolean): void {
  const parent = stack[stack.length - 1];
  let segment = '';
  if (parent !== undefined) {
    segment = parent.keys === null ? `[${parent.index}]` : `.${boundEcho(parent.currentKey)}`;
  }
  stack.push({ segment, keys: isObject ? new Set() : null, expectKey: isObject, currentKey: '', index: 0 });
}

/**
 * Issue #108: `JSON.parse` keeps the LAST of duplicate keys, so a doubled
 * `"defaultDecision"` turns `deny` into `allow` before any parser sees the
 * document. This scans the RAW text of a body that ALREADY parsed as JSON
 * (so the grammar is known good and the scan cannot trip on malformed input)
 * and returns a message naming the first duplicate's object path and key, or
 * `null`. Keys compare by their DECODED value (`"a"` is `"a"`), one set
 * per object, so the same key at different levels or in sibling objects is
 * legal. One pass, linear in the body, which MAX_SETTINGS_BYTES bounds. The
 * message never carries a value; the key and path are attacker-authored and
 * go through `boundEcho`.
 */
export function findDuplicateKey(body: string): string | null {
  const stack: ScanFrame[] = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    const top = stack[stack.length - 1];
    if (ch === '"') {
      const end = endOfString(body, i);
      if (top !== undefined && top.keys !== null && top.expectKey) {
        const key = JSON.parse(body.slice(i, end)) as string;
        if (top.keys.has(key)) {
          return `duplicate key '${boundEcho(key)}' in ${pathOf(stack)} (JSON keeps only the last of a repeated key; remove one)`;
        }
        top.keys.add(key);
        top.currentKey = key;
        top.expectKey = false;
      }
      i = end;
      continue;
    }
    if (ch === '{' || ch === '[') openFrame(stack, ch === '{');
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',' && top !== undefined) {
      if (top.keys === null) top.index += 1;
      else top.expectKey = true;
    }
    i += 1;
  }
  return null;
}
