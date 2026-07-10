import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scan } from '../../security/index.js';
import { toCanonicalJson } from '../scorecard/index.js';
import { BaselineError, loadBaseline, MAX_BASELINE_BYTES, normalizeForBaseline } from './baseline.js';
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

describe('loadBaseline', () => {
  const dirs: string[] = [];

  const writeBaseline = (dir: string, content: string): string => {
    const path = join(dir, 'baseline.json');
    writeFileSync(path, content);
    return path;
  };

  const freshDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'e3-'));
    dirs.push(dir);
    return dir;
  };

  /** A JSON-round-tripped good baseline: plain data (not the typed
   *  BaselineScorecard) so tests below can mutate it into hostile shapes
   *  that would not type-check against the real interface. */
  const goodJson = (): Record<string, unknown> =>
    JSON.parse(toCanonicalJson(normalizeForBaseline(fresh()))) as Record<string, unknown>;

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws BaselineError with "no baseline found" when the file is missing', () => {
    const path = join(freshDir(), 'missing-baseline.json');
    expect(() => loadBaseline(path)).toThrow(BaselineError);
    expect(() => loadBaseline(path)).toThrow(/no baseline found/);
  });

  it('throws BaselineError with "exceeds" when the file is over MAX_BASELINE_BYTES', () => {
    const path = writeBaseline(freshDir(), 'x'.repeat(MAX_BASELINE_BYTES + 1));
    expect(() => loadBaseline(path)).toThrow(BaselineError);
    expect(() => loadBaseline(path)).toThrow(/exceeds/);
  });

  it('throws BaselineError with "symlink" when the baseline path is a symlinked file', () => {
    const dir = freshDir();
    const realPath = writeBaseline(dir, toCanonicalJson(normalizeForBaseline(fresh())));
    const linkPath = join(dir, 'linked-baseline.json');
    symlinkSync(realPath, linkPath);
    expect(() => loadBaseline(linkPath)).toThrow(BaselineError);
    expect(() => loadBaseline(linkPath)).toThrow(/symlink/);
  });

  it('throws BaselineError with "parse" (case-insensitive) on malformed JSON', () => {
    const path = writeBaseline(freshDir(), '{');
    expect(() => loadBaseline(path)).toThrow(BaselineError);
    expect(() => loadBaseline(path)).toThrow(/parse/i);
  });

  describe('shape violations (each rejected as /baseline/ with ajv detail)', () => {
    it('rejects an extra top-level key', () => {
      const mutated = { ...goodJson(), extra: 1 };
      const path = writeBaseline(freshDir(), JSON.stringify(mutated));
      expect(() => loadBaseline(path)).toThrow(BaselineError);
      expect(() => loadBaseline(path)).toThrow(/baseline/);
    });

    it('rejects rows as a non-array object', () => {
      const mutated = { ...goodJson(), rows: {} };
      const path = writeBaseline(freshDir(), JSON.stringify(mutated));
      expect(() => loadBaseline(path)).toThrow(/baseline/);
    });

    it('rejects a row with a non-string id', () => {
      const base = goodJson();
      const rows = base.rows as Array<Record<string, unknown>>;
      const mutatedRows = [{ ...rows[0], id: 42 }, ...rows.slice(1)];
      const path = writeBaseline(freshDir(), JSON.stringify({ ...base, rows: mutatedRows }));
      expect(() => loadBaseline(path)).toThrow(/baseline/);
    });

    it('rejects a row with an extra field', () => {
      const base = goodJson();
      const rows = base.rows as Array<Record<string, unknown>>;
      const mutatedRows = [{ ...rows[0], lastEvaluatedAt: '2026-01-01T00:00:00.000Z' }, ...rows.slice(1)];
      const path = writeBaseline(freshDir(), JSON.stringify({ ...base, rows: mutatedRows }));
      expect(() => loadBaseline(path)).toThrow(/baseline/);
    });

    it('rejects a row id of "__proto__"', () => {
      const base = goodJson();
      const rows = base.rows as Array<Record<string, unknown>>;
      const mutatedRows = [{ ...rows[0], id: '__proto__' }, ...rows.slice(1)];
      const path = writeBaseline(freshDir(), JSON.stringify({ ...base, rows: mutatedRows }));
      expect(() => loadBaseline(path)).toThrow(/baseline/);
    });

    it('rejects a beacon-shaped row id', () => {
      const base = goodJson();
      const rows = base.rows as Array<Record<string, unknown>>;
      const mutatedRows = [{ ...rows[0], id: 'x](http://evil)' }, ...rows.slice(1)];
      const path = writeBaseline(freshDir(), JSON.stringify({ ...base, rows: mutatedRows }));
      expect(() => loadBaseline(path)).toThrow(/baseline/);
    });
  });

  it('rejects schemaVersion: 2 and producer: "golden"', () => {
    const withBadVersion = { ...goodJson(), schemaVersion: 2 };
    expect(() => loadBaseline(writeBaseline(freshDir(), JSON.stringify(withBadVersion)))).toThrow(BaselineError);

    const withBadProducer = { ...goodJson(), producer: 'golden' };
    expect(() => loadBaseline(writeBaseline(freshDir(), JSON.stringify(withBadProducer)))).toThrow(BaselineError);
  });

  it('happy path: returns raw byte-equal to disk and parsed.rows for the whole corpus', () => {
    const raw = toCanonicalJson(normalizeForBaseline(fresh()));
    const path = writeBaseline(freshDir(), raw);
    const result = loadBaseline(path);
    expect(result.raw).toBe(raw);
    expect(result.parsed.rows.length).toBe(CORPUS.length);
  });
});
