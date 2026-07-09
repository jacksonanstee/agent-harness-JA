import { describe, expect, it } from 'vitest';
import { toMarkdown } from './markdown.js';
import type { Scorecard, ScorecardRow } from './types.js';

function makeCard(rows: ScorecardRow[], overrides?: {
  totalCostUsd?: number;
  unpricedTasks?: number;
}): Scorecard {
  const passed = rows.filter((r) => r.pass).length;
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
      passed,
      failed: rows.length - passed,
      byFailureKind: {
        'task-parse': rows.filter((r) => r.failureKind === 'task-parse').length,
        'oracle-load': rows.filter((r) => r.failureKind === 'oracle-load').length,
        'session-error': rows.filter((r) => r.failureKind === 'session-error').length,
        'oracle-error': rows.filter((r) => r.failureKind === 'oracle-error').length,
        'oracle-fail': rows.filter((r) => r.failureKind === 'oracle-fail').length,
      },
      passRate: rows.length === 0 ? 0 : passed / rows.length,
      totalCostUsd: overrides?.totalCostUsd ?? 0.1,
      unpricedTasks: overrides?.unpricedTasks ?? 0,
    },
  };
}

const passRow: ScorecardRow = {
  id: 'hello-world',
  pass: true,
  failureKind: null,
  reason: null,
  volatile: { costUsd: 0.05, numTurns: 3, durationMs: 8200, resultSubtype: 'success' },
};

const failRow: ScorecardRow = {
  id: 'broken-task',
  pass: false,
  failureKind: 'oracle-fail',
  reason: 'expected "pong" | got\nsomething else',
  volatile: { costUsd: null, numTurns: null, durationMs: null, resultSubtype: null },
};

describe('toMarkdown', () => {
  it('renders totals BEFORE the table', () => {
    const md = toMarkdown(makeCard([passRow, failRow]));
    expect(md.indexOf('passed')).toBeLessThan(md.indexOf('| task |'));
  });

  it('renders an exact cost when every row is priced', () => {
    const md = toMarkdown(makeCard([passRow], { totalCostUsd: 0.05, unpricedTasks: 0 }));
    expect(md).toContain('$0.0500');
    expect(md).not.toContain('≥');
  });

  it('renders a lower-bound cost when rows are unpriced — never a silent understatement', () => {
    const md = toMarkdown(makeCard([passRow, failRow], { totalCostUsd: 0.05, unpricedTasks: 1 }));
    expect(md).toContain('≥ $0.0500 (1 task unpriced)');
  });

  it('escapes pipes and newlines in reason cells (Markdown injection)', () => {
    const md = toMarkdown(makeCard([failRow]));
    const tableLine = md.split('\n').find((l) => l.includes('broken-task'));
    expect(tableLine).toBeDefined();
    expect(tableLine).toContain('\\|');
    expect(tableLine).not.toContain('got\nsomething');
  });

  it('truncates long reasons to a single short cell', () => {
    const long = { ...failRow, reason: 'x'.repeat(400) };
    const md = toMarkdown(makeCard([long]));
    const tableLine = md.split('\n').find((l) => l.includes('broken-task'));
    expect(tableLine).toBeDefined();
    expect((tableLine as string).length).toBeLessThan(250);
  });

  it('lists only non-zero failure kinds in the totals', () => {
    const md = toMarkdown(makeCard([passRow, failRow]));
    expect(md).toContain('oracle-fail: 1');
    expect(md).not.toContain('task-parse: 0');
  });
});
