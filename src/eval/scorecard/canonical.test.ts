import { describe, expect, it } from 'vitest';
import { toCanonicalJson } from './canonical.js';

// toCanonicalJson is producer-agnostic (generic over any {rows: {id}[]}
// shape), so its tests use a local minimal fixture rather than a real
// producer's scorecard shape — scorecard/ must not import golden/ or
// redteam/ (layering debt discharged alongside the renderer move, E-2).
interface FixtureRow {
  id: string;
  pass: boolean;
  failureKind: string | null;
  reason: string | null;
}

interface FixtureScorecard {
  schemaVersion: 1;
  producer: string;
  meta: { createdAt: string };
  rows: FixtureRow[];
  totals: { total: number; passed: number; failed: number };
}

function row(id: string, pass: boolean): FixtureRow {
  return {
    id,
    pass,
    failureKind: pass ? null : 'oracle-fail',
    reason: pass ? null : 'expected pong',
  };
}

function card(rows: FixtureRow[]): FixtureScorecard {
  return {
    schemaVersion: 1,
    producer: 'test-fixture',
    meta: { createdAt: '2026-07-09T00:00:00.000Z' },
    rows,
    totals: {
      total: rows.length,
      passed: rows.filter((r) => r.pass).length,
      failed: rows.filter((r) => !r.pass).length,
    },
  };
}

describe('toCanonicalJson', () => {
  it('is byte-identical for scorecards that differ only in key/row order', () => {
    const a = toCanonicalJson(card([row('b-task', true), row('a-task', false)]));
    const b = toCanonicalJson(card([row('a-task', false), row('b-task', true)]));
    expect(a).toBe(b);
  });

  it('sorts rows by id', () => {
    const json = toCanonicalJson(card([row('zz', true), row('aa', true)]));
    expect(json.indexOf('"aa"')).toBeLessThan(json.indexOf('"zz"'));
  });

  it('sorts object keys recursively', () => {
    const json = toCanonicalJson(card([row('a', true)]));
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    const meta = parsed.meta as Record<string, unknown>;
    expect(Object.keys(meta)).toEqual([...Object.keys(meta)].sort());
  });

  it('ends with exactly one trailing newline', () => {
    const json = toCanonicalJson(card([row('a', true)]));
    expect(json.endsWith('\n')).toBe(true);
    expect(json.endsWith('\n\n')).toBe(false);
  });

  it('round-trips through JSON.parse', () => {
    const original = card([row('a', true)]);
    const parsed = JSON.parse(toCanonicalJson(original)) as FixtureScorecard;
    expect(parsed.rows).toEqual(original.rows);
    expect(parsed.totals).toEqual(original.totals);
  });
});
