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

describe('toCanonicalJson output encoding (issue #48)', () => {
  // The scorecard is a DURABLE JSON file an operator cats, fed by reason
  // strings that derive from the red-team corpus and scan results, i.e.
  // attacker-authored under the repo threat model. cleanForScorecard strips
  // control and bidi characters but carries no Default_Ignorable or
  // U+FFF9-FFFB coverage, which is exactly the charset commit 5ffad52 proved
  // insufficient for the telemetry JSONL sink. The encoder is applied HERE,
  // in the one canonical serialiser, rather than at writeScorecard: every
  // drift comparator also routes through this function, so escaping here
  // keeps writer and comparators equal BY CONSTRUCTION. Escaping at the sink
  // alone would make every baseline read back as spurious drift.
  const RLO = '\u202E';
  const CSI = '\u009B';
  const ZWSP = '\u200B';
  const INTERLINEAR = '\uFFF9';

  function withReason(reason: string): FixtureScorecard {
    const c = card([row('a', false)]);
    const first = c.rows[0];
    if (first === undefined) throw new Error('fixture must have a row');
    first.reason = reason;
    return c;
  }

  it.each([
    ['a bidi override', RLO],
    ['a C1 control', CSI],
    ['a default-ignorable', ZWSP],
    ['an interlinear annotation mark', INTERLINEAR],
  ])('emits no raw %s byte', (_label, ch) => {
    const json = toCanonicalJson(withReason(`before${ch}after`));
    expect(json.includes(ch)).toBe(false);
  });

  it('stays LOSSLESS: the escaped form parses back to the identical value', () => {
    const reason = `before${RLO}${CSI}${ZWSP}${INTERLINEAR}after`;
    const json = toCanonicalJson(withReason(reason));
    const parsed = JSON.parse(json) as FixtureScorecard;
    expect(parsed.rows[0]?.reason).toBe(reason);
  });

  // The property the drift comparators rest on. redteam-command compares the
  // file's RAW BYTES against toCanonicalJson(fresh), and falls back to
  // comparing toCanonicalJson(parsed). Both sides must agree after a
  // write/read round trip or every run reports drift that is not there.
  it('round-trips: re-serialising the parsed form reproduces the same bytes', () => {
    const json = toCanonicalJson(withReason(`x${RLO}y`));
    expect(toCanonicalJson(JSON.parse(json) as FixtureScorecard)).toBe(json);
  });

  it('leaves ASCII-only scorecards byte-identical, so existing baselines do not churn', () => {
    const plain = card([row('a', false), row('b', true)]);
    const before = `${JSON.stringify(sortedForFixture(plain), null, 2)}\n`;
    expect(toCanonicalJson(plain)).toBe(before);
  });
});

// Mirrors toCanonicalJson's own ordering so the no-churn test above compares
// against an independently built expectation rather than the function itself.
function sortedForFixture(scorecard: FixtureScorecard): unknown {
  const sortDeep = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortDeep);
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((k) => [k, sortDeep(record[k])]),
      );
    }
    return value;
  };
  const rows = [...scorecard.rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sortDeep({ ...scorecard, rows });
}
