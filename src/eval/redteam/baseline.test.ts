import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scan } from '../../security/index.js';
import { toCanonicalJson } from '../scorecard/index.js';
import type { BaselineMeta, BaselineScorecard } from './baseline.js';
import {
  BaselineError,
  classifyDrift,
  loadBaseline,
  MAX_BASELINE_BYTES,
  normalizeForBaseline,
  renderDriftReport,
  totalsMismatchDetail,
} from './baseline.js';
import { CORPUS } from './corpus.js';
import type { RedteamRow, RedteamTotals } from './runner.js';
import { runRedteam } from './runner.js';
import type { Category } from './types.js';
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

  it('throws BaselineError with "symlink" when the parent directory is a symlink', () => {
    const dir = freshDir();
    const realDir = join(dir, 'real-dir');
    mkdirSync(realDir);
    writeBaseline(realDir, toCanonicalJson(normalizeForBaseline(fresh())));
    const linkedDir = join(dir, 'linked-dir');
    symlinkSync(realDir, linkedDir);
    const viaLink = join(linkedDir, 'baseline.json');
    expect(() => loadBaseline(viaLink)).toThrow(BaselineError);
    expect(() => loadBaseline(viaLink)).toThrow(/symlink/);
  });

  it('throws BaselineError with "cannot read" when the baseline path is a directory', () => {
    const path = join(freshDir(), 'baseline.json');
    mkdirSync(path);
    expect(() => loadBaseline(path)).toThrowError(BaselineError);
    expect(() => loadBaseline(path)).toThrow(/cannot read/);
  });

  it('throws BaselineError with "parse" on malformed JSON, without echoing file bytes', () => {
    // The marker (with an ANSI-escape prefix) stands in for attacker-controlled
    // bytes; V8's SyntaxError would embed a snippet of it — the loader must not.
    const path = writeBaseline(freshDir(), '{\u001b[31mEVIL');
    expect(() => loadBaseline(path)).toThrowError(BaselineError);
    expect(() => loadBaseline(path)).toThrow(/parse/i);
    let message = '';
    try {
      loadBaseline(path);
    } catch (error: unknown) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('EVIL');
    expect(message).not.toContain('\u001b');
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
    // Both the class AND a message assertion: toThrow(BaselineError) alone
    // matched ANY error while loadBaseline was unimplemented (the import was
    // undefined, and toThrow(undefined) matches everything) — the message
    // regex is what makes this test capable of failing.
    const badVersionPath = writeBaseline(freshDir(), JSON.stringify({ ...goodJson(), schemaVersion: 2 }));
    expect(() => loadBaseline(badVersionPath)).toThrowError(BaselineError);
    expect(() => loadBaseline(badVersionPath)).toThrow(/invalid|baseline/);

    const badProducerPath = writeBaseline(freshDir(), JSON.stringify({ ...goodJson(), producer: 'golden' }));
    expect(() => loadBaseline(badProducerPath)).toThrowError(BaselineError);
    expect(() => loadBaseline(badProducerPath)).toThrow(/invalid|baseline/);
  });

  it('happy path: returns raw byte-equal to disk and parsed.rows for the whole corpus', () => {
    const raw = toCanonicalJson(normalizeForBaseline(fresh()));
    const path = writeBaseline(freshDir(), raw);
    const result = loadBaseline(path);
    expect(result.raw).toBe(raw);
    expect(result.parsed.rows.length).toBe(CORPUS.length);
  });
});

/**
 * Local fixture helper mirroring runner.ts's private `scoreCase` derivation
 * (design §Gate rule 6 tests): keeps synthetic rows internally consistent
 * (pass/failureKind/reason follow from category+verdict) without importing
 * runner's private scoring function or reusing production code under test.
 */
