/**
 * Shared control-character sanitizer (ADR-0008 Revisit-if: telemetry became
 * the fourth copy site, triggering extraction). Strips C0/C1 control chars +
 * Unicode line/paragraph separators so attacker-influenced strings (tool
 * names, hook reasons, error messages, persisted text) cannot carry terminal
 * escapes or log injection. Zero-dependency leaf: importable from any module.
 *
 * TERMINAL_UNSAFE below is deliberately a SEPARATE charset from CONTROL_CHARS —
 * it keeps newline/tab for readable terminal output, a different contract.
 */
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F\u2028\u2029]/g;

export function sanitizeControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, ' ');
}

/**
 * CONTROL_CHARS minus TAB and LF: model output and warnings reach the user's
 * terminal, where newline/tab are kept for readability while ANSI/OSC escape
 * introducers and C1 controls are stripped.
 *
 * Lives HERE rather than beside its only caller (`sanitizeForTerminal`, in
 * src/cli/shared.ts) because JSON_TEXT_UNSAFE below derives from it, and this
 * file is the zero-dep leaf every layer may import. Leaving the charset in the
 * cli layer put the JSON encoder out of reach of src/eval/**, which eslint
 * blocks from importing src/cli/** — see the header on escapeJsonText.
 */
const C0_ALL = '\\x00-\\x1F';
const C0_KEEPING_TAB_LF = '\\x00-\\x08\\x0B-\\x1F';

/* c8 ignore next 6 -- unreachable unless CONTROL_CHARS is reshaped; the throw
   exists so that reshaping fails at module load instead of silently yielding a
   TERMINAL_UNSAFE that still contains TAB and LF. A no-op .replace() would
   leave newlines being stripped from CLI output AND the JSONL record separator
   being escaped by JSON_TEXT_UNSAFE below. */
if (!CONTROL_CHARS.source.includes(C0_ALL)) {
  throw new Error('CONTROL_CHARS no longer contains the C0 range TERMINAL_UNSAFE carves TAB/LF out of');
}

export const TERMINAL_UNSAFE = new RegExp(
  CONTROL_CHARS.source.replace(C0_ALL, C0_KEEPING_TAB_LF),
  'g',
);

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
// A PROPERTY, not a list (2026-07-28, round-3 review). Two earlier rounds
// enumerated the exact code points each PoC used and left the holes beside
// them: U+2065 sat in the one-code-point gap between U+2060-2064 and the bidi
// range and was still a working bypass. \p{Default_Ignorable_Code_Point}
// covers the class by construction. U+FFF9-FFFB (interlinear annotation) are
// Cf but NOT default-ignorable, so they are named explicitly; deleting them
// merges annotation text into the base text, which is the one visible
// content change here and is accepted (Unicode discourages them in open
// interchange). Deliberately NOT \p{Mn}: combining marks are legitimate NFD
// content, and the scanner strips them only transiently for its re-scan.
// Swept exhaustively by src/session/session.test.ts.
const INVISIBLES =
// eslint-disable-next-line no-misleading-character-class -- the joiners/VS ARE the payload chars being stripped, same suppression as the scanner's SMUGGLING_CHARS
  /[\p{Default_Ignorable_Code_Point}\uFFF9-\uFFFB]/gu;

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

/**
 * Tail-preserving counterpart to truncateWellFormed, for fields whose
 * DISAMBIGUATING content is at the end — `path` above all, which exists
 * precisely because skill names are not unique (session/types.ts).
 * Head-truncating a path keeps the shared directory prefix and throws away
 * the filename, i.e. destroys the one thing the field is for.
 *
 * The surrogate guard is the MIRROR of truncateWellFormed's. That function
 * guards the trailing cut edge against a lone HIGH surrogate; a tail slice can
 * BEGIN with a lone LOW surrogate whose high half was cut. A lone surrogate
 * survives JSON and reaches a persisted, exportable sink, so it is dropped.
 */
export function truncateTailWellFormed(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const start = text.length - max;
  const firstKept = text.charCodeAt(start);
  const from = firstKept >= 0xdc00 && firstKept <= 0xdfff ? start + 1 : start;
  return `…${text.slice(from)}`;
}

/**
 * Every character `escapePathUnsafe` below turns into a `\u{HEX}` escape,
 * DERIVED from CONTROL_CHARS ∪ BIDI_CONTROLS ∪ INVISIBLES above rather than
 * hand-copied — this file already lost one code point (U+2065) to a
 * hand-enumerated class (see INVISIBLES's comment), so a fourth manually
 * typed copy of the same charset is the exact failure mode being avoided.
 */
const PATH_ESCAPE_TARGETS = new RegExp(
  `[${CONTROL_CHARS.source.slice(1, -1)}${BIDI_CONTROLS.source.slice(1, -1)}${INVISIBLES.source.slice(1, -1)}]`,
  'gu',
);

/**
 * Matches one whole escape sequence `escapePathUnsafe` can produce: a
 * doubled backslash (`\\`, from a literal backslash in the input) or a
 * braced code-point escape (`\u{HEX}`, uppercase hex, from a character
 * PATH_ESCAPE_TARGETS matched). Exported so a caller that TRUNCATES an
 * already-escaped string (telemetry/store.ts's `boundSkillDropPath`) can
 * avoid cutting one in half — this file owns the escape grammar, so the
 * truncator does not re-derive it and the two cannot drift apart.
 */
export const PATH_ESCAPE_SEQUENCE = /\\\\|\\u\{[0-9A-F]+\}/g;

