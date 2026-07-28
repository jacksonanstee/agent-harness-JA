/**
 * Shared control-character sanitizer (ADR-0008 Revisit-if: telemetry became
 * the fourth copy site, triggering extraction). Strips C0/C1 control chars +
 * Unicode line/paragraph separators so attacker-influenced strings (tool
 * names, hook reasons, error messages, persisted text) cannot carry terminal
 * escapes or log injection. Zero-dependency leaf: importable from any module.
 *
 * The CLI's TERMINAL_UNSAFE in src/cli.ts is deliberately separate — it keeps
 * newline/tab for readable terminal output, a different charset contract.
 */
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F\u2028\u2029]/g;

export function sanitizeControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, ' ');
}

// Bidi overrides/embeddings (U+202A\u2013202E), isolates (U+2066\u20132069), and the
// LRM/RLM/ALM marks \u2014 the Trojan-Source charset (CVE-2021-42574). Kept
// SEPARATE from CONTROL_CHARS: bidi marks are legal in genuine RTL prose, so
// callers opt in per sink (diagnostics, prompts, scorecard ids) instead of
// every sanitizeControlChars caller silently mangling multilingual text.
// Hoisted from eval/scorecard (issue #24) so leaf modules (skills) can use it
// without a skills\u2192eval layering violation; eval re-exports from here.
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;

export function stripBidi(text: string): string {
  return text.replace(BIDI_CONTROLS, ' ');
}

// Invisible smuggling chars for MODEL-BOUND sinks (system prompt): zero-width
// chars, Unicode tag block, variation selectors. DELETED (not spaced) \u2014 they
// occupy no visual width, so a space would alter what the reader sees.
// Deliberately narrower than the injection scanner's SMUGGLING_CHARS
// (src/security/injection/scan.ts): combining marks (U+0300\u2013036F) are
// excluded because they are legitimate in NFD-form accented text \u2014 the
// scanner strips them only transiently for its re-scan pass, never from
// content. Keep the two charsets in sync when either changes.
// Widened 2026-07-28 (round-2 review PoC): U+2061-2064 invisible math
// operators, U+206A-206F deprecated format, U+180E, U+FFF9-FFFB interlinear
// annotation and U+1D173-1D17A musical formatting were in NEITHER this set nor
// the scanner's, so they survived into the system prompt AND defeated the
// plaintext rules on both scan passes: `ignore <U+2064>all previous
// instructions` scored `pass` and rendered to a reader as a clean injection.
// Pinned by a regression test in src/session/session.test.ts.
const INVISIBLES =
// eslint-disable-next-line no-misleading-character-class -- the joiners/VS ARE the payload chars being stripped, same suppression as the scanner's SMUGGLING_CHARS
  /[\u200B\u200C\u200D\u2060-\u2064\u206A-\u206F\uFEFF\u00AD\u180E\uFFF9-\uFFFB\uFE00-\uFE0F\u{1D173}-\u{1D17A}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

export function stripInvisibles(text: string): string {
  return text.replace(INVISIBLES, '');
}

/**
 * Truncates without splitting a surrogate pair, so the result is always
 * well-formed UTF-16 (a lone surrogate survives JSON but becomes U+FFFD through
 * TextEncoder/Buffer, and it can reach a public API field).
 *
 * Hoisted from eval/scorecard (which re-exports from here) so lower layers can
 * bound a string without an upward import, the same reason stripBidi was
 * hoisted for issue #24.
 */
export function truncateWellFormed(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const charAtBoundary = text.charCodeAt(max - 1);
  const cutLength = charAtBoundary >= 0xd800 && charAtBoundary <= 0xdbff ? max - 1 : max;
  return `${text.slice(0, cutLength)}…`;
}
