import type { RedactResult } from '../../security/index.js';
import { sanitizeControlChars, stripBidi, truncateWellFormed } from '../../internal/sanitize.js';

/** Stored-reason cap; toMarkdown truncates further for table cells. */
export const MAX_REASON_LENGTH = 500;

/**
 * Every string entering a scorecard row goes through this: redact (fail-closed
 * to a sentinel — spec decision #1), strip control/bidi chars, truncate.
 * The field allowlist is structural (the scorecard row types — GoldenRow /
 * RedteamRow — carry no raw-output field); this guards the fields that exist.
 */
export function cleanForScorecard(
  text: string,
  redactSecrets?: (text: string) => RedactResult,
): string {
  let out = text;
  if (redactSecrets !== undefined) {
    try {
      out = redactSecrets(out).redacted;
    } catch {
      return '[REDACTION FAILED]';
    }
  }
  out = stripBidi(sanitizeControlChars(out));
  return truncateWellFormed(out, MAX_REASON_LENGTH);
}

/**
 * Bidi stripping alone, for text that must NOT go through the full
 * cleanForScorecard pipeline: row ids are cleaned at parse time, before the
 * duplicate-id check (so bidi-distinct hostile filenames collide loudly,
 * pre-spend, instead of aliasing in the final scorecard) and are never
 * secret-redacted (a schema-valid id must survive verbatim).
 *
 * Implementation lives in the zero-dep leaf (issue #24: skills needed it and
 * cannot import eval); re-exported here so scorecard consumers keep their
 * import path.
 */
export { stripBidi } from '../../internal/sanitize.js';

/** One-line, markdown-cell-safe: strip newlines, escape pipes, well-formed
 *  truncate. Shared by every producer's renderer so an escaping fix lands
 *  once — the redteam table is adversarial-by-design (decision log CG6). */
export function escapeCell(text: string, max = 120): string {
  const oneLine = text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return truncateWellFormed(oneLine, max);
}

/**
 * Truncate to at most `max` chars plus an ellipsis, never bisecting a
 * surrogate pair: if a high surrogate (0xD800-0xDBFF) sits at the truncation
 * boundary, cut one earlier so the output stays well-formed. Every truncation
 * of scorecard text must go through this: a naive slice at ANY boundary (not
 * just this module's cap) can emit a lone surrogate.
 *
 * Implementation hoisted to src/internal/sanitize.ts (2026-07-28) so the
 * session layer can bound SDK tokens without an upward import; re-exported here
 * so every existing eval consumer and its tests are unchanged.
 */
export { truncateWellFormed };
