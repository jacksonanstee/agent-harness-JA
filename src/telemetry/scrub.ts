import { isAbsolute, normalize } from 'node:path';

import type { TelemetryEvent } from './types.js';

/**
 * Export-time prefix scrub (issue #59 round 2, design E; ADR-0031 decision 7).
 *
 * The operator names the prefix EXPLICITLY (`--scrub-prefix`), which is what
 * fires ADR-0027's explicit-argument revisit bullet: the transform holds both
 * operands and never reads ambient state (`os.homedir()` is deliberately not
 * imported here). Replacement is removal-only text substitution on the EMITTED
 * export row — the stored row is untouched, and ADR-0027 decision 3's "signal
 * in the row" is read as the emitted export row for an export-time transform.
 *
 * `applied: true` means at least one replacement fired in this row. It NEVER
 * means the row is clean: an occurrence terminated by anything other than a
 * separator or end-of-string, a case variant of the same directory on a
 * case-insensitive filesystem, or an NFC/NFD spelling difference all survive
 * verbatim (named limits, ADR-0031 design E verification).
 */

export const SCRUB_TRANSFORM_ID = 'prefix-v1';

/**
 * Container-nesting cap for the scrub walk, mirroring the skills scanner's
 * MAX_SCAN_DEPTH: no legitimate payload approaches it, and a hostile row from
 * a shared DB file must produce a LOUD refusal, not an engine stack overflow.
 * The refusal denies the whole scrubbed export (the rowToEvent precedent:
 * never emit a partial artefact from a row that could not be processed).
 */
export const MAX_SCRUB_DEPTH = 64;

export interface ScrubSignal {
  /** True when `count > 0`. "At least one replacement fired", never "clean". */
  applied: boolean;
  /**
   * Replacements the transform itself performed in this row, summed across
   * ALL prefixes and all string sites (keys included). The counterfeit check
   * is AGGREGATE: total occurrences of `[scrubbed-prefix-<any N>]` in the row
   * beyond this count were already in the stored data, planted by whatever
   * wrote it. A per-ordinal comparison is unsound once the flag is repeated —
   * a planted marker for one ordinal hides behind another ordinal's genuine
   * replacement.
   */
  count: number;
  transform: typeof SCRUB_TRANSFORM_ID;
}

export type ScrubbedTelemetryRow = TelemetryEvent & { scrub: ScrubSignal };

export interface ScrubResult {
  value: string;
  count: number;
}

export type ScrubPrefixParse =
  | { ok: true; value: string }
  | { ok: false; error: string };

interface RankedPrefix {
  prefix: string;
  /** 1-based position of the `--scrub-prefix` argument; the marker's N. */
  ordinal: number;
}

/**
 * Longest prefix first so the most specific argument wins at any position;
 * `Array.prototype.sort` is stable, so equal-length duplicates keep argument
 * order and the FIRST ordinal wins.
 */
