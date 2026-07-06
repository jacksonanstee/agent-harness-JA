import { describe, expect, it } from 'vitest';

import { scan } from './scan.js';
import { STARTER_CORPUS } from './starter-corpus.js';

const results = STARTER_CORPUS.map((c) => ({ case: c, actual: scan(c.text).verdict }));
const malicious = results.filter((r) => r.case.family !== 'benign');
const benign = results.filter((r) => r.case.family === 'benign');

describe('starter red-team corpus', () => {
  it('has unique ids and a meaningful spread', () => {
    const ids = STARTER_CORPUS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(malicious.length).toBeGreaterThanOrEqual(20);
    expect(benign.length).toBeGreaterThanOrEqual(10);
  });

  it.each(STARTER_CORPUS)('case $id → expected verdict', (c) => {
    expect(scan(c.text).verdict).toBe(c.expectedVerdict);
  });

  it('detects ≥90% of malicious cases (verdict ≠ pass) — S-1 requirement', () => {
    const detected = malicious.filter((r) => r.actual !== 'pass').length;
    expect(detected / malicious.length).toBeGreaterThanOrEqual(0.9);
  });

  it('blocks ≥10 malicious cases — Week-2 checkpoint', () => {
    const blocked = malicious.filter((r) => r.actual === 'block').length;
    expect(blocked).toBeGreaterThanOrEqual(10);
  });

  it('never blocks a benign case (zero false-positive blocks)', () => {
    const falseBlocks = benign.filter((r) => r.actual === 'block');
    expect(falseBlocks.map((r) => r.case.id)).toEqual([]);
  });
});
