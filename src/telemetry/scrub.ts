import { isAbsolute } from 'node:path';

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
 * means the row is clean: an unmatched sibling path, a below-prefix client
 * name, or a home path spelled differently all survive verbatim.
 */

export const SCRUB_TRANSFORM_ID = 'prefix-v1';

export interface ScrubSignal {
  /** True when `count > 0`. "At least one replacement fired", never "clean". */
  applied: boolean;
  /**
   * Replacements the transform itself performed in this row. A marker
   * occurrence beyond this count was already in the stored data (a forged
   * marker a tool output planted); the arithmetic is the counterfeit check.
   */
  count: number;
  transform: typeof SCRUB_TRANSFORM_ID;
}

export type ScrubbedTelemetryRow = TelemetryEvent & { scrub: ScrubSignal };

export type ScrubPrefixParse =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * A character that can CONTINUE a path segment. The boundary rule inverts it:
 * a candidate match is real only when the next character is absent
 * (end-of-string) or cannot continue the segment. This is what keeps
 * `/home/al` from firing inside `/home/alice` (panel-executed counterexample)
 * while a quote, space, or semicolon after the prefix still counts as a
 * boundary. Unicode letters and digits continue a segment for the same reason
 * ASCII ones do: firing there would leave `[marker]ñ`, the exact
 * partial-segment corruption the alice fixture exists to forbid.
 */
const SEGMENT_CONTINUATION = /[\p{L}\p{N}._~%+@-]/u;

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

function isSegmentBoundary(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const codePoint = text.codePointAt(index);
  if (codePoint === undefined) return true;
  return !SEGMENT_CONTINUATION.test(String.fromCodePoint(codePoint));
}

function scrubRanked(text: string, ranked: readonly RankedPrefix[]): { value: string; count: number } {
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
export function scrubText(
  text: string,
  prefixes: readonly string[],
): { value: string; count: number } {
  return scrubRanked(text, rankPrefixes(prefixes));
}

/**
 * Validates one `--scrub-prefix` argument: absolute (this platform's path
 * rules), at least two segments once trailing separators are stripped — a bare
 * root would scrub filesystem structure, not a home prefix. Stripping is what
 * keeps `--scrub-prefix /Users/jackson/` catching the bare `/Users/jackson`
 * (the second panel-executed counterexample).
 */
export function parseScrubPrefix(raw: string): ScrubPrefixParse {
  const stripped = raw.replace(/[\\/]+$/u, '');
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
 * Deep walk over the JSON value: string leaves are scrubbed, containers are
 * rebuilt (never mutated), everything else passes through. Keys are NOT
 * scrubbed — `rowToEvent` already validated the row against a known payload
 * shape, so keys are schema-controlled; values are where foreign text lives.
 */
function scrubValueDeep(
  value: unknown,
  ranked: readonly RankedPrefix[],
): { value: unknown; count: number } {
  if (typeof value === 'string') {
    return scrubRanked(value, ranked);
  }
  if (Array.isArray(value)) {
    let count = 0;
    const items = value.map((item) => {
      const walked = scrubValueDeep(item, ranked);
      count += walked.count;
      return walked.value;
    });
    return { value: items, count };
  }
  if (value !== null && typeof value === 'object') {
    let count = 0;
    const entries = Object.entries(value).map(([key, item]) => {
      const walked = scrubValueDeep(item, ranked);
      count += walked.count;
      return [key, walked.value] as const;
    });
    return { value: Object.fromEntries(entries), count };
  }
  return { value, count: 0 };
}

/**
 * Scrubs EVERY string value in the event — payload fields, but also the
 * top-level id columns: `record()` refuses malformed correlation ids, yet a
 * shared SQLite file can hold rows this binary never wrote (the same residual
 * the exporter's escape pass exists for), so no string site is exempt. The
 * walk preserves key order and replaces only string leaves, which is what the
 * single cast back to `TelemetryEvent` relies on; `scrub` is appended last so
 * machine consumers see the familiar columns first.
 */
export function scrubEvent(
  event: TelemetryEvent,
  prefixes: readonly string[],
): ScrubbedTelemetryRow {
  const ranked = rankPrefixes(prefixes);
  const walked = scrubValueDeep(event, ranked);
  const row = walked.value as TelemetryEvent;
  return {
    ...row,
    scrub: { applied: walked.count > 0, count: walked.count, transform: SCRUB_TRANSFORM_ID },
  };
}

/**
 * Static shape for the unscrubbed-export nudge: a home-directory-looking
 * segment under `/home/`, `/Users/`, or `\Users\`. Keys on nothing ambient,
 * transforms nothing, and the nudge line echoes no row data — it exists only
 * so forgetting the flag is a visible choice rather than a silent one.
 */
const HOME_SHAPED = /(?:\/home\/|\/Users\/|\\Users\\)[A-Za-z0-9._-]+/;

export function hasHomeShapedPath(text: string): boolean {
  return HOME_SHAPED.test(text);
}
