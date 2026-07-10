import { describe, expect, it } from 'vitest';
import type { ScanResult, Verdict } from '../../security/index.js';
import { runRedteam } from './runner.js';
import type { CorpusCase } from './types.js';

const scanStub = (map: Record<string, Verdict>) => (text: string): ScanResult =>
  ({ verdict: map[text] ?? 'pass', rule_ids: [], excerpts: [], suspicious: false });

const cases: CorpusCase[] = [
  { id: 'm-block', category: 'direct', text: 'A', expected: 'block' },
  { id: 'm-miss',  category: 'indirect', text: 'B', expected: 'block' },
  { id: 'b-ok',    category: 'benign', text: 'C', expected: 'pass' },
  { id: 'b-block', category: 'benign', text: 'D', expected: 'pass' },
];

describe('runRedteam (security-on arm)', () => {
  const scan = scanStub({ A: 'block', B: 'pass', C: 'pass', D: 'block' });
  const sc = runRedteam(cases, scan, { armLabel: 'security-on', now: () => 0 });

  it('marks missed / false-block, leaves detected & ok clean', () => {
    const byId = Object.fromEntries(sc.rows.map((r) => [r.id, r]));
    expect(byId['m-block'].failureKind).toBeNull();
    expect(byId['m-miss'].failureKind).toBe('missed');
    expect(byId['b-ok'].failureKind).toBeNull();
    expect(byId['b-block'].failureKind).toBe('false-block');
  });
  it('gate field falseBlockCount counts only benign->block', () => {
    expect(sc.totals.falseBlockCount).toBe(1);
  });
  it('detection is over malicious cases only', () => {
    expect(sc.totals.malicious).toBe(2);
    expect(sc.totals.detected).toBe(1); // m-block detected, m-miss missed
  });
  it('rows are deterministic — no cost/turns volatile', () => {
    expect('volatile' in sc.rows[0]).toBe(false);
  });
  it('producer discriminator + schemaVersion', () => {
    expect(sc.producer).toBe('redteam');
    expect(sc.schemaVersion).toBe(1);
  });
});

describe('runRedteam (null/off arm)', () => {
  it('null scanner detects zero malicious', () => {
    const nullScan = (): ScanResult => ({ verdict: 'pass', rule_ids: [], excerpts: [], suspicious: false });
    const sc = runRedteam(cases, nullScan, { armLabel: 'security-off', now: () => 0 });
    expect(sc.totals.detected).toBe(0);
  });
});
