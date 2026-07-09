import { describe, expect, it } from 'vitest';
import { toCanonicalJson } from './canonical.js';
import type { Scorecard, ScorecardRow } from './types.js';

function row(id: string, pass: boolean): ScorecardRow {
  return {
    id,
    pass,
    failureKind: pass ? null : 'oracle-fail',
    reason: pass ? null : 'expected pong',
    volatile: { costUsd: 0.05, numTurns: 3, durationMs: 1200, resultSubtype: 'success' },
  };
}

function card(rows: ScorecardRow[]): Scorecard {
  return {
    schemaVersion: 1,
    meta: {
      createdAt: '2026-07-09T00:00:00.000Z',
      harnessVersion: '0.1.0-pre',
      taskDir: '/tmp/tasks',
      models: ['claude-sonnet-4-6'],
    },
    rows,
    totals: {
      tasks: rows.length,
      passed: rows.filter((r) => r.pass).length,
      failed: rows.filter((r) => !r.pass).length,
      byFailureKind: {
        'task-parse': 0,
        'oracle-load': 0,
        'session-error': 0,
        'oracle-error': 0,
        'oracle-fail': rows.filter((r) => !r.pass).length,
      },
      passRate: rows.filter((r) => r.pass).length / rows.length,
      totalCostUsd: 0.05 * rows.length,
      unpricedTasks: 0,
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
    const parsed = JSON.parse(toCanonicalJson(original)) as Scorecard;
    expect(parsed.rows).toEqual(original.rows);
    expect(parsed.totals).toEqual(original.totals);
  });
});
