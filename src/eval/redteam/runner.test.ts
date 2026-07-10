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
    expect(byId['m-block']?.failureKind).toBeNull();
    expect(byId['m-miss']?.failureKind).toBe('missed');
    expect(byId['b-ok']?.failureKind).toBeNull();
    expect(byId['b-block']?.failureKind).toBe('false-block');
  });
  it('gate field falseBlockCount counts only benign->block', () => {
    expect(sc.totals.falseBlockCount).toBe(1);
  });
  it('detection is over malicious cases only', () => {
    expect(sc.totals.malicious).toBe(2);
    expect(sc.totals.detected).toBe(1); // m-block detected, m-miss missed
  });
  it('rows are deterministic — no cost/turns volatile', () => {
    expect('volatile' in sc.rows[0]!).toBe(false);
  });
  it('producer discriminator + schemaVersion', () => {
    expect(sc.producer).toBe('redteam');
    expect(sc.schemaVersion).toBe(1);
  });
});

describe('runRedteam (id validation)', () => {
  it('throws on a beacon-shaped corpus id at runtime (not just in the corpus test)', () => {
    const evil: CorpusCase[] = [
      { id: 'x-![b](http://e/x)', category: 'direct', text: 'A', expected: 'block' },
    ];
    expect(() => runRedteam(evil, scanStub({ A: 'block' }), { armLabel: 'security-on', now: () => 0 }))
      .toThrow(/invalid corpus id/);
  });
});

describe('runRedteam (null/off arm)', () => {
  it('null scanner detects zero malicious', () => {
    const nullScan = (): ScanResult => ({ verdict: 'pass', rule_ids: [], excerpts: [], suspicious: false });
    const sc = runRedteam(cases, nullScan, { armLabel: 'security-off', now: () => 0 });
    expect(sc.totals.detected).toBe(0);
  });
});

describe('runRedteam (ask verdict)', () => {
  const askCases: CorpusCase[] = [
    { id: 'm-ask',   category: 'direct',   text: 'E', expected: 'block' }, // malicious, scanned as ask
    { id: 'm-block', category: 'indirect', text: 'F', expected: 'block' }, // malicious, scanned as block
    { id: 'b-ask',   category: 'benign',   text: 'G', expected: 'pass' },  // benign, scanned as ask
  ];
  const scan = scanStub({ E: 'ask', F: 'block', G: 'ask' });
  const sc = runRedteam(askCases, scan, { armLabel: 'security-on', now: () => 0 });
  const byId = Object.fromEntries(sc.rows.map((r) => [r.id, r]));

  it('malicious + ask is detected: failureKind null, pass true', () => {
    expect(byId['m-ask']?.failureKind).toBeNull();
    expect(byId['m-ask']?.pass).toBe(true);
  });
  it('benign + ask is a tolerated soft flag: false-flag, pass true', () => {
    expect(byId['b-ask']?.failureKind).toBe('false-flag');
    expect(byId['b-ask']?.pass).toBe(true);
  });
  it('benign + ask does not count toward falseBlockCount', () => {
    expect(sc.totals.falseBlockCount).toBe(0);
  });
  it('splits detected malicious into blocked vs flaggedOnly, summing to detected', () => {
    expect(sc.totals.detected).toBe(2); // m-ask + m-block
    expect(sc.totals.blocked).toBe(1); // m-block
    expect(sc.totals.flaggedOnly).toBe(1); // m-ask
    expect(sc.totals.blocked + sc.totals.flaggedOnly).toBe(sc.totals.detected);
  });
});
