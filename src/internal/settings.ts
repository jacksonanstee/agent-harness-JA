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
  try {
    return parse(doc);
  } catch (error: unknown) {
    if (error instanceof errorClass) {
      throw new errorClass(`${path}: ${error.message}`);
    }
    throw error;
  }
}
