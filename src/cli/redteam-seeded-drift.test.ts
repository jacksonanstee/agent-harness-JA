import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../cli.js';
import { toCanonicalJson } from '../eval/index.js';
import type { BaselineScorecard } from '../eval/index.js';

// Issue #195: the drift classifier and gateOutcome are unit-tested with
// seeded drift, and the CI redteam step only ever sees a clean baseline. These
// cases drive the real `main(['redteam', ...])` path (parse, corpus run,
// scorecard write, baseline load, classify, gate line, exit code) against a
// COPY of the committed baseline in a temp dir, once clean (control) and once
// with a single case's recorded verdict flipped, so a wiring regression
// between the corpus run and the classifier cannot pass green.

// Same repo-relative path baseline-e2e.test.ts reads (vitest runs from the root).
const COMMITTED_BASELINE = 'eval/redteam/baseline.json';

const dirs: string[] = [];
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'redteam-seeded-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Copies the committed baseline into a temp dir, optionally rewriting it. */
function baselineCopy(mutate?: (parsed: BaselineScorecard) => BaselineScorecard): string {
  const copy = join(freshDir(), 'baseline.json');
  const raw = readFileSync(COMMITTED_BASELINE, 'utf8');
  writeFileSync(copy, mutate === undefined ? raw : toCanonicalJson(mutate(JSON.parse(raw) as BaselineScorecard)));
  return copy;
}

interface CommandRun {
  code: number;
  stdout: string;
  scorecard: ScorecardTotals;
}
interface ScorecardTotals {
  rows: unknown[];
  totals: BaselineScorecard['totals'];
}

async function runKeylessRedteam(baselinePath: string): Promise<CommandRun> {
  const out = freshDir();
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const code = await main(['redteam', '--out', out, '--baseline', baselinePath]);
    const stdout = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    const written = /scorecard written to (.+)$/m.exec(stderr)?.[1]?.trim();
    if (written === undefined) throw new Error('the command did not report a written scorecard');
    return { code, stdout, scorecard: JSON.parse(readFileSync(written, 'utf8')) as ScorecardTotals };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

describe('redteam command, end to end against a baseline copy (issue #195)', () => {
  it('control: an unmodified copy of the committed baseline passes (exit 0, GATE_FAILURE=none)', async () => {
    const { code, stdout } = await runKeylessRedteam(baselineCopy());
    expect(code).toBe(0);
    expect(stdout).toContain('GATE_FAILURE=none');
  });

  it('seeded drift: one case flipped in the copy fails with exit 1, GATE_FAILURE=drift and that case id', async () => {
    let flippedId = '';
    const copy = baselineCopy((parsed) => {
      const target = parsed.rows.find((r) => r.category !== 'benign' && r.verdict === 'block');
      if (target === undefined) throw new Error('expected a blocked malicious row in the committed baseline');
      flippedId = target.id;
      return { ...parsed, rows: parsed.rows.map((r) => (r.id === target.id ? { ...r, verdict: 'pass' as const } : r)) };
    });
    const committedBefore = sha256(COMMITTED_BASELINE);

    const { code, stdout } = await runKeylessRedteam(copy);

    expect(flippedId).not.toBe('');
    expect(code).toBe(1);
    expect(stdout).toContain('GATE_FAILURE=drift');
    // The drift report line (renderDriftReport): kind, id, then the detail. The
    // scorecard table in stdout names every id, so only this line binds the id.
    const driftLine = new RegExp(`^ +IMPROVEMENT +${flippedId} \\u2014 verdict strengthened: pass \\u2192 block$`, 'm');
    expect(stdout).toMatch(driftLine);
    expect(sha256(COMMITTED_BASELINE)).toBe(committedBefore);
  });

  it('the keyless run scorecard counts sum to the total (an undercounted run cannot pass)', async () => {
    const { scorecard } = await runKeylessRedteam(baselineCopy());
    const t = scorecard.totals;
    expect(t.total).toBeGreaterThan(0);
    expect(scorecard.rows).toHaveLength(t.total);
    expect(t.passed + t.failed).toBe(t.total);
    expect(t.byFailureKind.missed + t.byFailureKind['false-flag'] + t.byFailureKind['false-block']).toBe(t.failed);
    expect(t.blocked + t.flaggedOnly).toBe(t.detected);
    expect(t.detected).toBeLessThanOrEqual(t.malicious);
  });
});