function rankPrefixes(prefixes: readonly string[]): RankedPrefix[] {
  return prefixes
    .map((prefix, index) => ({ prefix, ordinal: index + 1 }))
    .filter((entry) => entry.prefix.length > 0)
    .sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * The binding spec's boundary, LITERALLY (ADR-0031 decision 7 / design E v2
 * item 1): a candidate match is real only when the prefix is followed by a
 * path separator or end-of-string. The first cut of this module widened the
 * boundary to "any non-segment character", and review executed the cost: a
 * sibling directory named `/Users/jackson (Work Laptop)` was corrupted to
 * `[marker] (Work Laptop)` and stamped applied — the alice-class corruption
 * the spec exists to forbid, reachable through spaces, quotes, parentheses,
 * NFD combining marks and every other filename-legal character. Separator or
 * end-of-string is the only boundary that cannot mis-attribute a sibling.
 * The cost runs the other way and is a NAMED residual: an occurrence
 * terminated by prose punctuation (`cd /Users/jackson && ls`) survives in
 * cleartext; the post-scrub nudge exists to make that class visible.
 *
 * Comparing code units is sound here: `/` and `\` are BMP single units, so a
 * surrogate half can never equal either and astral characters after the
 * prefix correctly read as non-boundary.
 */
function isSegmentBoundary(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const char = text[index];
  return char === '/' || char === '\\';
}

function scrubRanked(text: string, ranked: readonly RankedPrefix[]): ScrubResult {
  let out = '';
  let index = 0;
  let count = 0;
  while (index < text.length) {
    let matched = false;
    for (const { prefix, ordinal } of ranked) {
      if (text.startsWith(prefix, index) && isSegmentBoundary(text, index + prefix.length)) {
        // The marker is appended to OUTPUT and the scan resumes past the
        // matched input, so replaced text is never rescanned: one pass, no
        // marker can feed a later match.
        out += `[scrubbed-prefix-${ordinal}]`;
        index += prefix.length;
        count += 1;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += text[index];
      index += 1;
    }
  }
  return { value: out, count };
}

/**
 * Replaces every segment-boundary occurrence of each prefix with its
 * `[scrubbed-prefix-N]` marker. Trusts its input: validation is
 * `parseScrubPrefix`'s job at the CLI boundary.
 */
export function scrubText(text: string, prefixes: readonly string[]): ScrubResult {
  return scrubRanked(text, rankPrefixes(prefixes));
}

/**
 * Validates one `--scrub-prefix` argument: normalised (`.`/`..`/doubled
 * separators collapse, so `/Users/./jackson` matches what the rows actually
 * store), absolute under this platform's path rules, at least two segments
 * once trailing separators are stripped — a bare root would scrub filesystem
 * structure, not a home prefix. Stripping is what keeps
 * `--scrub-prefix /Users/jackson/` catching the bare `/Users/jackson`
 * (the second panel-executed counterexample).
 */
export function parseScrubPrefix(raw: string): ScrubPrefixParse {
  const collapsed = raw === '' ? '' : normalize(raw);
  const stripped = collapsed.replace(/[\\/]+$/u, '');
  if (stripped === '' || !isAbsolute(stripped)) {
    return { ok: false, error: '--scrub-prefix must be an absolute path' };
  }
  const segments = stripped.split(/[\\/]+/u).filter((segment) => segment !== '');
  if (segments.length < 2) {
    return {
      ok: false,
      error: '--scrub-prefix needs at least two path segments; a bare root is too broad to scrub',
    };
  }
  return { ok: true, value: stripped };
}

/**
 * Deep walk over the JSON value: string leaves AND object keys are scrubbed,
 * containers are rebuilt (never mutated), everything else passes through.
 * Keys are scrubbed because the store validators are positive-conjunct
 * checks that admit extra keys — review executed a row whose payload KEY was
 * `/Users/<name>/.ssh/id_ed25519`, which an earlier cut of this walk left in
 * cleartext on a row stamped `applied: true`. A shared DB file makes keys
 * exactly as foreign as values.
 *
 * Two loud refusals, both free of untrusted bytes (the caller's error sink
 * still sanitises as belt and braces): nesting beyond MAX_SCRUB_DEPTH, and
 * two keys collapsing onto one scrubbed form (a planted marker key can
 * collide with a genuine key's scrubbed form; last-one-wins would silently
 * drop data from the artefact, so the row is refused instead).
 */
function scrubValueDeep(
  value: unknown,
  ranked: readonly RankedPrefix[],
  depth: number,
): { value: unknown; count: number } {
  if (depth > MAX_SCRUB_DEPTH) {
    throw new Error(`payload nesting exceeds the scrub depth cap (${MAX_SCRUB_DEPTH})`);
  }
  if (typeof value === 'string') {
    return scrubRanked(value, ranked);
  }
  if (Array.isArray(value)) {
    let count = 0;
    const items = value.map((item) => {
      const walked = scrubValueDeep(item, ranked, depth + 1);
      count += walked.count;
      return walked.value;
    });
    return { value: items, count };
  }
  if (value !== null && typeof value === 'object') {
    let count = 0;
    const seen = new Set<string>();
    const entries = Object.entries(value).map(([key, item]) => {
      const scrubbedKey = scrubRanked(key, ranked);
      count += scrubbedKey.count;
      if (seen.has(scrubbedKey.value)) {
        throw new Error('two object keys collapse onto one scrubbed form; row refused');
      }
      seen.add(scrubbedKey.value);
      const walked = scrubValueDeep(item, ranked, depth + 1);
      count += walked.count;
      return [scrubbedKey.value, walked.value] as const;
    });
    return { value: Object.fromEntries(entries), count };
  }
  return { value, count: 0 };
}

/**
 * Scrubs EVERY string site in the event — payload values and keys, but also
 * the top-level id columns: `record()` refuses malformed correlation ids, yet
 * a shared SQLite file can hold rows this binary never wrote (the same
 * residual the exporter's escape pass exists for), so no string site is
 * exempt. The walk preserves key order and replaces only string content,
 * which is what the single cast back to `TelemetryEvent` relies on; `scrub`
 * is appended last so machine consumers see the familiar columns first.
 *
 * Throws (depth cap, key collision) rather than emitting a partial row; the
 * CLI turns that into a whole-export refusal naming the row's position.
 */
export function scrubEvent(
  event: TelemetryEvent,
  prefixes: readonly string[],
): ScrubbedTelemetryRow {
  const ranked = rankPrefixes(prefixes);
  const walked = scrubValueDeep(event, ranked, 0);
  const row = walked.value as TelemetryEvent;
  return {
    ...row,
    scrub: { applied: walked.count > 0, count: walked.count, transform: SCRUB_TRANSFORM_ID },
  };
}

/**
 * Static shape for the nudge lines: a home-directory-looking segment under
 * `/home/`, `/Users/`, or `\Users\`. The segment charset is "anything that
 * is not a separator or whitespace" so non-ASCII usernames count. Keys on
 * nothing ambient, transforms nothing, and the nudge lines echo no row data —
 * they exist only so forgetting the flag, or scrubbing with a prefix that
 * missed, is a visible choice rather than a silent one.
 */
const HOME_SHAPED = /(?:\/home\/|\/Users\/|\\Users\\)[^/\\\s]+/;

export function hasHomeShapedPath(text: string): boolean {
  return HOME_SHAPED.test(text);
}

/**
 * Walks every string site (keys and values) of a JSON value looking for a
 * home-shaped path. ITERATIVE deliberately: this runs on the DEFAULT export
 * path, where a hostile deeply-nested row must not be able to crash the
 * lossless export the operator falls back on — the detector has no depth cap
 * because it needs none. Runs on RAW values, never on JSON-serialised text:
 * review executed the serialised form and JSON's backslash-doubling made the
 * `\Users\` arm unmatchable at the only call site.
 */
export function hasHomeShapedStrings(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === 'string') {
      if (HOME_SHAPED.test(current)) return true;
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (current !== null && typeof current === 'object') {
      for (const [key, item] of Object.entries(current)) {
        if (HOME_SHAPED.test(key)) return true;
        stack.push(item);
      }
    }
  }
  return false;
}
