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
 */
export function toCanonicalJson<T extends { rows: ReadonlyArray<{ id: string }> }>(
  scorecard: T,
): string {
  const rows = [...scorecard.rows].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return `${JSON.stringify(sortKeysDeep({ ...scorecard, rows }), null, 2)}\n`;
}