function makeRow(
  id: string,
  category: Category,
  verdict: 'pass' | 'ask' | 'block',
  expected: 'pass' | 'ask' | 'block',
): RedteamRow {
  const base = { id, category, verdict, expected };
  if (category === 'benign') {
    if (verdict === 'block') return { ...base, pass: false, failureKind: 'false-block', reason: 'benign input was blocked' };
    if (verdict === 'ask') return { ...base, pass: true, failureKind: 'false-flag', reason: 'benign input was flagged (ask)' };
    return { ...base, pass: true, failureKind: null, reason: 'benign input passed' };
  }
  if (verdict === 'pass') return { ...base, pass: false, failureKind: 'missed', reason: 'malicious input not detected' };
  return {
    ...base,
    pass: true,
    failureKind: null,
    reason: verdict === 'block' ? 'malicious input blocked' : 'malicious input flagged (ask)',
  };
}

/** Mirrors runner.ts's totals derivation, independently, purely for fixture
 *  construction — the production `totalsMismatchDetail` re-derivation under
 *  test must NOT reuse this (or any other totals code): DEC-0016 backstop. */
function makeTotals(rows: RedteamRow[]): RedteamTotals {
  const detectedRows = rows.filter((r) => r.category !== 'benign' && r.verdict !== 'pass');
  return {
    total: rows.length,
    passed: rows.filter((r) => r.pass).length,
    failed: rows.filter((r) => !r.pass).length,
    byFailureKind: {
      missed: rows.filter((r) => r.failureKind === 'missed').length,
      'false-flag': rows.filter((r) => r.failureKind === 'false-flag').length,
      'false-block': rows.filter((r) => r.failureKind === 'false-block').length,
    },
    malicious: rows.filter((r) => r.category !== 'benign').length,
    detected: detectedRows.length,
    blocked: detectedRows.filter((r) => r.verdict === 'block').length,
    flaggedOnly: detectedRows.filter((r) => r.verdict === 'ask').length,
    falseBlockCount: rows.filter((r) => r.failureKind === 'false-block').length,
  };
}

function makeScorecard(rows: RedteamRow[], metaOverrides: Partial<BaselineMeta> = {}): BaselineScorecard {
  return {
    schemaVersion: 1,
    producer: 'redteam',
    meta: { corpusSize: rows.length, armLabel: REDTEAM_ARM_LABEL, ...metaOverrides },
    rows,
    totals: makeTotals(rows),
  };
}

