import {
  sanitizeControlChars,
  sanitizeControlCharsKeepingLines,
  stripBidi,
  stripInvisibles,
} from './sanitize.js';

/**
 * The skill-section text and the pure helpers that build it, hoisted verbatim
 * from src/session/session.ts (issue #196) so `skills lint` measures the SAME
 * string the session injects instead of a second copy of the formula. Logic is
 * unchanged; only the module moved. Zero repo dependencies beyond the shared
 * sanitizers, as the internal layer requires, so the input is structural.
 */
export interface SkillSectionInput {
  name: string;
  description: string;
  body: string;
}

/**
 * Bytes of entropy in the skill-section delimiter nonce (ADR-0028). 8 bytes =
 * 64 bits, rendered as 16 lowercase hex characters.
 *
 * DERIVED FROM THE THREAT, and the threat here is GUESSING, not collision. The
 * attacker authors a skill body before the session exists, gets no oracle, and
 * learns nothing from a wrong guess — a forged header simply stays inert.
 *
 * They do NOT get only one attempt, and an earlier version of this comment said
 * they did. A body can carry thousands of candidate header lines: at
 * MAX_SKILL_PROMPT_CHARS (256,000) and ~30 chars each, roughly 8,500 of them,
 * so ~2^13 blind attempts at ~2^-51 per run — about 1 in 10^15.
 *
 * That success probability was previously described here as "hopeless by ~50
 * orders of magnitude". **It is ~15 decimal orders, not ~50** (2^-51 ≈
 * 4.4 × 10^-16), which is the SECOND wrong figure in this one comment and, like
 * the first, wrong in the flattering direction. Both survived because neither
 * was load-bearing: the conclusion holds comfortably at 10^-15.
 *
 * Note this is NOT in tension with ADR-0011 decision 16 rejecting a 64-bit
 * path digest. That rejection turns on the BIRTHDAY bound (~2^32 work to force
 * a collision between two attacker-chosen paths); no birthday bound applies to
 * guessing one specific unknown value, so the same number is weak there and
 * ample here. Widening this is cheap if that reasoning is ever wrong.
 */
export const SKILL_NONCE_BYTES = 8;

// Skill name/description are attacker-influenced (a hostile skill pack is in
// the threat model) and flow into the system prompt and warnings — strip
// control chars, bidi overrides, and invisible smuggling chars (zero-width/
// tag/variation-selector) at this boundary. Combining marks are deliberately
// left (legit NFD accents). The injection scan sees the RAW text, so nothing
// stripped here evades detection (issue #24 follow-up) — but note that is only
// true in the HIDING direction. Stripping substitutes SPACES, so it can also
// CREATE a payload the raw scan never saw; that is why the enforcement pass
// scans the assembled, cleaned section too (ADR-0026, skillSection).
export function cleanSkillText(text: string): string {
  return stripInvisibles(stripBidi(sanitizeControlChars(text)));
}

/**
 * `cleanSkillText` for the ONE field that is markdown (issue #45). Identical
 * except that the control-char pass keeps tab and newline, so headings,
 * bullets, numbered steps and fenced code blocks survive the trip to the
 * model. ADR-0006 makes the body what the agent actually reads; flattening it
 * to a single line was a terminal-sink contract applied to a model-bound sink.
 *
 * Preserving newlines is what makes a forged `## Skill:` inside a body able to
 * reach column 0, which is why it ships WITH the nonce delimiter (ADR-0028)
 * rather than on its own. Bidi and invisible stripping are unchanged.
 */
function cleanSkillBody(text: string): string {
  return stripInvisibles(stripBidi(sanitizeControlCharsKeepingLines(text)));
}

/**
 * Up to 3 spaces of indent, then a run of 3+ backticks or 3+ tildes.
 *
 * EXPORTED FOR THE TESTS' ORACLE, deliberately. The fence tests need to count
 * column-0 fence openers in an assembled prompt, and a hand-typed second copy
 * of this grammar would be an oracle that silently stops agreeing with the code
 * the moment either is widened (the failure `src/internal/sanitize.ts`'s
 * derivation chain exists to prevent — ADR-0011 item 13). They derive from this
 * constant instead. Note the absent `m` flag: this matches the START OF A
 * STRING, not of every line; see `defangFenceOpener`.
 */
