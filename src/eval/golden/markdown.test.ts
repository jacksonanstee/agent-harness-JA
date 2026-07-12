import { describe, expect, it } from 'vitest';
import { toMarkdown } from './markdown.js';
import type { GoldenRow, GoldenScorecard, VerificationSection } from './scorecard-shape.js';
import type { ChallengeFinding } from '../verifier/types.js';

function makeCard(rows: GoldenRow[], overrides?: {
  totalCostUsd?: number;
  unpricedTasks?: number;
}): GoldenScorecard {
  const passed = rows.filter((r) => r.pass).length;
  return {
    schemaVersion: 1,
    producer: 'golden',
    meta: {
      createdAt: '2026-07-09T00:00:00.000Z',
      harnessVersion: '0.1.0-pre',
      taskDir: '/tmp/tasks',
      models: ['claude-sonnet-4-6'],
    },
    rows,
    totals: {
      total: rows.length,
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

const passRow: GoldenRow = {
  id: 'hello-world',
  pass: true,
  failureKind: null,
  reason: null,
  volatile: { costUsd: 0.05, numTurns: 3, durationMs: 8200, resultSubtype: 'success' },
};

const failRow: GoldenRow = {
  id: 'broken-task',
  pass: false,
  failureKind: 'oracle-fail',
  reason: 'expected "pong" | got\nsomething else',
  volatile: { costUsd: null, numTurns: null, durationMs: null, resultSubtype: null },
};

function sectionFixture(overrides?: Partial<VerificationSection>): VerificationSection {
  return {
    adversaryModelId: 'claude-sonnet-4-6',
    findings: [{ taskId: 'a', status: 'agreed', category: null, errorKind: null }],
    totals: { agreed: 1, challenged: 0, verifierErrors: 0, noOutput: 0 },
    totalCostUsd: 0.01,
    unpricedChallenges: 0,
    ...overrides,
  };
}

describe('toMarkdown — verification section', () => {
  it('renders the "not run" line when the verification key is absent', () => {
    const md = toMarkdown(makeCard([passRow]));
    expect(md).toContain(
      'Adversarial challenge: not run — pass --challenge (adds a second model call per passed task)',
    );
  });

  it('renders the "nothing to challenge" line when totals.passed === 0', () => {
    const card: GoldenScorecard = {
      ...makeCard([failRow]),
      verification: sectionFixture(),
    };
    const md = toMarkdown(card);
    expect(md).toContain(
      'Adversarial challenge (report-only): 0 passed tasks — nothing to challenge',
    );
    expect(md).not.toContain('| task | status | category / error |');
  });

  it('renders the summary line with no table when every finding is agreed', () => {
    const rows: GoldenRow[] = [
      { ...passRow, id: 'p1' },
      { ...passRow, id: 'p2' },
    ];
    const findings: ChallengeFinding[] = [
      { taskId: 'p1', status: 'agreed', category: null, errorKind: null },
      { taskId: 'p2', status: 'agreed', category: null, errorKind: null },
    ];
    const card: GoldenScorecard = {
      ...makeCard(rows),
      verification: sectionFixture({
        findings,
        totals: { agreed: 2, challenged: 0, verifierErrors: 0, noOutput: 0 },
      }),
    };
    const md = toMarkdown(card);
    expect(md).toContain(
      'Adversary: claude-sonnet-4-6 · challenged 0 / agreed 2 / errors 0 / no-output 0, of 2 passed tasks',
    );
    expect(md).not.toContain('| task | status | category / error |');
  });

  it('renders the mixed-state summary and a non-agreed-only table', () => {
    const rows: GoldenRow[] = Array.from({ length: 5 }, (_, i) => ({
      ...passRow,
      id: `p${i}`,
    }));
    const findings: ChallengeFinding[] = [
      { taskId: 'di-01', status: 'challenged', category: 'incomplete', errorKind: null },
      { taskId: 'gate-01', status: 'no-output', category: null, errorKind: null },
      { taskId: 'a1', status: 'agreed', category: null, errorKind: null },
      { taskId: 'a2', status: 'agreed', category: null, errorKind: null },
      { taskId: 'a3', status: 'agreed', category: null, errorKind: null },
    ];
    const card: GoldenScorecard = {
      ...makeCard(rows),
      verification: sectionFixture({
        findings,
        totals: { agreed: 3, challenged: 1, verifierErrors: 0, noOutput: 1 },
      }),
    };
    const md = toMarkdown(card);
    expect(md).toContain(
      'challenged 1 / agreed 3 / errors 0 / no-output 1, of 5 passed tasks',
    );
    const tableRows = md
      .split('\n')
      .filter((l) => l.startsWith('| di-01') || l.startsWith('| gate-01') || l.startsWith('| a1') || l.startsWith('| a2') || l.startsWith('| a3'));
    expect(tableRows).toHaveLength(2);
    expect(tableRows[0]).toBe('| di-01 | challenged | incomplete |');
    expect(tableRows[1]).toBe('| gate-01 | no-output | — |');
  });

  it('renders the challenge cost line via money()', () => {
    const card: GoldenScorecard = {
      ...makeCard([passRow]),
      verification: sectionFixture({ totalCostUsd: 0.0312, unpricedChallenges: 0 }),
    };
    const md = toMarkdown(card);
    expect(md).toContain('Challenge cost: $0.0312 (0 unpriced)');
  });

  it('escapes the adversaryModelId in the summary line (defense-in-depth, review3 LOW L-1)', () => {
    // adversaryModelId is router-derived in production (never attacker
    // input), but the summary line renders it unescaped — escapeCell is
    // identity for real model ids, so this is defense-in-depth only.
    const card: GoldenScorecard = {
      ...makeCard([passRow]),
      verification: sectionFixture({ adversaryModelId: 'claude|sonnet\n-4-6' }),
    };
    const md = toMarkdown(card);
    expect(md).toContain('Adversary: claude\\|sonnet -4-6');
    expect(md).not.toContain('Adversary: claude|sonnet\n-4-6');
  });

  it('escapes pipes in finding taskId cells (Markdown injection)', () => {
    const findings: ChallengeFinding[] = [
      { taskId: 'a|b', status: 'challenged', category: 'incorrect', errorKind: null },
    ];
    const card: GoldenScorecard = {
      ...makeCard([passRow]),
      verification: sectionFixture({
        findings,
        totals: { agreed: 0, challenged: 1, verifierErrors: 0, noOutput: 0 },
      }),
    };
    const md = toMarkdown(card);
    const tableLine = md.split('\n').find((l) => l.includes('a\\|b'));
    expect(tableLine).toBeDefined();
  });
});

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

  it('does not bisect a surrogate pair at the cell truncation boundary', () => {
    // 119 'a' puts the emoji's high surrogate exactly at the 120-char cut.
    const long = { ...failRow, reason: 'a'.repeat(119) + '😀tail' };
    const md = toMarkdown(makeCard([long]));
    const hasLoneSurrogate = [...md].some((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0xd800 && code <= 0xdfff;
    });
    expect(hasLoneSurrogate).toBe(false);
  });

  it('lists only non-zero failure kinds in the totals', () => {
    const md = toMarkdown(makeCard([passRow, failRow]));
    expect(md).toContain('oracle-fail: 1');
    expect(md).not.toContain('task-parse: 0');
  });
});