describe('classifyDrift', () => {
  const pair = (before: RedteamRow, after: RedteamRow) =>
    classifyDrift(makeScorecard([before]), makeScorecard([after]));

  it('malicious block -> ask is a regression (the decision-9 flagship)', () => {
    const before = makeRow('case-1', 'direct', 'block', 'block');
    const after = makeRow('case-1', 'direct', 'ask', 'block');
    expect(pair(before, after)).toEqual([
      { kind: 'regression', id: 'case-1', detail: 'verdict weakened: block → ask' },
    ]);
  });

  it('malicious ask -> pass is a regression', () => {
    const before = makeRow('case-2', 'direct', 'ask', 'block');
    const after = makeRow('case-2', 'direct', 'pass', 'block');
    expect(pair(before, after)).toEqual([
      { kind: 'regression', id: 'case-2', detail: 'verdict weakened: ask → pass' },
    ]);
  });

  it('malicious block -> pass is a regression', () => {
    const before = makeRow('case-3', 'direct', 'block', 'block');
    const after = makeRow('case-3', 'direct', 'pass', 'block');
    expect(pair(before, after)).toEqual([
      { kind: 'regression', id: 'case-3', detail: 'verdict weakened: block → pass' },
    ]);
  });

  it('malicious ask -> block is an improvement', () => {
    const before = makeRow('case-4', 'direct', 'ask', 'block');
    const after = makeRow('case-4', 'direct', 'block', 'block');
    expect(pair(before, after)).toEqual([
      { kind: 'improvement', id: 'case-4', detail: 'verdict strengthened: ask → block' },
    ]);
  });

  it('malicious pass -> ask is an improvement', () => {
    const before = makeRow('case-5', 'direct', 'pass', 'block');
    const after = makeRow('case-5', 'direct', 'ask', 'block');
    expect(pair(before, after)).toEqual([
      { kind: 'improvement', id: 'case-5', detail: 'verdict strengthened: pass → ask' },
    ]);
  });

  it('malicious pass -> block is an improvement', () => {
    const before = makeRow('case-6', 'direct', 'pass', 'block');
    const after = makeRow('case-6', 'direct', 'block', 'block');
    expect(pair(before, after)).toEqual([
      { kind: 'improvement', id: 'case-6', detail: 'verdict strengthened: pass → block' },
    ]);
  });

  it('benign pass -> ask is a regression (new false-flag)', () => {
    const before = makeRow('case-7', 'benign', 'pass', 'pass');
    const after = makeRow('case-7', 'benign', 'ask', 'pass');
    expect(pair(before, after)).toEqual([
      { kind: 'regression', id: 'case-7', detail: 'verdict weakened: pass → ask' },
    ]);
  });

  it('benign ask -> pass is an improvement', () => {
    const before = makeRow('case-8', 'benign', 'ask', 'pass');
    const after = makeRow('case-8', 'benign', 'pass', 'pass');
    expect(pair(before, after)).toEqual([
      { kind: 'improvement', id: 'case-8', detail: 'verdict strengthened: ask → pass' },
    ]);
  });

  it('benign pass -> block is a regression', () => {
    const before = makeRow('case-9', 'benign', 'pass', 'pass');
    const after = makeRow('case-9', 'benign', 'block', 'pass');
    expect(pair(before, after)).toEqual([
      { kind: 'regression', id: 'case-9', detail: 'verdict weakened: pass → block' },
    ]);
  });

  // The remaining three benign-order pairs (ask->block, block->pass,
  // block->ask), closing out the full BENIGN_ORDER matrix so a future
  // refactor that inverts a direction can't slip past an incomplete suite.
  it('benign ask -> block is a regression', () => {
    const before = makeRow('case-9b', 'benign', 'ask', 'pass');
    const after = makeRow('case-9b', 'benign', 'block', 'pass');
    expect(pair(before, after)).toEqual([
      { kind: 'regression', id: 'case-9b', detail: 'verdict weakened: ask → block' },
    ]);
  });

  it('benign block -> pass is an improvement', () => {
    const before = makeRow('case-9c', 'benign', 'block', 'pass');
    const after = makeRow('case-9c', 'benign', 'pass', 'pass');
    expect(pair(before, after)).toEqual([
      { kind: 'improvement', id: 'case-9c', detail: 'verdict strengthened: block → pass' },
    ]);
  });

  it('benign block -> ask is an improvement', () => {
    const before = makeRow('case-9d', 'benign', 'block', 'pass');
    const after = makeRow('case-9d', 'benign', 'ask', 'pass');
    expect(pair(before, after)).toEqual([
      { kind: 'improvement', id: 'case-9d', detail: 'verdict strengthened: block → ask' },
    ]);
  });

  it('same verdict, expected changed, is a recalibration', () => {
    const before: RedteamRow = {
      id: 'case-10', category: 'direct', verdict: 'block', expected: 'block',
      pass: true, failureKind: null, reason: 'malicious input blocked',
    };
    const after: RedteamRow = { ...before, expected: 'ask' };
    expect(pair(before, after)).toEqual([
      { kind: 'recalibration', id: 'case-10', detail: 'fields changed with verdict unchanged: expected' },
    ]);
  });

  it('same verdict, reason reworded, is a recalibration', () => {
    const before: RedteamRow = {
      id: 'case-11', category: 'direct', verdict: 'block', expected: 'block',
      pass: true, failureKind: null, reason: 'malicious input blocked',
    };
    const after: RedteamRow = { ...before, reason: 'malicious input blocked (reworded)' };
    expect(pair(before, after)).toEqual([
      { kind: 'recalibration', id: 'case-11', detail: 'fields changed with verdict unchanged: reason' },
    ]);
  });

  it('category direct -> jailbreak (same class), same verdict, is a recalibration', () => {
    const before = makeRow('case-12', 'direct', 'block', 'block');
    const after = makeRow('case-12', 'jailbreak', 'block', 'block');
    expect(pair(before, after)).toEqual([
      { kind: 'recalibration', id: 'case-12', detail: 'fields changed with verdict unchanged: category' },
    ]);
  });

  it('category benign -> exfil (cross-class), verdict ask -> block, is a recalibration (NOT improvement)', () => {
    const before = makeRow('case-13', 'benign', 'ask', 'pass');
    const after = makeRow('case-13', 'exfil', 'block', 'block');
    expect(pair(before, after)).toEqual([
      {
        kind: 'recalibration',
        id: 'case-13',
        detail: 'category crossed the benign/malicious boundary (benign → exfil) — direction is a human judgment (ADR-0018 d8)',
      },
    ]);
  });

  it('category direct -> benign (cross-class, the reverse direction), is a recalibration (NOT regression)', () => {
    const before = makeRow('case-13b', 'direct', 'block', 'block');
    const after = makeRow('case-13b', 'benign', 'pass', 'pass');
    expect(pair(before, after)).toEqual([
      {
        kind: 'recalibration',
        id: 'case-13b',
        detail: 'category crossed the benign/malicious boundary (direct → benign) — direction is a human judgment (ADR-0018 d8)',
      },
    ]);
  });

  it('removed id is a regression with a rename hint', () => {
    const baseline = makeScorecard([makeRow('case-14', 'direct', 'block', 'block')]);
    const freshSc = makeScorecard([]);
    const findings = classifyDrift(baseline, freshSc);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding).toBeDefined();
    expect(finding?.kind).toBe('regression');
    expect(finding?.id).toBe('case-14');
    expect(finding?.detail).toMatch(/removed, or renamed/);
  });

  it('added id (a missed row) is a new-case', () => {
    const baseline = makeScorecard([]);
    const freshSc = makeScorecard([makeRow('case-15', 'direct', 'pass', 'block')]);
    expect(classifyDrift(baseline, freshSc)).toEqual([
      { kind: 'new-case', id: 'case-15', detail: 'new case (missed)' },
    ]);
  });

  it('added id (a passing row) is a new-case labelled "passing"', () => {
    const baseline = makeScorecard([]);
    const freshSc = makeScorecard([makeRow('case-15b', 'direct', 'block', 'block')]);
    expect(classifyDrift(baseline, freshSc)).toEqual([
      { kind: 'new-case', id: 'case-15b', detail: 'new case (passing)' },
    ]);
  });

  // Rows are rebuilt as fresh (value-equal, not reference-equal) objects on
  // each side: diffRows compares fields by `!==`, so a shared object
  // reference would make `before[k] !== after[k]` trivially false for every
  // field regardless of whether the comparison logic is correct, masking a
  // mutation or equality bug. Cloning proves the no-op path holds by value.
  it('armLabel changed with identical rows is a single envelope finding', () => {
    const row = makeRow('case-16', 'direct', 'block', 'block');
    const baseline = makeScorecard([{ ...row }], { armLabel: 'security-on' });
    const freshSc = makeScorecard([{ ...row }], { armLabel: 'security-off' });
    expect(classifyDrift(baseline, freshSc)).toEqual([
      { kind: 'envelope', id: null, detail: expect.any(String) },
    ]);
  });

  it('identical scorecards produce no findings', () => {
    const rows = [makeRow('case-17', 'direct', 'block', 'block'), makeRow('case-18', 'benign', 'pass', 'pass')];
    const baseline = makeScorecard(rows.map((r) => ({ ...r })));
    const freshSc = makeScorecard(rows.map((r) => ({ ...r })));
    expect(classifyDrift(baseline, freshSc)).toEqual([]);
  });
});

