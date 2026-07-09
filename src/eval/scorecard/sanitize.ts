import type { RedactResult } from '../../security/index.js';
import { sanitizeControlChars } from '../../internal/sanitize.js';

/** Stored-reason cap; toMarkdown truncates further for table cells. */
export const MAX_REASON_LENGTH = 500;

// Bidi format/override + isolate controls (Trojan Source, CVE-2021-42574) +
// explicit marks. sanitizeControlChars covers C0/C1 but not these; the
// injection scanner's SMUGGLING_CHARS is deliberately module-private, so this
// small charset is owned here (scorecard text is a different sink contract).
const BIDI_CONTROLS = /[‪-‮⁦-⁩‎‏؜]/g;

/**
 * Every string entering a scorecard row goes through this: redact (fail-closed
 * to a sentinel — spec decision #1), strip control/bidi chars, truncate.
 * The field allowlist is structural (ScorecardRow has no raw-output field);
 * this guards the fields that do exist.
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
  out = sanitizeControlChars(out).replace(BIDI_CONTROLS, ' ');

  if (out.length <= MAX_REASON_LENGTH) {
    return out;
  }

  let cutLength = MAX_REASON_LENGTH;
  // Never bisect a surrogate pair: if a high surrogate (0xD800–0xDBFF) is at the
  // truncation boundary, cut one earlier to preserve the pair.
  const charAtBoundary = out.charCodeAt(MAX_REASON_LENGTH - 1);
  if (charAtBoundary >= 0xd800 && charAtBoundary <= 0xdbff) {
    cutLength = MAX_REASON_LENGTH - 1;
  }
  return `${out.slice(0, cutLength)}…`;
}
