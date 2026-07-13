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
// eslint-disable-next-line no-misleading-character-class -- the joiners/VS ARE the payload chars being stripped, same suppression as the scanner's SMUGGLING_CHARS
const INVISIBLES = /[\u200B\u200C\u200D\u2060\uFEFF\u00AD\uFE00-\uFE0F\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

export function stripInvisibles(text: string): string {
  return text.replace(INVISIBLES, '');
}
