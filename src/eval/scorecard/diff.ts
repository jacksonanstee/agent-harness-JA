export interface ChangedRow<R> {
  before: R;
  after: R;
  /** Sorted names of every own field whose value differs (strict equality). */
  fields: string[];
}

export interface RowDiff<R> {
  identical: boolean;
  added: R[];
  removed: R[];
  changed: ChangedRow<R>[];
}

/**
 * Id-keyed row diff over ALL own enumerable fields, generic over the concrete
 * row type (design SK2): a redteam block→ask softening changes only the
 * extension field `verdict` — core fields are identical on both sides — so a
 * core-fields-only comparison would fail the gate with an empty changed list.
 * Knows nothing about verdict strength; direction is the producer's concern.
 * Pairing uses Map, immune to `__proto__` id corruption (design CG3).
 */
export function diffRows<R extends { id: string }>(
  baseline: readonly R[],
  fresh: readonly R[],
): RowDiff<R> {
  const freshById = new Map(fresh.map((r) => [r.id, r]));
  const removed: R[] = [];
  const changed: ChangedRow<R>[] = [];
  for (const before of baseline) {
    const after = freshById.get(before.id);
    if (after === undefined) {
      removed.push(before);
      continue;
    }
    freshById.delete(before.id);
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    const fields = keys.filter(
      (k) => (before as Record<string, unknown>)[k] !== (after as Record<string, unknown>)[k],
    );
    if (fields.length > 0) changed.push({ before, after, fields });
  }
  const added = [...freshById.values()];
  return {
    identical: removed.length === 0 && added.length === 0 && changed.length === 0,
    added,
    removed,
    changed,
  };
}
