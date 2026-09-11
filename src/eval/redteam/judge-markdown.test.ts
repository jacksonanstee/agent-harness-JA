import { describe, expect, it } from 'vitest';

import { toRedteamJudgeMarkdown } from './judge-markdown.js';
import type { RedteamJudgeRow, RedteamJudgeScorecard } from './judge-runner.js';

// Issue #96 PR-A, design spec D6 "Markdown (U-7)" (pin 30). The judge
// scorecard is report-only: its first line says so, and nothing in it is a
// gate. Row fixtures carry ids, enums and fixed reasons only, never text.

const row = (overrides: Partial<RedteamJudgeRow> & Pick<RedteamJudgeRow, 'id'>): RedteamJudgeRow => ({
  slice: 'corpus',
  category: 'direct',
  expected: 'block',
  heuristic: 'ask',
  status: 'judged',
  judge: 'block',
  composedAlways: 'block',
  composedSuspicious: 'block',
  judgeOnly: false,
  pass: true,
  failureKind: null,
  reason: 'judge escalated to block',
  ...overrides,
});

const zeroMode = { malicious: 0, detected: 0, blocked: 0, flaggedOnly: 0, missed: 0, benignJudged: 0, falseBlockCount: 0, falseFlagCount: 0 };

const card: RedteamJudgeScorecard = {
  schemaVersion: 1,
  producer: 'redteam-judge',
  meta: {
    createdAt: '2026-09-09T00:00:00.000Z',
    harnessVersion: '0.1.0',
    armLabel: 'judge',
    judgeModel: 'claude-haiku-4-5',
    corpusSize: 2,
    holdoutSize: 2,
  },
  rows: [
    row({ id: 'a-1' }),
    row({ id: 'b-1', category: 'benign', expected: 'pass', heuristic: 'pass', judge: 'pass', composedAlways: 'pass', composedSuspicious: 'pass', reason: 'judge agreed' }),
    row({ id: 'h-1', slice: 'holdout', category: 'jailbreak', heuristic: 'pass', judge: 'ask', composedAlways: 'ask', composedSuspicious: 'pass', judgeOnly: true, reason: 'judge escalated to ask' }),
    row({ id: 'h-2', slice: 'holdout', category: 'exfil', heuristic: 'pass', status: 'timed-out', judge: null, composedAlways: 'pass', composedSuspicious: 'pass', pass: false, failureKind: 'missed', reason: 'judge timed out; floor held' }),
  ],
  totals: {
    total: 4,
    passed: 3,
    failed: 1,
    byFailureKind: { missed: 1, 'false-flag': 0, 'false-block': 0 },
    attempted: 4,
    judged: 3,
    judgeErrors: 1,
    stoppedEarly: false,
    costUsd: 0.0123,
    costUnknown: 2,
    bySlice: {
      corpus: {
        always: { ...zeroMode, malicious: 1, detected: 1, blocked: 1, benignJudged: 1 },
        suspicious: { ...zeroMode, malicious: 1, detected: 1, blocked: 1, benignJudged: 1 },
      },
      holdout: {
        always: { ...zeroMode, malicious: 2, detected: 1, flaggedOnly: 1, missed: 1 },
        suspicious: { ...zeroMode, malicious: 2, missed: 2 },
      },
    },
    judgeOnlyByCategory: { direct: 0, indirect: 0, jailbreak: 1, exfil: 0, benign: 0 },
    confirmedFromAskByCategory: { direct: 1, indirect: 0, jailbreak: 0, exfil: 0, benign: 0 },
  },
};

const lines = (md: string): string[] => md.split('\n');
const lineWith = (md: string, ...needles: string[]): string | undefined =>
  lines(md).find((line) => needles.every((n) => line.includes(n)));

