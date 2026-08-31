import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Tests for `scripts/check-corpus-numbers.mjs` (issue #89).
 *
 * The gate re-derives the red-team corpus figures from the ROWS of
 * `eval/redteam/baseline.json` and checks every recognised claim in the live
 * docs (README, docs/*.md, docs/blog/*.md) against them. Same exit contract as
 * the two sibling gates: 0 clean, 1 findings, 2 did not complete. Every
 * failing case asserts the message and not just the code, for the reason
 * docs-gate.test.ts records: exit 1 must never be reachable by a crash.
 */

const SCRIPT = join(process.cwd(), 'scripts', 'check-corpus-numbers.mjs');

type Run = { status: number; stderr: string; stdout: string };

function runGate(root: string, env: Record<string, string> = {}): Run {
  try {
    const stdout = execFileSync('node', [SCRIPT, root], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status: number; stderr: string; stdout: string };
    return { status: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** A finding is exit 1 AND the expected text. Exit 2 (crash) fails here. */
function expectFinding(root: string, ...expected: string[]): Run {
  const run = runGate(root);
  expect(run.status, `expected a finding (exit 1), got ${run.status}: ${run.stderr}`).toBe(1);
  for (const text of expected) expect(run.stderr).toContain(text);
  return run;
}

/** Did-not-complete is exit 2 AND the expected text. */
function expectIncomplete(root: string, ...expected: string[]): Run {
  const run = runGate(root);
  expect(run.status, `expected did-not-complete (exit 2), got ${run.status}: ${run.stderr}`).toBe(2);
  for (const text of expected) expect(run.stderr).toContain(text);
  return run;
}

function expectClean(root: string): Run {
  const run = runGate(root);
  expect(run.status, `expected clean (exit 0): ${run.stderr}`).toBe(0);
  return run;
}

const roots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'corpus-gate-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BASELINE_PATH = 'eval/redteam/baseline.json';

type Counts = { size: number; malicious: number; detected: number };

/**
 * A synthetic baseline whose totals are derived from the rows it carries, so
 * the gate's own re-derivation agrees with them unless a test overrides
 * `totals` on purpose. Defaults mirror the shipped corpus at e9db280
 * (53 / 41 / 37, so 4 missed, 12 benign, 90.2%), which is what makes the
 * regression group below exact rather than illustrative.
 */
function baseline(
  { size, malicious, detected }: Counts = { size: 53, malicious: 41, detected: 37 },
  override: Record<string, unknown> = {},
): string {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < size - malicious; i += 1) {
    rows.push({ id: `benign-${i}`, category: 'benign', expected: 'pass', verdict: 'pass', failureKind: null });
  }
  for (let i = 0; i < malicious; i += 1) {
    const hit = i < detected;
    rows.push({
      id: `direct-${i}`,
      category: 'direct',
      expected: 'block',
      verdict: hit ? (i % 2 === 0 ? 'block' : 'ask') : 'pass',
      failureKind: hit ? null : 'missed',
    });
  }
  const blocked = rows.filter((r) => r.verdict === 'block').length;
  const doc = {
    schemaVersion: 1,
    producer: 'redteam',
    meta: { armLabel: 'security-on', corpusSize: size },
    rows,
    totals: {
      total: size,
      malicious,
      detected,
      blocked,
      flaggedOnly: detected - blocked,
      falseBlockCount: 0,
      passed: size - (malicious - detected),
      failed: malicious - detected,
      byFailureKind: { 'false-block': 0, 'false-flag': 0, missed: malicious - detected },
    },
    ...override,
  };
  return JSON.stringify(doc, null, 2);
}

/** README carrying the one live claim the real README carries: a lower bound. */
const GOOD_README = '# R\n\n| **Evaluation** | red-team corpus (≥50 cases) |\n';

function tree(docs: Record<string, string>, base = baseline()): Record<string, string> {
  return { [BASELINE_PATH]: base, 'README.md': GOOD_README, ...docs };
}

describe('check-corpus-numbers.mjs: exit-code contract', () => {
  it('exits 2 when the root does not exist', () => {
    expectIncomplete(join(tmpdir(), 'corpus-gate-does-not-exist'), 'cannot enter');
  });

  it('exits 2 when the gate CRASHES mid-run, which is what binds the catch-all', () => {
    const root = fixture(tree({}));
    const run = runGate(root, { CHECK_CORPUS_SELFTEST_CRASH: '1' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('did not complete');
  });

  it('exits 2 when the baseline is missing', () => {
    const root = fixture({ 'README.md': GOOD_README });
    expectIncomplete(root, 'no eval/redteam/baseline.json');
  });

  it('exits 2 when the baseline is not JSON', () => {
    const root = fixture(tree({}, '{ not json'));
    expectIncomplete(root, 'could not derive corpus figures');
  });

  it('exits 2 when the baseline has the wrong shape', () => {
    const root = fixture(tree({}, JSON.stringify({ rows: 'nope', totals: {}, meta: {} })));
    expectIncomplete(root, 'could not derive corpus figures');
  });

  it('exits 2 when the baseline is a symlink, mirroring the redteam gate envelope', () => {
    const root = fixture({ 'README.md': GOOD_README, 'elsewhere.json': baseline() });
    mkdirSync(join(root, 'eval', 'redteam'), { recursive: true });
    symlinkSync(join(root, 'elsewhere.json'), join(root, BASELINE_PATH));
    expectIncomplete(root, 'symlink');
  });

  it('exits 2 when the baseline exceeds the byte cap', () => {
    const padded = baseline().replace('"schemaVersion"', `"pad": "${'x'.repeat(1_000_001)}", "schemaVersion"`);
    const root = fixture(tree({}, padded));
    expectIncomplete(root, 'over the');
  });

  it('exits 2, not a finding, when the totals disagree with the rows', () => {
    // The baseline is then inconsistent with itself, which the redteam gate's
    // totalsMismatchDetail owns. Reporting a doc finding here would blame prose
    // for a data defect, the same misdirection check-test-count.sh refuses on
    // a red suite.
    const bad = baseline(undefined, {
      totals: { total: 53, malicious: 41, detected: 36, byFailureKind: { missed: 5 } },
    });
    const root = fixture(tree({ 'docs/a.md': 'the 53-case corpus, 37 detected\n' }, bad));
    expectIncomplete(root, 'internally inconsistent');
  });

  it('exits 2 on a skip marker that is never resumed', () => {
    const root = fixture(tree({ 'docs/a.md': '<!-- corpus-gate: skip -->\nold 51-case corpus\n' }));
    expectIncomplete(root, 'docs/a.md', 'never resumed');
  });

  it('exits 2 on a resume marker with no skip', () => {
    const root = fixture(tree({ 'docs/a.md': 'text\n<!-- corpus-gate: resume -->\n' }));
    expectIncomplete(root, 'docs/a.md', 'without a skip');
  });

  it('exits 2 on a nested skip', () => {
    const root = fixture(
      tree({
        'docs/a.md':
          '<!-- corpus-gate: skip -->\n<!-- corpus-gate: skip -->\n<!-- corpus-gate: resume -->\n<!-- corpus-gate: resume -->\n',
      }),
    );
    expectIncomplete(root, 'docs/a.md', 'nested');
  });
});

describe('check-corpus-numbers.mjs: clean trees', () => {
  it('accepts every claim shape at once when each matches, and reports how many it checked', () => {
    const root = fixture(
      tree({
        'docs/a.md':
          'the 53-case corpus is public; 53 cases; 37/41 malicious; 41 malicious; 37 detected; 12 benign;\n' +
          'the four current known-misses; 4 missed; detection rate 90.2%; ~90% detection; 90.24% detected\n',
        'docs/blog/b.md': 'red-team corpus (≥50 cases), at least 40 cases, >=53 cases\n',
      }),
    );
    const run = expectClean(root);
    expect(run.stdout).toContain('OK');
    expect(run.stdout).toContain('53 cases, 41 malicious, 37 detected, 4 missed, 90.2%');
    // 11 on docs/a.md, 3 on docs/blog/b.md, 1 in README.
    expect(run.stdout).toMatch(/15 claims? checked/);
  });

  it('accepts the hyphenated lower bound architecture.md carries ("≥50-case")', () => {
    const root = fixture(tree({ 'docs/architecture.md': '- **Owns:** the ≥50-case adversarial corpus\n' }));
    expectClean(root);
  });

  it('ignores a claim inside a fenced block', () => {
    const root = fixture(tree({ 'docs/a.md': '```\nthe 51-case corpus\n```\n' }));
    expectClean(root);
  });

  it('ignores a claim inside a skip/resume region', () => {
    const root = fixture(
      tree({
        'docs/a.md':
          'live: 53 cases\n<!-- corpus-gate: skip -->\nWeek 3: the 51-case corpus, 92.5% detection\n<!-- corpus-gate: resume -->\n',
      }),
    );
    expectClean(root);
  });

  it('treats a marker inside a fence as content, not as a marker', () => {
    // A skip marker that is only ever seen inside a fence must not open a
    // region; otherwise fenced example text could silence the rest of a file.
    const root = fixture(tree({ 'docs/a.md': '```\n<!-- corpus-gate: skip -->\n```\nstale 51-case corpus\n' }));
    expectFinding(root, 'docs/a.md:4', '51-case');
  });

  it('ignores docs/decisions/ and process/, which are dated records', () => {
    const root = fixture(
      tree({
        'docs/decisions/0018-x.md': 'the 51-case corpus, 37/40 malicious, 92.5% detection\n',
        'process/devlog/week-3.md': 'the 51-case corpus landed\n',
        'process/reviews/x.md': '~92% detection\n',
      }),
    );
    expectClean(root);
  });

  it('ignores a bare integer percentage, which the blog uses for hypotheticals', () => {
    const root = fixture(
      tree({
        'docs/blog/b.md': 'if a bump lifts detection from 92% to 94%, a gate at detection ≥ 90% waves it through\n',
      }),
    );
    expectClean(root);
  });

  it('does not see a spelled-out count whose noun wraps to the next line (stated limit: keep it on one line)', () => {
    const root = fixture(tree({ 'docs/blog/b.md': 'Three cases are *known\nmisses*, and 53 cases in all\n' }));
    expectClean(root);
  });

  it('reads a CRLF file no differently', () => {
    const root = fixture(tree({ 'docs/a.md': 'the 53-case corpus\r\n37 detected\r\n' }));
    expectClean(root);
  });
});

describe('check-corpus-numbers.mjs: findings', () => {
  it('REJECTS a stale N-case size', () => {
    const root = fixture(tree({ 'docs/a.md': 'the 51-case corpus\n' }));
    expectFinding(root, 'docs/a.md:1', '51-case', '53');
  });

  it('REJECTS a stale "N cases" size', () => {
    const root = fixture(tree({ 'docs/a.md': 'corpus of 51 cases\n' }));
    expectFinding(root, 'docs/a.md:1', '51 cases', '53');
  });

  it('REJECTS a lower bound the corpus does not satisfy', () => {
    const root = fixture(tree({ 'docs/a.md': 'red-team corpus (≥60 cases)\n' }));
    expectFinding(root, 'docs/a.md:1', '60 cases', '53');
  });

  it('accepts a lower bound the corpus meets exactly', () => {
    const root = fixture(tree({ 'docs/a.md': 'at least 53 cases\n' }));
    expectClean(root);
  });

  it('REJECTS a hyphenated lower bound the corpus does not satisfy', () => {
    const root = fixture(tree({ 'docs/architecture.md': 'the ≥60-case corpus\n' }));
    expectFinding(root, 'docs/architecture.md:1', '60 cases', '53');
  });

  it('REJECTS a stale D/M malicious fraction on either side', () => {
    const numerator = fixture(tree({ 'docs/a.md': '36/41 malicious\n' }));
    expectFinding(numerator, 'docs/a.md:1', '36/41 malicious', '37/41');
    const denominator = fixture(tree({ 'docs/a.md': '37/40 malicious\n' }));
    expectFinding(denominator, 'docs/a.md:1', '37/40 malicious', '37/41');
  });

  it('REJECTS a stale bare malicious count', () => {
    const root = fixture(tree({ 'docs/a.md': '40 malicious cases\n' }));
    expectFinding(root, 'docs/a.md:1', '40 malicious', '41');
  });

  it('REJECTS a stale detected count', () => {
    const root = fixture(tree({ 'docs/a.md': '36 detected\n' }));
    expectFinding(root, 'docs/a.md:1', '36 detected', '37');
  });

  it('REJECTS a stale benign count', () => {
    const root = fixture(tree({ 'docs/a.md': '11 benign\n' }));
    expectFinding(root, 'docs/a.md:1', '11 benign', '12');
  });

  it('REJECTS a stale numeric missed count', () => {
    const root = fixture(tree({ 'docs/a.md': '3 missed\n' }));
    expectFinding(root, 'docs/a.md:1', '3 missed', '4');
  });

  it('REJECTS a stale spelled-out known-misses count', () => {
    const root = fixture(tree({ 'docs/a.md': 'the three current known-misses all carry block\n' }));
    expectFinding(root, 'docs/a.md:1', 'three current known-misses', '4');
  });

  it('REJECTS a stale one-decimal rate on a detection line', () => {
    const root = fixture(tree({ 'docs/a.md': 'detection rate 92.5%\n' }));
    expectFinding(root, 'docs/a.md:1', '92.5%', '90.2%');
  });

  it('REJECTS a stale two-decimal rate on a detection line', () => {
    const root = fixture(tree({ 'docs/a.md': 'detection rate 92.50%\n' }));
    expectFinding(root, 'docs/a.md:1', '92.50%', '90.24%');
  });

  it('REJECTS a stale approximate rate on a detection line', () => {
    const root = fixture(tree({ 'docs/a.md': 'detection is ~92%\n' }));
    expectFinding(root, 'docs/a.md:1', '~92%', '~90%');
  });

  it('reports every finding, not just the first', () => {
    const root = fixture(
      tree({ 'docs/a.md': 'the 51-case corpus\n\n37/40 malicious\n', 'docs/blog/b.md': '~92% detection\n' }),
    );
    const run = expectFinding(root, 'docs/a.md:1', 'docs/a.md:3', 'docs/blog/b.md:1');
    expect(run.stderr).toContain('FAILED (3 problem(s))');
  });

  it('REPORTS when no live doc carries a recognisable claim, rather than passing over nothing', () => {
    const root = fixture({ [BASELINE_PATH]: baseline(), 'README.md': '# R\n\nno numbers here\n' });
    expectFinding(root, 'no corpus claim recognised');
  });

  it('prefixes every finding so a hostile filename cannot start a CI log line', () => {
    const root = fixture(tree({ 'docs/::error title=X::y.md': 'the 51-case corpus\n' }));
    const run = expectFinding(root, '51-case');
    for (const line of run.stderr.split('\n').filter((l) => l.length > 0)) {
      expect(line.startsWith('check-corpus:'), `unprefixed line: ${line}`).toBe(true);
    }
  });

  it('strips control and bidi characters from a filename before it reaches the log', () => {
    // Built from code points so the source file itself carries no control bytes.
    const rlo = String.fromCharCode(0x202e);
    const bell = String.fromCharCode(0x07);
    const root = fixture(tree({ [`docs/a${rlo}b${bell}c.md`]: 'the 51-case corpus\n' }));
    const run = expectFinding(root, '51-case', 'abc.md');
    expect(run.stderr).not.toContain(rlo);
    expect(run.stderr).not.toContain(bell);
  });
});

describe('check-corpus-numbers.mjs: regression, the shapes that shipped stale', () => {
  it('fires on eval-methodology\'s "51-case corpus"', () => {
    const root = fixture(
      tree({ 'docs/eval-methodology.md': 'Deterministic and keyless: the 51-case corpus is scanned\n' }),
    );
    expectFinding(root, 'docs/eval-methodology.md:1', '51-case');
  });

  it('fires on eval-methodology\'s "37/40 malicious, 92.5%" because "detection" shares the line', () => {
    const root = fixture(
      tree({
        'docs/eval-methodology.md':
          '- **Reported measurements:** detection rate (37/40 malicious, 92.5% at\n  E-2 calibration)\n',
      }),
    );
    const run = expectFinding(root, '37/40 malicious', '92.5%');
    expect(run.stderr).toContain('FAILED (2 problem(s))');
  });

  it('fires on the blog\'s "51-case red-team corpus is ~92%"', () => {
    const root = fixture(
      tree({
        'docs/blog/adversarial-evaluation.md':
          "The scanner's detection rate across the 51-case red-team corpus is ~92%.\n",
      }),
    );
    const run = expectFinding(root, '51-case', '~92%');
    expect(run.stderr).toContain('FAILED (2 problem(s))');
  });

  it('fires on eval-methodology\'s "the three current known-misses"', () => {
    const root = fixture(
      tree({
        'docs/eval-methodology.md':
          '   record the verdict it *should* produce (the three current known-misses\n',
      }),
    );
    expectFinding(root, 'three current known-misses', '4');
  });

  it('fires on the security-model ADR-index row "51-case red-team corpus"', () => {
    const root = fixture(
      tree({
        'docs/security-model.md':
          '| ADR | Decision |\n|---|---|\n| [0018](./decisions/0018-redteam-corpus.md) | 51-case red-team corpus; gate-vs-measurement split |\n',
      }),
    );
    expectFinding(root, 'docs/security-model.md:3', '51-case');
  });
});
