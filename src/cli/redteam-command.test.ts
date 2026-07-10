import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CORPUS, normalizeForBaseline, REDTEAM_ARM_LABEL, runRedteam, toCanonicalJson } from '../eval/index.js';
import type { BaselineScorecard, RedteamRow, RedteamTotals } from '../eval/index.js';
import { scan } from '../security/index.js';
import {
  DEFAULT_BASELINE_PATH,
  gateOutcome,
  parseRedteamArgs,
  runRedteamCommand,
} from './redteam-command.js';
import type { RedteamArgs } from './redteam-command.js';
import { EVAL_OUT_DIR } from './shared.js';

const dirs: string[] = [];

const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'redteam-cmd-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Captures stdout/stderr text written during `fn()`, restoring the spies
 *  afterward regardless of how `fn` returns. */
function captureIO(fn: () => number): { code: number; stdout: string; stderr: string } {
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const code = fn();
    const stdout = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    return { code, stdout, stderr };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

const baseArgs = (overrides: Partial<RedteamArgs> = {}): RedteamArgs => ({
  command: 'redteam',
  out: freshDir(),
  updateBaseline: false,
  baselinePath: join(freshDir(), 'baseline.json'),
  ...overrides,
});

/** Canonical bytes a live run of the real corpus normalizes to — the value
 *  every "matches the live run" assertion below compares against. */
const liveCanonical = (): string =>
  toCanonicalJson(normalizeForBaseline(runRedteam(CORPUS, scan, { armLabel: REDTEAM_ARM_LABEL, harnessVersion: '9.9.9' })));

/** Mirrors runner.ts's totals derivation, independently, for fixture
 *  mutation — mirrors the equivalent helper in baseline.test.ts. */
function recomputeTotals(rows: RedteamRow[]): RedteamTotals {
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

describe('parseRedteamArgs', () => {
  it('defaults to out=EVAL_OUT_DIR, updateBaseline=false, baselinePath=DEFAULT_BASELINE_PATH', () => {
    expect(parseRedteamArgs([])).toEqual({
      ok: true,
      value: { command: 'redteam', out: EVAL_OUT_DIR, updateBaseline: false, baselinePath: DEFAULT_BASELINE_PATH },
    });
  });

  it('--update-baseline sets the flag', () => {
    const result = parseRedteamArgs(['--update-baseline']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.updateBaseline).toBe(true);
  });

  it('--baseline <path> overrides baselinePath', () => {
    const result = parseRedteamArgs(['--baseline', '/tmp/custom-baseline.json']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.baselinePath).toBe('/tmp/custom-baseline.json');
  });

  it('rejects an unknown flag', () => {
    expect(parseRedteamArgs(['--bogus']).ok).toBe(false);
  });

  it('rejects --baseline with no value', () => {
    const result = parseRedteamArgs(['--baseline']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('--baseline');
  });
});

describe('gateOutcome', () => {
  it('internalDetail outranks everything: exit 2, GATE_FAILURE=internal', () => {
    expect(
      gateOutcome({ falseBlockCount: 5, internalDetail: 'totals.detected claims 1, rows derive 2', driftFindings: [], nonCanonical: true }),
    ).toEqual({ exitCode: 2, gateLine: 'GATE_FAILURE=internal' });
  });

  it('false-block alone (no drift): exit 1, GATE_FAILURE=false-block', () => {
    expect(gateOutcome({ falseBlockCount: 1, internalDetail: null, driftFindings: [], nonCanonical: false })).toEqual({
      exitCode: 1,
      gateLine: 'GATE_FAILURE=false-block',
    });
  });

  it('false-block + drift: exit 1, GATE_FAILURE=false-block+drift', () => {
    expect(
      gateOutcome({
        falseBlockCount: 1,
        internalDetail: null,
        driftFindings: [{ kind: 'regression', id: 'case-1', detail: 'x' }],
        nonCanonical: false,
      }),
    ).toEqual({ exitCode: 1, gateLine: 'GATE_FAILURE=false-block+drift' });
  });

  it('drift alone: exit 1, GATE_FAILURE=drift', () => {
    expect(
      gateOutcome({ falseBlockCount: 0, internalDetail: null, driftFindings: [{ kind: 'regression', id: 'case-1', detail: 'x' }], nonCanonical: false }),
    ).toEqual({ exitCode: 1, gateLine: 'GATE_FAILURE=drift' });
  });

  it('non-canonical alone: exit 1, GATE_FAILURE=drift', () => {
    expect(gateOutcome({ falseBlockCount: 0, internalDetail: null, driftFindings: [], nonCanonical: true })).toEqual({
      exitCode: 1,
      gateLine: 'GATE_FAILURE=drift',
    });
  });

  it('nothing wrong: exit 0, GATE_FAILURE=none', () => {
    expect(gateOutcome({ falseBlockCount: 0, internalDetail: null, driftFindings: [], nonCanonical: false })).toEqual({
      exitCode: 0,
      gateLine: 'GATE_FAILURE=none',
    });
  });
});

describe('runRedteamCommand: compare mode', () => {
  it('missing baseline: exit 2, stderr has the pinned missing-baseline message, stdout has NO GATE_FAILURE line', () => {
    const baselinePath = join(freshDir(), 'missing-baseline.json');
    const { code, stdout, stderr } = captureIO(() => runRedteamCommand(baseArgs({ baselinePath })));
    expect(code).toBe(2);
    expect(stderr).toMatch(/no baseline found at/);
    expect(stderr).toContain('--update-baseline');
    expect(stderr).toContain('--baseline <path>');
    expect(stdout).not.toContain('GATE_FAILURE=');
  });

  it('byte-equal baseline: exit 0, GATE_FAILURE=none', () => {
    const baselinePath = join(freshDir(), 'baseline.json');
    writeFileSync(baselinePath, liveCanonical());
    const { code, stdout } = captureIO(() => runRedteamCommand(baseArgs({ baselinePath })));
    expect(code).toBe(0);
    expect(stdout).toContain('GATE_FAILURE=none');
  });

  it('drift (baseline pinned to "block" on a row the live scanner only flags as "ask"): exit 1, GATE_FAILURE=drift, REGRESSION, the row id, and the pinned remedy line', () => {
    // The regression direction is baseline(before) -> fresh(after) (classifyPair
    // convention, pinned by baseline.test.ts's flagship fixture). Fresh is the
    // real, unmutable live scan result, so to produce a genuine "weakened"
    // regression (rather than an improvement) the baseline row must be pinned
    // STRONGER than what the live scanner currently produces for that same
    // case: pick a row the live corpus scores 'ask' and write the baseline's
    // copy of it as 'block' — a committed pin the current code has drifted
    // below.
    const parsed = JSON.parse(liveCanonical()) as BaselineScorecard;
    const target = parsed.rows.find((r) => r.category !== 'benign' && r.verdict === 'ask');
    if (target === undefined) throw new Error('expected at least one "ask"-verdict malicious row in the live corpus');
    const pinnedRow: RedteamRow = { ...target, verdict: 'block', pass: true, failureKind: null, reason: 'malicious input blocked' };
    const mutatedRows = parsed.rows.map((r) => (r.id === target.id ? pinnedRow : r));
    const mutatedTotals: RedteamTotals = {
      ...parsed.totals,
      blocked: parsed.totals.blocked + 1,
      flaggedOnly: parsed.totals.flaggedOnly - 1,
    };
    const mutated: BaselineScorecard = { ...parsed, rows: mutatedRows, totals: mutatedTotals };

    const baselinePath = join(freshDir(), 'baseline.json');
    writeFileSync(baselinePath, toCanonicalJson(mutated));

    const { code, stdout } = captureIO(() => runRedteamCommand(baseArgs({ baselinePath })));
    expect(code).toBe(1);
    expect(stdout).toContain('GATE_FAILURE=drift');
    expect(stdout).toContain('REGRESSION');
    expect(stdout).toContain(target.id);
    expect(stdout).toContain(
      'Baseline drift detected. Run `npm run redteam -- --update-baseline`, review the diff, ' +
        'and commit eval/redteam/baseline.json. (The gate fails on improvements too — see docs/decisions/0019.)',
    );
  });

  it('new-case-only drift (baseline missing one row): exit 1, the pinned "This failure is expected" line with N=1', () => {
    const parsed = JSON.parse(liveCanonical()) as BaselineScorecard;
    const remainingRows = parsed.rows.slice(1);
    const shrunk: BaselineScorecard = {
      ...parsed,
      meta: { ...parsed.meta, corpusSize: remainingRows.length },
      rows: remainingRows,
      totals: recomputeTotals(remainingRows),
    };

    const baselinePath = join(freshDir(), 'baseline.json');
    writeFileSync(baselinePath, toCanonicalJson(shrunk));

    const { code, stdout } = captureIO(() => runRedteamCommand(baseArgs({ baselinePath })));
    expect(code).toBe(1);
    expect(stdout).toContain('GATE_FAILURE=drift');
    expect(stdout).toContain(
      'This failure is expected: you added 1 case(s) not yet in the baseline. ' +
        'No existing behaviour changed — update the baseline to record them.',
    );
  });

  it('non-canonical baseline (semantically identical, reordered/unindented keys): exit 1, pinned non-canonical message, GATE_FAILURE=drift', () => {
    const canonical = liveCanonical();
    const nonCanonicalBytes = JSON.stringify(JSON.parse(canonical));
    expect(nonCanonicalBytes).not.toBe(canonical); // sanity: genuinely byte-different

    const baselinePath = join(freshDir(), 'baseline.json');
    writeFileSync(baselinePath, nonCanonicalBytes);

    const { code, stdout } = captureIO(() => runRedteamCommand(baseArgs({ baselinePath })));
    expect(code).toBe(1);
    expect(stdout).toContain('baseline file is not canonical — regenerate with --update-baseline');
    expect(stdout).toContain('GATE_FAILURE=drift');
  });

  it('symlinked baseline path: exit 2', () => {
    const dir = freshDir();
    const realPath = join(dir, 'real-baseline.json');
    writeFileSync(realPath, liveCanonical());
    const linkPath = join(dir, 'linked-baseline.json');
    symlinkSync(realPath, linkPath);

    const { code, stdout, stderr } = captureIO(() => runRedteamCommand(baseArgs({ baselinePath: linkPath })));
    expect(code).toBe(2);
    expect(stderr).toMatch(/symlink/);
    expect(stdout).not.toContain('GATE_FAILURE=');
  });
});

describe('runRedteamCommand: --update-baseline mode', () => {
  it('writes a canonical baseline matching a live run when the parent dir exists; exit 0, no GATE_FAILURE line', () => {
    const root = freshDir();
    const parent = join(root, 'eval', 'redteam');
    mkdirSync(parent, { recursive: true });
    const baselinePath = join(parent, 'baseline.json');

    const { code, stdout } = captureIO(() =>
      runRedteamCommand(baseArgs({ baselinePath, updateBaseline: true })),
    );
    expect(code).toBe(0);
    expect(stdout).not.toContain('GATE_FAILURE=');
    expect(readFileSync(baselinePath, 'utf8')).toBe(liveCanonical());

    // Re-running compare mode against the freshly-written baseline passes.
    const compared = captureIO(() => runRedteamCommand(baseArgs({ baselinePath })));
    expect(compared.code).toBe(0);
    expect(compared.stdout).toContain('GATE_FAILURE=none');
  });

  it('missing parent dir: exit 2, no file written', () => {
    const root = freshDir();
    const baselinePath = join(root, 'nope', 'baseline.json');

    const { code } = captureIO(() => runRedteamCommand(baseArgs({ baselinePath, updateBaseline: true })));
    expect(code).toBe(2);
    expect(() => readFileSync(baselinePath, 'utf8')).toThrow();
  });
});