export const FENCE_OPENER_RE = /^( {0,3})(`{3,}|~{3,})/;

/**
 * Breaks a leading code-fence marker so the line cannot OPEN a fenced code
 * block (ADR-0028 decision 8). Applied to `description` only.
 *
 * WHY THE DESCRIPTION NEEDS IT. `cleanSkillText` flattens `description` to a
 * single line, but that line still lands at COLUMN 0 — it is the section's
 * second line, straight after the header. An eleven-character description
 * (```` ```markdown ````) therefore opens a fence that nothing closes, and
 * every LATER section, including the operator policy skill and its correctly
 * nonced header, is swallowed into it. Scanner `pass`, zero warnings, zero
 * drops. That vector predates issue #45 and is reachable on every release so
 * far; this is what closes it.
 *
 * WHY DEFANG RATHER THAN BALANCE, and this is the load-bearing part.
 * `balanceCodeFences` — the previous mitigation, withdrawn in ADR-0028
 * decision 8 — tried to APPEND a closing fence to an unbalanced section. That
 * is unsound, because whether a line opens a fence and whether column 0 is the
 * right place to close it are both facts about BLOCK CONTEXT, which a
 * line-based pass does not have. Measured against the CommonMark reference
 * parser, it manufactured three section-swallowing leaks that no release
 * before it had, one of which fired on an honest authoring typo (an unclosed
 * fence inside a numbered list) with no attacker present at all.
 *
 * This function cannot do that. It only ever REMOVES the ability to open a
 * fence, never adds a marker, so it is monotone in the safe direction by
 * construction. It costs nothing, because `description` is a LABEL — ADR-0006
 * makes the BODY the markdown a skill is written in, and a fence in a
 * one-line label was never going to render as a code block anyway.
 *
 * THE BODY IS DELIBERATELY NOT DEFANGED, and the fence it can leave open is an
 * ACCEPTED RESIDUAL, not an oversight: see ADR-0028 decision 8 and the
 * Consequences bullet on column-0 block structure. Defanging the body would
 * destroy the feature issue #45 exists to deliver. The residual is pinned by
 * `session.test.ts`'s "does NOT stop a hostile body leaving a fence open
 * (accepted residual)", which asserts the weakness so it cannot change quietly.
 *
 * ⚠️ TWO PROPERTIES OF THE CALL ITSELF ARE LOAD-BEARING, and neither is visible
 * from this function's body.
 *   1. ORDER. It must run AFTER `cleanSkillText`, never before. `FENCE_OPENER_RE`
 *      accepts only literal U+0020 as indentation, while `cleanSkillText`
 *      SUBSTITUTES A SPACE for every C0 control including TAB. On the shipped
 *      order a description of "\t```markdown" cleans to " ```markdown" and is
 *      then defanged. Inverted, this pass sees a tab at position 0, declines to
 *      match, and the cleaner then produces a live column-1 fence. Measured:
 *      three of five control-prefixed cases flip from safe to swallowing.
 *      Pinned by "defangs a description whose fence marker is reachable only
 *      after cleaning". This is decision 6's rule (order is the decision, not an
 *      implementation detail) applied to a second pair of passes.
 *   2. SINGLE LINE. `FENCE_OPENER_RE` has no `m` flag, so this inspects the
 *      start of the STRING. That is exactly right for `description`, which
 *      `cleanSkillText` has already flattened to one line, and it is why a
 *      naive extension to the multi-line body would be WORSE than doing
 *      nothing: it would defang line 1 and silently leave every later line's
 *      marker live, which reads in review as a mitigation that is present.
 */
function defangFenceOpener(label: string): string {
  return label.replace(
    FENCE_OPENER_RE,
    (_match, indent: string, marker: string) => `${indent}${marker[0]} ${marker.slice(1)}`,
  );
}

/**
 * The exact text a skill contributes to the system prompt.
 *
 * Extracted so enforcement scans the string that is actually INJECTED, not
 * merely the raw source. Those differ: cleanSkillText maps C0/C1 and bidi
 * characters to SPACES, which does not only fail to hide a payload — it can
 * CREATE one. `ignore<0x01>all previous instructions` matches no rule raw
 * (\s does not match 0x01), and becomes a clean `ignore all previous
 * instructions` in the prompt. Scanning raw text alone is therefore blind to
 * a one-byte bypass, and scanning only the cleaned text would be blind to
 * smuggling the cleaner removes. Both are scanned; see ADR-0026.
 *
 * Scanning the assembled section also covers two channels a per-field scan
 * misses: `name`, carried on the header line as `## Skill [<nonce>]: <name>`,
 * and a phrase
 * split across fields (rules join on \s+, which matches the newlines between
 * header, description and body).
 */
export function skillSection(skill: SkillSectionInput, nonce: string): { name: string; section: string } {
  const name = cleanSkillText(skill.name);
  // `description` is DEFANGED as well as flattened, because flattened is not
  // the same as harmless: it still occupies a whole line at column 0, so a
  // fence marker there opens a block that swallows every later section
  // (ADR-0028 decision 8). `name` needs no such pass — it sits mid-line after
  // `]: `, and the loader's schema constrains it to `[a-z0-9-]` anyway.
  //
  // THE RULE THAT GENERATES THESE THREE CHOICES IS POSITIONAL: any single-line
  // field the harness emits AT COLUMN 0 must be defanged, and `name` is exempt
  // only because it does not sit there. A future header line (a version, a tag
  // list, or `name` moved to its own line for readability) needs the same pass
  // and will get NO compile-time signal that it is missing one.
  //
  // ORDER IS LOAD-BEARING: defang runs AFTER cleaning, never before, or a
  // tab-indented marker survives as a live fence. See defangFenceOpener.
  const header = `## Skill [${nonce}]: ${name}\n${defangFenceOpener(cleanSkillText(skill.description))}`;
  // BODY ONLY keeps its line structure (issue #45), and is deliberately NOT
  // defanged: its fences are the feature. A fence the body leaves open is an
  // accepted residual, in the same class as the `# HARNESS OVERRIDE`, `---`
  // and HTML-comment structure the Consequences of ADR-0028 already accept.
  const body = cleanSkillBody(skill.body).trim();
  return { name, section: body === '' ? header : `${header}\n\n${body}` };
}
