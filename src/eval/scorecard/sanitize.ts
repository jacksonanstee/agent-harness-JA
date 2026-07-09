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
  return out.length > MAX_REASON_LENGTH ? `${out.slice(0, MAX_REASON_LENGTH)}…` : out;
}
