/**
 * Shared settings-file mechanics (ADR-0015, hoisted from S-3's permissions
 * loader): read → ENOENT-is-empty → JSON.parse fail-loud → module parser with
 * path-prefixed rethrow. Zero repo dependencies — security modules and the
 * composition root both consume this leaf. Policy (what keys mean) stays in
 * each module's parser; only the mechanism lives here.
 */

export type ReadFile = (path: string) => string;

/**
 * Loads and parses one settings layer.
 *
 * - Missing file (ENOENT) → `empty` (a settings file is optional).
 * - Unreadable file (any other fs error) → propagated unwrapped.
 * - Invalid JSON → a new `errorClass` with a path-prefixed message (fail
 *   loud at startup, before any tool runs — never fail open on a security
 *   config).
 * - `parse` errors that are `instanceof errorClass` are rethrown
 *   path-prefixed; anything else (programmer bugs) propagates unwrapped.
 *   The class is an explicit parameter — a typed contract, not reflection.
 */
export function loadJsonSettings<T>(
  path: string,
  readFile: ReadFile,
  parse: (doc: unknown) => T,
  empty: T,
  errorClass: new (message: string) => Error,
): T {
  let body: string;
  try {
    body = readFile(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return empty;
    }
    throw error;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new errorClass(`${path} is not valid JSON: ${detail}`);
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
