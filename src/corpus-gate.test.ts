import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GuardedReadError, readFileGuarded } from './internal/guarded-read.js';

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

  it('exits 2 when the baseline is missing, without echoing the runner path', () => {
    const root = fixture({ 'README.md': GOOD_README });
    const run = expectIncomplete(root, 'no eval/redteam/baseline.json');
    expect(run.stderr).not.toContain(root);
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

  it('exits 2 when docs/ exists but is not a directory, rather than silently dropping scope (finding 7)', () => {
    // The first cut wrapped readdirSync in `catch { continue }`, so a docs
    // path that is a plain file dropped docs/*.md and docs/blog/*.md from the
    // scan and still exited 0 off the README alone.
    const root = fixture({ [BASELINE_PATH]: baseline(), 'README.md': GOOD_README, docs: 'not a directory\n' });
    expectIncomplete(root, 'docs', 'not a directory');
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

  it('does not read a corpus-shaped substring inside a URL or a link target (finding 5)', () => {
    const root = fixture(
      tree({
        'docs/a.md':
          'the corpus: see https://example.com/blog/51-case-study\nand [the corpus](https://example.com/x/51-case)\n',
      }),
    );
    expectClean(root);
  });

  it('DOES read visible link text, which is prose a reader believes', () => {
    const root = fixture(tree({ 'docs/a.md': '[the 51-case corpus](https://example.com/x)\n' }));
    expectFinding(root, 'docs/a.md:1', '51-case', '53');
  });

  it('does not read "N cases" on a line that is not about the corpus (stated limit, finding 6)', () => {
    // Ordinary prose says "in 3 cases the model refused". The size recogniser
    // requires the word "corpus" on the line, the way the rate recogniser
    // requires "detect". Paired with a real claim so this cannot pass by
    // recognising nothing at all.
    const root = fixture(
      tree({ 'docs/a.md': 'in 3 cases the model refused outright\nthe 53-case corpus is public\n' }),
    );
    const run = expectClean(root);
    expect(run.stdout).toMatch(/2 claims checked/);
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
    const root = fixture(tree({ 'docs/a.md': 'the corpus carries at least 53 cases\n' }));
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

  it('numbers lines correctly in a lone-CR file (finding 8)', () => {
    const root = fixture(tree({ 'docs/a.md': 'a heading\rthe 51-case corpus\r' }));
    expectFinding(root, 'docs/a.md:2', '51-case');
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

  it('rounds the rate half-up from the exact ratio, not through a float (finding 1)', () => {
    // 23/80 is exactly 28.75%. `(23 / 80 * 100).toFixed(1)` is "28.7" because
    // the product lands at 28.749999999999996, so a doc stating the correct
    // 28.8% would be reported stale and the WRONG 28.7% would pass.
    const base = baseline({ size: 100, malicious: 80, detected: 23 });
    const right = fixture(tree({ 'docs/a.md': 'detection rate 28.8%\n' }, base));
    expectClean(right);
    const wrong = fixture(tree({ 'docs/a.md': 'detection rate 28.7%\n' }, base));
    expectFinding(wrong, 'docs/a.md:1', '28.7%', '28.8%');
  });

  it('reads a spaced fraction, which otherwise degrades to checking only the denominator (finding 2)', () => {
    const root = fixture(tree({ 'docs/a.md': '30 / 41 malicious\n' }));
    expectFinding(root, 'docs/a.md:1', '30/41 malicious', '37/41 malicious');
  });

  it('reads a rate with a space before the percent sign (finding 3)', () => {
    const root = fixture(tree({ 'docs/a.md': 'detection rate is 99.9 % today\n' }));
    expectFinding(root, 'docs/a.md:1', '99.9%', '90.2%');
  });

  it('reads a comma-grouped number whole, not from the last group (finding 4)', () => {
    const root = fixture(tree({ 'docs/a.md': 'the corpus ran 1,000 cases\n' }));
    // The pre-fix message was "claims 000 cases": `\b` fires straight after the
    // comma. Pinned as the exact prefix, because "1000 cases but" CONTAINS
    // "000 cases but" and the obvious negative assertion passes either way.
    const run = expectFinding(root, 'docs/a.md:1', 'claims 1000 cases', '53');
    expect(run.stderr).not.toContain('claims 000 cases');
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

describe('check-corpus-numbers.mjs: security lens fold (2026-09-01)', () => {
  // The security lens ran the shipped gate against hostile trees and refuted
  // two claims: the baseline read did NOT carry the redteam gate's envelope
  // (a committed `eval/redteam` or `eval` directory symlink was followed where
  // loadBaseline refuses it), and finding text was not sanitised. It also
  // found the docs read path had no envelope at all, two quadratic
  // recognisers on attacker-controlled lines, and Unicode look-alikes that
  // hide a claim a reader sees as plain text. Each test here runs the shipped
  // script on a fixture, the way the rest of this file does.

  it('exits 2 when eval/redteam is a symlinked directory: an ancestor symlink is refused, as the redteam gate refuses it (F1)', () => {
    const root = fixture({ 'README.md': GOOD_README, 'elsewhere/baseline.json': baseline() });
    mkdirSync(join(root, 'eval'));
    symlinkSync(join(root, 'elsewhere'), join(root, 'eval', 'redteam'));
    const run = expectIncomplete(root, 'eval/redteam', 'symlink');
    expect(run.stdout).toBe('');
  });

  it('exits 2 when eval itself is a symlinked directory (F1)', () => {
    const root = fixture({ 'README.md': GOOD_README, 'elsewhere/redteam/baseline.json': baseline() });
    symlinkSync(join(root, 'elsewhere'), join(root, 'eval'));
    expectIncomplete(root, 'eval', 'symlink');
  });

  it('exits 2 when a doc is a symlink, rather than reading digits out of a file outside the tree (F3)', () => {
    const root = fixture(tree({ 'docs/real.md': 'nothing here\n', 'secret.md': 'a 7-case corpus, 3 malicious\n' }));
    symlinkSync(join(root, 'secret.md'), join(root, 'docs', 'leaf.md'));
    const run = expectIncomplete(root, 'docs/leaf.md', 'symlink');
    expect(run.stderr).not.toContain('7-case');
  });

  it('exits 2 when docs/blog is a symlinked directory (F3)', () => {
    const root = fixture(tree({ 'docs/real.md': 'nothing here\n', 'elsewhere/z.md': 'a 8-case corpus\n' }));
    symlinkSync(join(root, 'elsewhere'), join(root, 'docs', 'blog'));
    const run = expectIncomplete(root, 'docs/blog', 'symlink');
    expect(run.stderr).not.toContain('8-case');
  });

  it('exits 2 when README.md is a symlink (F3)', () => {
    const root = fixture({ [BASELINE_PATH]: baseline(), 'elsewhere.md': GOOD_README });
    symlinkSync(join(root, 'elsewhere.md'), join(root, 'README.md'));
    expectIncomplete(root, 'README.md', 'symlink');
  });

  it('exits 2 when a doc is over the byte cap, the way the baseline is (F3)', () => {
    const root = fixture(tree({ 'docs/big.md': `${'x'.repeat(100)}\n`.repeat(10_000) }));
    expectIncomplete(root, 'docs/big.md', 'over the 1000000-byte cap');
  });

  it('exits 2 on a line over the length cap, naming the file and line (F2)', () => {
    const root = fixture(tree({ 'docs/a.md': `ok\n${'a'.repeat(20_001)}\n` }));
    expectIncomplete(root, 'docs/a.md:2', 'over the 20000-char cap');
  });

  it('checks fifty maximal digit runs on detection lines in linear time; the rate recognisers were quadratic (F2)', () => {
    // 19,000 digits sits under the line cap. Before the fix each digit was a
    // start position that scanned to the end of the run looking for a dot:
    // 50k digits took 2.5 s, 200k took 40 s, and no CI job had a timeout.
    const line = `detection ${'1'.repeat(19_000)}\n`;
    const root = fixture(tree({ 'docs/a.md': line.repeat(50) }));
    const started = Date.now();
    expectClean(root);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 60_000);

  it('strips fifty lines of unclosed link openers in linear time (F2)', () => {
    // The shipped stripper scanned to the end of the line from every "](":
    // 2.8 s for these fifty lines at the 20,000-character cap (measured before
    // the fix). Linear is well under a second.
    const line = `${']('.repeat(9_500)}\n`;
    const root = fixture(tree({ 'docs/a.md': line.repeat(50) }));
    const started = Date.now();
    expectClean(root);
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 60_000);

  it('sanitises the finding text, not only the filename, so a control byte inside a matched claim never reaches the log (F4)', () => {
    // `\s+` inside the missed-count recogniser admits VT, FF, TAB and the
    // Unicode line separators, and match[0] is what the finding quotes.
    const vt = String.fromCharCode(0x0b);
    const root = fixture(tree({ 'docs/a.md': `there are 5${vt}known-misses today\n` }));
    const run = expectFinding(root, 'docs/a.md:1', 'claims 5');
    expect(run.stderr).not.toContain(vt);
  });

  it('names the file and the error code, not the runner path, when a doc cannot be read (F5)', () => {
    const root = fixture(tree({ 'docs/x.md': 'unreadable\n' }));
    chmodSync(join(root, 'docs', 'x.md'), 0o000);
    const run = expectIncomplete(root, 'docs/x.md', 'EACCES');
    expect(run.stderr).not.toContain(root);
  });

  it('normalises Unicode spaces, hyphens, invisible characters and fullwidth digits before matching, so a look-alike claim is still a claim (F7)', () => {
    // Each line renders identically to its ASCII form. NBSP is the realistic
    // one: editors insert it in "53 cases" without anyone intending evasion.
    const doc = [
      'the 51 cases corpus', // no-break space
      'a 51‑case corpus', // non-breaking hyphen
      'the cor­pus has 51 cases', // soft hyphen inside the scoping word
      'de​tection rate 92.5%', // zero-width space inside the scoping word
      'the ５１-case corpus', // fullwidth digits
      '37/40 malicious', // figure space
      '',
    ].join('\n');
    const root = fixture(tree({ 'docs/a.md': doc }));
    expectFinding(root, 'docs/a.md:1:', 'docs/a.md:2:', 'docs/a.md:3:', 'docs/a.md:4:', 'docs/a.md:5:', 'docs/a.md:6:');
  });

  it('does not treat a stray "](" as a link target, so a claim after it is still read (F7)', () => {
    const root = fixture(tree({ 'docs/a.md': 'Our corpus ](51-case, 37/40 malicious, 92.5% detection) today.\n' }));
    expectFinding(root, '51-case', '37/40 malicious', '92.5%');
  });
});

describe('check-corpus-numbers.mjs: envelope parity with src/internal/guarded-read.ts (ADR-0034)', () => {
  // The script restates the envelope instead of importing it, because the
  // docs-links job installs nothing, so nothing structural binds the two
  // spellings, and the first restatement was narrower than the original
  // (security lens, 2026-09-01). This group binds them behaviourally: each
  // refusal case that module owns is staged once, RELATIVE to the working
  // directory the way the redteam gate passes its path (guarded-read's
  // ancestor walk is per component only for a relative path), and both the
  // module and the script must refuse it.
  function relativeFixture(files: Record<string, string>): string {
    mkdirSync('.harness', { recursive: true });
    const root = mkdtempSync('.harness/corpus-gate-parity-');
    roots.push(root);
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    return root;
  }

  function bothRefuse(root: string, refusal: string, ...scriptText: string[]): void {
    let caught: unknown;
    try {
      readFileGuarded(join(root, BASELINE_PATH), 1_000_000);
    } catch (error) {
      caught = error;
    }
    expect(caught, 'guarded-read must refuse').toBeInstanceOf(GuardedReadError);
    expect((caught as GuardedReadError).refusal).toBe(refusal);
    expectIncomplete(root, ...scriptText);
  }

  it('both refuse a leaf symlink', () => {
    const root = relativeFixture({ 'README.md': GOOD_README, 'elsewhere.json': baseline() });
    mkdirSync(join(root, 'eval', 'redteam'), { recursive: true });
    symlinkSync(resolve(root, 'elsewhere.json'), join(root, BASELINE_PATH));
    bothRefuse(root, 'symlink', 'symlink');
  });

  it('both refuse an ancestor symlink', () => {
    const root = relativeFixture({ 'README.md': GOOD_README, 'elsewhere/baseline.json': baseline() });
    mkdirSync(join(root, 'eval'));
    symlinkSync(resolve(root, 'elsewhere'), join(root, 'eval', 'redteam'));
    bothRefuse(root, 'ancestor-symlink', 'eval/redteam', 'symlink');
  });

  it('both refuse a directory in place of the file', () => {
    const root = relativeFixture({ 'README.md': GOOD_README });
    mkdirSync(join(root, BASELINE_PATH), { recursive: true });
    bothRefuse(root, 'directory', 'not a regular file');
  });

  it('both refuse a file over the byte cap', () => {
    const padded = baseline().replace('"schemaVersion"', `"pad": "${'x'.repeat(1_000_001)}", "schemaVersion"`);
    const root = relativeFixture({ 'README.md': GOOD_README, [BASELINE_PATH]: padded });
    bothRefuse(root, 'oversize', 'over the');
  });

  it.skipIf(process.platform === 'win32')('both refuse a FIFO at once, without waiting for a writer', () => {
    const root = relativeFixture({ 'README.md': GOOD_README });
    mkdirSync(join(root, 'eval', 'redteam'), { recursive: true });
    const fifo = join(root, BASELINE_PATH);
    execFileSync('mkfifo', [fifo]);
    // A blocking open would wait for this writer; both must return well
    // before it arrives, which is what O_NONBLOCK is for.
    const writer = spawn('sh', ['-c', `sleep 3; cat /dev/null > "${fifo}"`], { stdio: 'ignore' });
    try {
      const started = Date.now();
      bothRefuse(root, 'not-a-file', 'not a regular file');
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      writer.kill();
    }
  });
});

describe('check-corpus-numbers.mjs: adversarial verify fold (2026-09-01)', () => {
  // The verifier attacked the folded gate and refuted the width of one claim
  // (the fold set was narrower than "default-ignorable": eight other such
  // code points, the C0/C1 controls and a plain TAB still hid a claim) and
  // executed four observations: NFKC is quadratic in a run of combining marks
  // with mixed canonical classes; findings were unbounded per file; a README
  // that is a FIFO was skipped where a docs FIFO is refused; the line cap's
  // unit is UTF-16 code units.

  it('folds every default-ignorable code point, the controls and a plain TAB, not only the six the security fold named (R2)', () => {
    const c = (n: number) => String.fromCodePoint(n);
    const doc = [
      `the 51${c(0x2066)} cases corpus`, // left-to-right isolate
      `the cor${c(0x202e)}pus has 51 cases`, // right-to-left override
      `the 51${c(0x09)}cases corpus`, // a plain tab
      `the 51${c(0x07)} cases corpus`, // BEL
      `the cor${c(0x85)}pus has 51 cases`, // NEL
      `the cor${c(0xfe0f)}pus has 51 cases`, // variation selector 16
      `the 51${c(0x1680)}cases corpus`, // Ogham space mark
      '',
    ].join('\n');
    const root = fixture(tree({ 'docs/a.md': doc }));
    expectFinding(
      root,
      'docs/a.md:1:',
      'docs/a.md:2:',
      'docs/a.md:3:',
      'docs/a.md:4:',
      'docs/a.md:5:',
      'docs/a.md:6:',
      'docs/a.md:7:',
    );
  });

  it('exits 2 on a run of more than 30 combining marks, which makes NFKC quadratic, and accepts 30 (O1)', () => {
    const mark = String.fromCodePoint(0x0301);
    const thirty = fixture(tree({ 'docs/a.md': `e${mark.repeat(30)} fine\n` }));
    expectClean(thirty);
    const thirtyOne = fixture(tree({ 'docs/a.md': `ok\ne${mark.repeat(31)}\n` }));
    expectIncomplete(thirtyOne, 'docs/a.md:2', 'combining marks');
  });

  it('caps the findings shown per file and reports the count not shown, so one doc cannot flood the log (O2)', () => {
    const root = fixture(tree({ 'docs/a.md': 'detection 1.1%\n'.repeat(250) }));
    const run = expectFinding(root, 'docs/a.md:200:', '50 more', 'FAILED (250 problem(s)');
    expect(run.stderr).not.toContain('docs/a.md:201:');
  });

  it.skipIf(process.platform === 'win32')('exits 2 when README.md is not a regular file, as a docs entry would (O3)', () => {
    const root = fixture({ [BASELINE_PATH]: baseline(), 'docs/a.md': 'the 53-case corpus\n' });
    execFileSync('mkfifo', [join(root, 'README.md')]);
    expectIncomplete(root, 'README.md', 'not a regular file');
  });
});