describe('toRedteamJudgeMarkdown (pin 30)', () => {
  it('first line says report-only and not the gate, exactly', () => {
    expect(lines(toRedteamJudgeMarkdown(card))[0]).toBe('# Judge scorecard (report-only; not the gate)');
  });

  it('ends with exactly one trailing newline (U-3: the machine line after it must start at column 0)', () => {
    const md = toRedteamJudgeMarkdown(card);
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  it('carries the two-line legend defining always, suspicious and judgeOnly', () => {
    const md = toRedteamJudgeMarkdown(card);
    expect(lineWith(md, 'always', 'every non-block')).toBeDefined();
    expect(lineWith(md, 'suspicious', 'marked suspicious')).toBeDefined();
    expect(lineWith(md, 'judgeOnly', 'heuristic', 'pass')).toBeDefined();
  });

  it('renders per-slice and per-mode detection lines as detected/malicious', () => {
    const md = toRedteamJudgeMarkdown(card);
    expect(lineWith(md, 'corpus', 'always', '1/1')).toBeDefined();
    expect(lineWith(md, 'corpus', 'suspicious', '1/1')).toBeDefined();
    expect(lineWith(md, 'holdout', 'always', '1/2')).toBeDefined();
    expect(lineWith(md, 'holdout', 'suspicious', '0/2')).toBeDefined();
  });

  it('renders the cost as a floor with the unpriced count when any attempted call was unpriced', () => {
    const md = toRedteamJudgeMarkdown(card);
    expect(lineWith(md, 'Judge cost: ≥ $0.0123 (2 calls unpriced)')).toBeDefined();
  });

  it('renders the cost exactly when every attempted call was priced', () => {
    const priced: RedteamJudgeScorecard = { ...card, totals: { ...card.totals, costUnknown: 0 } };
    const md = toRedteamJudgeMarkdown(priced);
    expect(lineWith(md, 'Judge cost: $0.0123')).toBeDefined();
    expect(md).not.toContain('unpriced');
  });

  it('renders the by-category split lines: judgeOnly and confirmed-from-ask counts by the case category', () => {
    const md = toRedteamJudgeMarkdown(card);
    expect(lineWith(md, 'judgeOnly', 'jailbreak: 1')).toBeDefined();
    expect(lineWith(md, 'confirmed', 'direct: 1')).toBeDefined();
  });

  it('names the model, the slice sizes and the arm on a meta line', () => {
    const md = toRedteamJudgeMarkdown(card);
    expect(lineWith(md, 'claude-haiku-4-5')).toBeDefined();
    expect(lineWith(md, 'harness v0.1.0')).toBeDefined();
  });

  it('renders the per-case table after the summary, one row per id, with status and reason', () => {
    const md = toRedteamJudgeMarkdown(card);
    const header = lines(md).findIndex((l) => l.startsWith('| id |'));
    expect(header).toBeGreaterThan(0);
    expect(lines(md)[header + 1]?.startsWith('|--')).toBe(true);
    for (const r of card.rows) {
      const line = lineWith(md, `| ${r.id} |`);
      expect(line, r.id).toBeDefined();
      expect(line, r.id).toContain(r.status);
      expect(line, r.id).toContain(r.reason);
      expect(lines(md).indexOf(line ?? ''), r.id).toBeGreaterThan(header);
    }
    expect(lines(md).filter((l) => l.startsWith('| ') && !l.startsWith('| id |')).length).toBe(card.rows.length);
  });

  it('escapes the id cell (image-beacon guard, escapeCell)', () => {
    const evil: RedteamJudgeScorecard = { ...card, rows: [row({ id: 'x-|pipe' })] };
    expect(toRedteamJudgeMarkdown(evil)).toContain('x-\\|pipe');
  });

  it('never renders the bare word FAIL and carries no case text (rows have none to carry)', () => {
    const md = toRedteamJudgeMarkdown(card);
    expect(md).not.toMatch(/\bFAIL\b/);
    expect(md).not.toContain('GATE_FAILURE');
    expect(md).not.toContain('JUDGE_ARM=');
  });

  it('reports an early stop when totals.stoppedEarly is set', () => {
    const stopped: RedteamJudgeScorecard = { ...card, totals: { ...card.totals, stoppedEarly: true } };
    expect(lineWith(toRedteamJudgeMarkdown(stopped), 'stopped early')).toBeDefined();
    expect(lineWith(toRedteamJudgeMarkdown(card), 'stopped early')).toBeUndefined();
  });
});
