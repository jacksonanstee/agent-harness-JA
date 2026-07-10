/** Producer-agnostic scorecard core (ADR-0017 H1, ADR-0018). Each producer
 *  supplies its own failure-kind tuple; K is derived from it so the runtime
 *  tuple and the type cannot drift. */

export interface ScorecardRowCore<K extends string> {
  id: string;
  pass: boolean;
  failureKind: K | null;
}

export interface ScorecardTotalsCore<K extends string> {
  total: number;
  passed: number;
  failed: number;
  byFailureKind: Record<K, number>;
}

export type Producer = 'golden' | 'redteam';

export interface ScorecardEnvelope<Meta, Row, Totals> {
  schemaVersion: 1;
  producer: Producer;
  meta: Meta;
  rows: Row[];
  totals: Totals;
}

export function computeByFailureKind<K extends string>(
  rows: ReadonlyArray<{ failureKind: K | null }>,
  kinds: readonly K[],
): Record<K, number> {
  const out = Object.fromEntries(kinds.map((k) => [k, 0])) as Record<K, number>;
  for (const row of rows) {
    if (row.failureKind !== null) out[row.failureKind] += 1;
  }
  return out;
}
