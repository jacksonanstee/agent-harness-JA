import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Tests for `scripts/check-docs.sh` (issue #61).
 *
 * ⚠️ WHY EVERY FAILING CASE ASSERTS THE MESSAGE AND NOT JUST THE EXIT CODE.
 * The first cut of this file asserted only `status === 1` in five places, and
 * its own docstring claimed otherwise. `set -u` makes bash exit 1 on an unbound
 * variable — the same code the gate used for "I found problems" — so those five
 * tests passed against a build of the script that executed no checks at all.
 * Found by adversarial review, and it is the exact failure this repo keeps
 * hitting: a corrective artefact carrying the defect class it is about.
 *
 * Two things changed as a result. The gate now exits 2 for "did not complete"
 * so 1 cannot mean a crash, and every failing case below pins the message.
 * `expectFinding` enforces both, so a new test cannot quietly reintroduce it.
 */

const SCRIPT = join(process.cwd(), 'scripts', 'check-docs.sh');

type Run = { status: number; stderr: string; stdout: string };

function runGate(root: string): Run {
  try {
    const stdout = execFileSync('bash', [SCRIPT, root], { encoding: 'utf8', stdio: 'pipe' });
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

function expectClean(root: string): void {
  const run = runGate(root);
  expect(run.status, `expected clean (exit 0): ${run.stderr}`).toBe(0);
}

const roots: string[] = [];

/** A fixture tree with no git dir, so the gate takes its `find` path. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'docs-gate-'));
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

function adrTree(count = 28): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 1; i <= count; i += 1) {
    files[`docs/decisions/${String(i).padStart(4, '0')}-x.md`] = `# ADR ${i}\n`;
  }
  return files;
}

const GOOD_README =
  '# R\n\nTwenty-eight ADRs (0001-0028) cover it.\n\n| ADRs | 0001-0028 |\n| --- | --- |\n| a | b |\n';

describe('check-docs.sh — exit-code contract', () => {
  it('exits 2, not 1, when the gate itself cannot complete', () => {
    // The property that makes every `toBe(1)` below meaningful. Without it a
    // crashed script is indistinguishable from a script that found a problem.
    const run = runGate(join(tmpdir(), 'docs-gate-does-not-exist-9f3a'));
    expect(run.status).toBe(2);
  });
});

describe('check-docs.sh — table structure', () => {
  it('accepts a well-formed table', () => {
    expectClean(fixture({ 'docs/a.md': '# T\n\n| h | i |\n| --- | --- |\n| a | b |\n' }));
  });

  it('REJECTS a row separated from its table by a blank line', () => {
    // The defect. Differs from the case above by one blank line.
    expectFinding(
      fixture({
        'docs/a.md': '# T\n\n| h | i |\n| --- | --- |\n| a | b |\n\n| c | d |\n\nAfter.\n',
      }),
      'docs/a.md:7',
      'renders as a paragraph',
    );
  });

  it('REJECTS a table whose delimiter row is missing entirely', () => {
    expectFinding(
      fixture({ 'docs/a.md': '# T\n\n| h | i |\n| a | b |\n' }),
      'docs/a.md:3',
      'no delimiter row',
    );
  });

  it('REJECTS a lone pipe line, which is the single-row form of the same defect', () => {
    expectFinding(
      fixture({ 'docs/a.md': '# T\n\n| R-18 | a residual |\n\ntext\n' }),
      'docs/a.md:3',
      'renders as a paragraph',
    );
  });

  it('does not accept "| |" as a delimiter row', () => {
    // Pins the hyphen requirement: without it any second pipe line would pass.
    expectFinding(fixture({ 'docs/a.md': '# T\n\n| h | i |\n| |\n| a | b |\n' }), 'docs/a.md:3');
  });

  it('accepts a delimiter row indented up to 3 spaces, which CommonMark permits', () => {
    // Rejected by the first cut: a false positive on valid markdown.
    expectClean(fixture({ 'docs/a.md': '# T\n\n | h | i |\n | --- | --- |\n | a | b |\n' }));
  });

  it('accepts a valid table in a CRLF file', () => {
    // Rejected by the first cut, because \r is not in the delimiter class.
    expectClean(fixture({ 'docs/a.md': '# T\r\n\r\n| h | i |\r\n| --- | --- |\r\n| a | b |\r\n' }));
  });

  it('still REJECTS an orphan row in a CRLF file', () => {
    // The CRLF fix must not buy its clean run by disabling the check.
    expectFinding(
      fixture({ 'docs/a.md': '# T\r\n\r\n| c | d |\r\n\r\ntext\r\n' }),
      'docs/a.md:3',
    );
  });

  it('ignores pipe-leading lines inside a fenced block', () => {
    expectClean(fixture({ 'docs/a.md': '# T\n\n```\n| not | a | table |\n```\n\ntext\n' }));
  });

  it('ignores a fenced block that carries an info string', () => {
    expectClean(fixture({ 'docs/a.md': '# T\n\n```text\n| not | a | table |\n```\n\ntext\n' }));
  });

  it('ignores pipe-leading lines inside an INDENTED fence', () => {
    // A fence inside a list item. The first cut only matched fences at column
    // 0, so this fired as a false positive on valid markdown, and ADR-0029
    // claimed a test pinned the limit when none existed.
    expectClean(
      fixture({
        'docs/a.md': '# T\n\n1. Step:\n\n   ```\n| pipes inside the block |\n   ```\n\n2. Next.\n',
      }),
    );
  });

  it('treats a 3-backtick example inside a 4-backtick block as content, not a fence', () => {
    // Real shape in this repo (process/plans/...). Counting fence LINES called
    // it unbalanced; only a same-character run at least as long may close.
    expectClean(
      fixture({ 'docs/a.md': '# T\n\n````markdown\n```\n| a | b |\n```\n````\n\ntext\n' }),
    );
  });

  it('ignores pipe-leading lines inside a ~~~ fence', () => {
    // The first cut did not toggle on tildes and a test PINNED that weakness.
    // Tildes are now tracked, so that test is deliberately replaced by this one.
    expectClean(fixture({ 'docs/a.md': '# T\n\n~~~\n| not | a | table |\n~~~\n\ntext\n' }));
  });

  it('does not let a ~~~ line close a ``` fence', () => {
    // Guards the fix from the lazy version where any fence marker toggles.
    expectClean(fixture({ 'docs/a.md': '# T\n\n```\n~~~\n| still inside |\n```\n\ntext\n' }));
  });

  it('still sees a broken table AFTER a fenced block has closed', () => {
    expectFinding(
      fixture({ 'docs/a.md': '# T\n\n```\ncode\n```\n\n| orphan | row |\n\ntext\n' }),
      'docs/a.md:7',
    );
  });

  it('REJECTS a fence that is opened and never closed', () => {
    expectFinding(fixture({ 'docs/a.md': '# T\n\n```ts\nconst x = 1;\n' }), 'never closed');
  });

  it('accepts three column-0 fence lines when they are structurally balanced', () => {
    // Parity counting called this broken: ```` opens, ``` is content, ````
    // closes is 2 markers, but a 3-line variant exposed the false positive.
    expectClean(fixture({ 'docs/a.md': '# T\n\n````\n```\n````\n\ntext\n' }));
  });

  it('reports the file and line of every orphan, not just the first', () => {
    const run = expectFinding(
      fixture({
        'docs/a.md': '# T\n\n| one | x |\n\ntext\n\n| two | y |\n',
        'docs/b.md': '# U\n\n| three | z |\n',
      }),
      'docs/a.md:3',
      'docs/a.md:7',
      'docs/b.md:3',
    );
    expect(run.stderr).toContain('3 problem(s)');
  });
});

describe('check-docs.sh — derived ADR constants', () => {
  it('accepts counts that match the filesystem', () => {
    expectClean(fixture({ ...adrTree(28), 'README.md': GOOD_README }));
  });

  it('REJECTS a stale range claim', () => {
    expectFinding(
      fixture({ ...adrTree(28), 'README.md': '# R\n\nTwenty-eight ADRs (0001-0026).\n' }),
      '0001-0028',
    );
  });

  it('REJECTS a stale NUMERIC count, which is a separate spelling of the same fact', () => {
    // Found by this gate missing it on its own first run: adding an ADR left
    // "28 ADRs" stale in the README header while the range and spelled-out
    // forms were caught. One fact with three spellings needs three checks.
    expectFinding(
      fixture({
        ...adrTree(28),
        'README.md': '# R\n\nEvery decision recorded: 26 ADRs, a threat model.\n\nTwenty-eight ADRs (0001-0028).\n',
      }),
      "claims '26 ADRs'",
    );
  });

  it('REJECTS a stale spelled-out count', () => {
    expectFinding(
      fixture({ ...adrTree(28), 'README.md': '# R\n\nTwenty-six ADRs (0001-0028).\n' }),
      'twenty-eight',
    );
  });

  it('checks EVERY claim, not just the first one it finds', () => {
    // The first cut took `head -1` and stopped, so a second, stale claim later
    // in the file was never compared against anything.
    expectFinding(
      fixture({
        ...adrTree(28),
        'README.md': '# R\n\nTwenty-eight ADRs (0001-0028).\n\nElsewhere: Twenty-six ADRs are recorded.\n',
      }),
      "'Twenty-six'",
    );
  });

  it('does not read an unrelated "thirty" elsewhere in the README as the ADR count', () => {
    // The first cut grepped the whole file and took the first match, so one
    // sentence of ordinary prose above the real claim red-lighted CI with a
    // message naming the wrong problem.
    expectClean(
      fixture({
        ...adrTree(28),
        'README.md': '# R\n\nWe shipped in under thirty days.\n\nTwenty-eight ADRs (0001-0028).\n',
      }),
    );
  });

  it('REJECTS a gap in ADR numbering rather than reporting an ambiguous count', () => {
    const files = adrTree(28);
    delete files['docs/decisions/0005-x.md'];
    expectFinding(fixture({ ...files, 'README.md': GOOD_README }), 'gap or a duplicate');
  });

  it('REPORTS rather than silently skipping a count it cannot spell', () => {
    // 41 ADRs: outside the twenty/thirty mapping. A skip here would be the
    // proxy-check pattern, going quiet exactly when the repo outgrew it.
    expectFinding(
      fixture({ ...adrTree(41), 'README.md': '# R\n\nTwenty-eight ADRs (0001-0041).\n' }),
      'extend the mapping',
    );
  });

  it('REPORTS a README that discusses ADRs but carries no recognisable count', () => {
    // Otherwise rewording the claim silently drops the coverage, and the gate
    // keeps reporting OK over a fact nobody is checking any more.
    expectFinding(
      fixture({ ...adrTree(28), 'README.md': '# R\n\nOur ADRs live in docs/decisions.\n' }),
      'silently covering nothing',
    );
  });
});

describe('check-docs.sh — regression: the defect that motivated it', () => {
  it('fires on the real shape that shipped a residual row outside its table', () => {
    // Reduced from docs/security-model.md at 50efacb, where R-18 was added
    // after the blank line terminating the §6 table. It rendered as a
    // paragraph; the suite, lint, typecheck and check-links were all green,
    // and the commit's stated purpose was adding that row.
    expectFinding(
      fixture({
        'docs/security-model.md': [
          '## 6. Residual risks',
          '',
          '| # | Risk | Severity |',
          '|---|------|----------|',
          '| R-16 | a digest |  Low |',
          '| R-17 | cleartext paths | Low |',
          '',
          '| R-18 | a skill body reaching column 0 | Medium |',
          '',
          'The single most important honest statement in this document is R-4.',
          '',
        ].join('\n'),
      }),
      'docs/security-model.md:8',
    );
  });

  it('passes on the corrected shape, which differs by exactly one blank line', () => {
    expectClean(
      fixture({
        'docs/security-model.md': [
          '## 6. Residual risks',
          '',
          '| # | Risk | Severity |',
          '|---|------|----------|',
          '| R-16 | a digest |  Low |',
          '| R-17 | cleartext paths | Low |',
          '| R-18 | a skill body reaching column 0 | Medium |',
          '',
          'The single most important honest statement in this document is R-4.',
          '',
        ].join('\n'),
      }),
    );
  });
});
