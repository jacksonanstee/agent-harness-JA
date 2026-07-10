import { describe, expect, it } from 'vitest';
import { toRedteamMarkdown } from './markdown.js';
import type { RedteamScorecard } from './runner.js';

const card: RedteamScorecard = {
  schemaVersion: 1, producer: 'redteam',
  meta: { createdAt: '2026-07-10T00:00:00.000Z', harnessVersion: '0.1.0', corpusSize: 2, armLabel: 'security-on' },
  rows: [
    { id: 'm-1', category: 'direct', verdict: 'block', expected: 'block', pass: true, failureKind: null, reason: 'malicious input blocked' },
    { id: 'b-1', category: 'benign', verdict: 'pass', expected: 'pass', pass: true, failureKind: null, reason: 'benign input passed' },
  ],
  totals: { total: 2, passed: 2, failed: 0, byFailureKind: { missed: 0, 'false-flag': 0, 'false-block': 0 }, malicious: 1, detected: 1, blocked: 1, flaggedOnly: 0, falseBlockCount: 0 },
};

describe('toRedteamMarkdown', () => {
  it('leads with the gate outcome', () => {
    const md = toRedteamMarkdown(card);
    expect(md.indexOf('Gate:')).toBeLessThan(md.indexOf('| id |'));
    expect(md).toContain('Gate: PASS');
    expect(md).toContain('false-blocks: 0');
  });
  it('renders detection as N/M with counts and the strength split', () => {
    // Fixture with a non-trivial split (blocked 1, flagged-only 1) so a swap of
    // the two counts, or dropping the segment, fails — ADR-0018 decision 9's
    // interim block->ask-softening defense lives in this render line.
    const strengthCard: RedteamScorecard = {
      ...card,
      meta: { ...card.meta, corpusSize: 2 },
      rows: [
        { id: 'm-block', category: 'direct', verdict: 'block', expected: 'block', pass: true, failureKind: null, reason: 'malicious input blocked' },
        { id: 'm-ask', category: 'indirect', verdict: 'ask', expected: 'block', pass: true, failureKind: null, reason: 'malicious input flagged (ask)' },
      ],
      totals: { total: 2, passed: 2, failed: 0, byFailureKind: { missed: 0, 'false-flag': 0, 'false-block': 0 }, malicious: 2, detected: 2, blocked: 1, flaggedOnly: 1, falseBlockCount: 0 },
    };
    const md = toRedteamMarkdown(strengthCard);
    expect(md).toMatch(/2\/2 malicious/);
    expect(md).toContain('blocked 1 / flagged-only 1');
  });
  it('never renders the bare word FAIL for a missed/detected row', () => {
    const md = toRedteamMarkdown(card);
    expect(md).not.toMatch(/\bFAIL\b/);
  });
  it('escapes the id field (image-beacon guard, defense in depth)', () => {
    const evil = { ...card, rows: [{ ...card.rows[0]!, id: 'x-|pipe' }] };
    expect(toRedteamMarkdown(evil)).toContain('x-\\|pipe');
  });
});
