import { escapeJsonText } from '../../internal/sanitize.js';

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeysDeep(record[key])]),
    );
  }
  return value;
}

/**
 * Byte-stable given identical inputs (spec §scorecard): recursively sorted
 * keys, rows sorted by id (ordinal), 2-space indent, one trailing newline.
 * E-3's baseline diff depends on this stability — change only with a
 * schemaVersion bump. Producer-agnostic: it serializes any scorecard whose
 * rows carry a string id (golden, redteam), the only field its ordering
 * contract reads.
 *
 * OUTPUT-ENCODED here, in the one canonical serialiser, and deliberately NOT
 * at `writeScorecard` (issue #48). The scorecard is a durable JSON file an
 * operator cats, and its reason strings derive from the red-team corpus and
 * scan results, which a hostile cloned repo authors. `cleanForScorecard`
 * strips control and bidi characters but covers neither
 * `\p{Default_Ignorable_Code_Point}` nor U+FFF9-FFFB, which is exactly the
 * charset commit `5ffad52` proved insufficient for the telemetry JSONL sink;
 * this is the same sink shape one layer over.
 *
 * The PLACEMENT is the load-bearing part. Every drift comparator routes
 * through this function too (`baseline.ts` compares two canonical strings,
 * `redteam-command.ts` compares the file's raw bytes against one and falls
 * back to comparing the reparsed form), so encoding here keeps the writer and
 * both comparators equal BY CONSTRUCTION. Encoding at the sink instead leaves
 * the comparators reading unescaped text, so the file's bytes never match and
 * the reparsed form always does: that is the `nonCanonical` branch, which
 * feeds `drift`, so the gate reports `GATE_FAILURE=drift` and exits 1 on every
 * run forever. Measured, not reasoned: both variants were run against the real
 * encoder before choosing this one. That is the trap issue #48 names.
 *
 * A baseline written before this change and containing such a character is
 * NOT reported as drift: its raw bytes differ, so the comparator falls through
 * to the reparsed check, which matches, and the run reports the file as
 * non-canonical with the existing rewrite remedy. Files without those
 * characters, including the committed `eval/redteam/baseline.json`, are
 * byte-identical either way, so nothing churns.
 *
 * Lossless, so `schemaVersion` does not move: `escapeJsonText` emits `\uXXXX`
 * escapes that `JSON.parse` returns as the identical value, so machine
 * consumers see no change at all.
 */
export function toCanonicalJson<T extends { rows: ReadonlyArray<{ id: string }> }>(
  scorecard: T,
): string {
  const rows = [...scorecard.rows].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return escapeJsonText(`${JSON.stringify(sortKeysDeep({ ...scorecard, rows }), null, 2)}\n`);
}