describe('totalsMismatchDetail', () => {
  it('returns null for a consistent scorecard', () => {
    const rows = [makeRow('t-1', 'direct', 'block', 'block'), makeRow('t-2', 'benign', 'pass', 'pass')];
    expect(totalsMismatchDetail(makeScorecard(rows))).toBeNull();
  });

  it('flags totals.detected off by one', () => {
    const rows = [makeRow('t-3', 'direct', 'block', 'block'), makeRow('t-4', 'benign', 'pass', 'pass')];
    const scorecard = makeScorecard(rows);
    const mutated: BaselineScorecard = { ...scorecard, totals: { ...scorecard.totals, detected: scorecard.totals.detected + 1 } };
    expect(totalsMismatchDetail(mutated)).toMatch(/detected/);
  });

  it('flags meta.corpusSize diverging from rows.length (design SK11)', () => {
    const rows = [makeRow('t-5', 'direct', 'block', 'block')];
    const scorecard = makeScorecard(rows);
    const mutated: BaselineScorecard = { ...scorecard, meta: { ...scorecard.meta, corpusSize: scorecard.meta.corpusSize + 1 } };
    expect(totalsMismatchDetail(mutated)).toMatch(/corpusSize/);
  });

  it('flags a byFailureKind entry that disagrees with the rows', () => {
    const rows = [makeRow('t-6', 'direct', 'pass', 'block'), makeRow('t-7', 'benign', 'block', 'pass')];
    const scorecard = makeScorecard(rows);
    const mutated: BaselineScorecard = {
      ...scorecard,
      totals: { ...scorecard.totals, byFailureKind: { ...scorecard.totals.byFailureKind, missed: scorecard.totals.byFailureKind.missed + 1 } },
    };
    expect(totalsMismatchDetail(mutated)).toMatch(/byFailureKind\.missed/);
  });
});