/**
 * Escapes every character that would otherwise be deleted or space-
 * substituted out of a filesystem path (PATH_ESCAPE_TARGETS), so the result
 * is printable ASCII-safe text that still IDENTIFIES the file. Deleting or
 * substituting is wrong here, unlike for `name` (cleanSkillText, session.ts):
 * an invisible character renders as nothing either way, so removing it buys
 * no visibility while destroying the only thing that distinguishes two
 * paths — letting a hostile `/skills/he<U+200B>lper.md` collapse onto a
 * benign `/skills/helper.md` and misdirect an operator, following the drop
 * warning's own instruction, to edit the wrong file (round-1 fix, issue #46
 * Finding 1). Bidi is escaped too, not merely neutralised: Trojan Source is a
 * REORDERING attack (space-substitution already defeats it, per stripBidi),
 * but escaping is strictly more informative than substitution for no extra
 * cost, so one transform covers both threat classes instead of two.
 *
 * `escaped` is reported OUT OF BAND (mirrors `pathTruncated`,
 * telemetry/types.ts's SkillDropPayload, and the same ellipsis-forgery
 * argument) because the escape text itself is expressible in a real
 * filename; backslashes are doubled FIRST — before any `\u{...}` is
 * injected — so a file literally named `\u{200B}` cannot be read back as
 * though it contained a real U+200B: the doubling runs first, so the
 * backslash it introduces is never itself re-escaped, and a real backslash
 * in the input is always distinguishable from one this function introduced.
 *
 * Braced `\u{...}` form, not four-digit `\uXXXX`: astral default-ignorables
 * (the U+E0000-E007F / U+E0100-E01EF tag/variation-selector blocks) need
 * more than four hex digits, and the braced form is unambiguous either way —
 * no risk of an adjacent literal hex digit being read as part of the escape.
 * `u` flag on PATH_ESCAPE_TARGETS: astral code points match as one whole
 * code point (`codePointAt(0)` below then reads the full value), not as two
 * lone surrogate halves each producing a bogus separate escape.
 */
export function escapePathUnsafe(path: string): { value: string; escaped: boolean } {
  let escaped = false;
  const value = path
    .replace(/\\/g, '\\\\')
    .replace(PATH_ESCAPE_TARGETS, (ch) => {
      escaped = true;
      return `\\u{${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`;
    });
  return { value, escaped };
}

/**
 * Everything TERMINAL_UNSAFE covers PLUS the invisible/reordering classes that
 * must never reach a JSONL file raw. DERIVED from TERMINAL_UNSAFE.source, not
 * re-typed: escapeJsonText REPLACES sanitizeForTerminal on the export path, so
 * it has to be a strict superset, and a second hand-copied edition of those
 * ranges is exactly how the two would drift apart unnoticed.
 *
 * A PROPERTY, not a list. INVISIBLES above lost U+2065 to a hand-enumerated
 * class twice; \p{Default_Ignorable_Code_Point} is a swept-verified superset of
 * this file's BIDI_CONTROLS, so naming the bidi ranges again here would add a
 * second place to get wrong and no coverage. U+FFF9-FFFB are Cf but NOT
 * default-ignorable, so they are named explicitly, mirroring INVISIBLES.
 *
 * NOT widened to \p{Cf}: the 29 code points in Cf but not here are Arabic and
 * Syriac number/abbreviation marks, Kaithi number signs and Egyptian hieroglyph
 * format controls, all legitimate script content that neither reorders nor
 * hides text. TAB and LF are deliberately absent (TERMINAL_UNSAFE carves them
 * out): JSON.stringify escapes both INSIDE a string, and a raw LF is the JSONL
 * record delimiter, so escaping it would corrupt the file's line structure.
 */
export const JSON_TEXT_UNSAFE = new RegExp(
  `[${TERMINAL_UNSAFE.source.slice(1, -1)}\\p{Default_Ignorable_Code_Point}\\uFFF9-\\uFFFB]`,
  'gu',
);

/**
 * Re-encodes every JSON_TEXT_UNSAFE character in ALREADY-SERIALIZED JSON as a
 * `\uXXXX` escape. Lossless: such an escape is valid JSON and JSON.parse
 * returns the identical value, so machine consumers are unaffected while
 * `cat`ing the file is safe. This is OUTPUT ENCODING: it deliberately does not
 * change what is stored.
 *
 * Lives in this zero-dep leaf, NOT beside its first caller in src/cli/shared.ts.
 * eslint blocks src/eval/** from importing src/cli/**, and src/eval/scorecard
 * writes durable JSON through the same class of sink, so a cli-layer home would
 * put this encoder permanently out of reach of the second consumer that needs
 * it. Sibling encoder escapePathUnsafe above, same file, same reason.
 *
 * PRECONDITION: `json` MUST be JSON.stringify output (or a `\n`-join of such).
 * Correctness rests on JSON.stringify having already doubled every literal
 * backslash, which makes any backslash run preceding a target even-length so
 * the inserted escape always starts fresh. Fed raw text, a lone `\` before a
 * target yields `\\uXXXX`, which reads back as a backslash followed by the
 * literal text `uXXXX`: silent corruption.
 *
 * Four-digit `\uXXXX` per UTF-16 CODE UNIT, NOT escapePathUnsafe's braced
 * `\u{HEX}`: JSON has no braced form, so an astral target must be emitted as
 * its surrogate PAIR: U+E0001 becomes the escape pair DB40 then DC01, which
 * JSON.parse recombines. The `for` loop over `.length` is load-bearing: a
 * spread or for-of iterates CODE POINTS and would emit ONE five-hex-digit
 * escape for U+E0001, which JSON.parse reads as U+E000 plus a literal 1.
 */
export function escapeJsonText(json: string): string {
  return json.replace(JSON_TEXT_UNSAFE, (match) => {
    let out = '';
    for (let index = 0; index < match.length; index += 1) {
      out += `\\u${match.charCodeAt(index).toString(16).padStart(4, '0').toUpperCase()}`;
    }
    return out;
  });
}
