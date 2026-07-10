import { describe, expect, it } from 'vitest';
import { CORPUS } from './corpus.js';

const CATEGORIES = ['direct', 'indirect', 'jailbreak', 'exfil', 'benign'] as const;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

describe('red-team corpus', () => {
  it('has at least 50 cases', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(50);
  });
  it('every id is safe-charset (rejects markdown/beacon injection in the rendered id field)', () => {
    for (const c of CORPUS) expect(c.id, c.id).toMatch(ID_RE);
  });
  it('ids are unique', () => {
    expect(new Set(CORPUS.map((c) => c.id)).size).toBe(CORPUS.length);
  });
  it('meets the per-family floor of >=8 in every category', () => {
    for (const cat of CATEGORIES) {
      const n = CORPUS.filter((c) => c.category === cat).length;
      expect(n, `${cat}=${n}`).toBeGreaterThanOrEqual(8);
    }
  });
  it('is internally consistent: benign expects pass, malicious expects block or ask', () => {
    for (const c of CORPUS) {
      if (c.category === 'benign') expect(c.expected, c.id).toBe('pass');
      else expect(['block', 'ask'], c.id).toContain(c.expected);
    }
  });
});