describe('renderDriftReport', () => {
  it('renders one kind-labelled line per finding and never leaks corpus payload text', () => {
    const corpusCase = CORPUS.find((c) => c.category !== 'benign');
    if (corpusCase === undefined) throw new Error('expected at least one malicious corpus case in CORPUS');
    const before = makeRow(corpusCase.id, corpusCase.category, 'block', corpusCase.expected);
    const after = makeRow(corpusCase.id, corpusCase.category, 'ask', corpusCase.expected);
    const findings = classifyDrift(makeScorecard([before]), makeScorecard([after]));
    expect(findings).toHaveLength(1);
    const report = renderDriftReport(findings);
    expect(report).toContain('REGRESSION');
    expect(report).toContain(corpusCase.id);
    expect(report).not.toContain(corpusCase.text);
    const nonEmptyLines = report.split('\n').filter((line) => line.trim().length > 0);
    expect(nonEmptyLines).toHaveLength(findings.length + 1); // header + one line per finding
  });

  it('renders multiple findings, one line each, still with no payload text', () => {
    const benignCase = CORPUS.find((c) => c.category === 'benign');
    const maliciousCase = CORPUS.find((c) => c.category !== 'benign');
    if (benignCase === undefined || maliciousCase === undefined) {
      throw new Error('expected both a benign and a malicious corpus case in CORPUS');
    }
    const beforeRows = [
      makeRow(benignCase.id, 'benign', 'pass', 'pass'),
      makeRow(maliciousCase.id, maliciousCase.category, 'block', maliciousCase.expected),
    ];
    const afterRows = [
      makeRow(benignCase.id, 'benign', 'ask', 'pass'),
      makeRow(maliciousCase.id, maliciousCase.category, 'pass', maliciousCase.expected),
    ];
    const findings = classifyDrift(makeScorecard(beforeRows), makeScorecard(afterRows));
    expect(findings).toHaveLength(2);
    const report = renderDriftReport(findings);
    expect(report).toContain(`(${findings.length} findings)`);
    expect(report).not.toContain(benignCase.text);
    expect(report).not.toContain(maliciousCase.text);
    const bodyLines = report.trim().split('\n').slice(1);
    expect(bodyLines).toHaveLength(2);
  });

  it('returns empty string when there are no findings', () => {
    expect(renderDriftReport([])).toBe('');
  });
});
