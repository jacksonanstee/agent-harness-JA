import { describe, expect, it } from 'vitest';

import { scan } from '../../security/index.js';
import { toCanonicalJson } from '../scorecard/index.js';
import { normalizeForBaseline } from './baseline.js';
import { CORPUS } from './corpus.js';
import { runRedteam } from './runner.js';
import { REDTEAM_ARM_LABEL } from './types.js';

const fresh = () =>
  runRedteam(CORPUS, scan, { armLabel: REDTEAM_ARM_LABEL, harnessVersion: '9.9.9', now: () => 1234 });

describe('normalizeForBaseline', () => {
  it('drops exactly createdAt and harnessVersion, keeps everything else', () => {
    const n = normalizeForBaseline(fresh());
    expect(n.meta).toEqual({ corpusSize: CORPUS.length, armLabel: REDTEAM_ARM_LABEL });
    expect(n.schemaVersion).toBe(1);
    expect(n.producer).toBe('redteam');
    expect(n.rows).toEqual(fresh().rows);
    expect(n.totals).toEqual(fresh().totals);
  });

  it('is volatile-proof: two runs at different times/versions normalize byte-identically', () => {
    const a = runRedteam(CORPUS, scan, { armLabel: REDTEAM_ARM_LABEL, harnessVersion: '1.0.0', now: () => 1 });
    const b = runRedteam(CORPUS, scan, { armLabel: REDTEAM_ARM_LABEL, harnessVersion: '2.0.0', now: () => 999_999 });
    expect(toCanonicalJson(normalizeForBaseline(a))).toBe(toCanonicalJson(normalizeForBaseline(b)));
  });

  it('does not mutate its input', () => {
    const s = fresh();
    const n = normalizeForBaseline(s);
    expect(s.meta.createdAt).toBeDefined();
    expect(n.rows).not.toBe(s.rows);
    expect(n.totals).not.toBe(s.totals);
  });
});
