import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Tests for `scripts/check-docs.sh` (issue #61).
 *
 * ⚠️ THE POINT OF THESE TESTS IS THAT THE GATE ACTUALLY FIRES. A docs gate is
 * a corrective artefact, and this repo's standing rule is that a corrective
 * artefact is not evidence about itself: the previous two docs-adjacent
 * "fixes" both shipped a check that could not fail, in the commit advertising
 * the check. So every case below asserts a NON-ZERO exit and the specific
 * message, and each passing case is paired with a failing one that differs by
 * the single property under test.
 *
 * The regression fixture is the real thing: the exact bytes that shipped a
 * residual-risk row outside its table while the whole suite stayed green.
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

/** 28 contiguous ADRs, matching what README fixtures below claim. */
function adrTree(count = 28): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 1; i <= count; i += 1) {
    files[`docs/decisions/${String(i).padStart(4, '0')}-x.md`] = `# ADR ${i}\n`;
  }
  return files;
}

const GOOD_README = '# R\n\nTwenty-eight ADRs (0001-0028) cover it.\n\n| ADRs | 0001-0028 |\n| --- | --- |\n| a | b |\n';

describe('check-docs.sh — table structure', () => {
  it('accepts a well-formed table', () => {
    const root = fixture({ 'docs/a.md': '# T\n\n| h | i |\n| --- | --- |\n| a | b |\n' });
    expect(runGate(root).status).toBe(0);
  });

  it('REJECTS a row separated from its table by a blank line', () => {
    // The defect. Differs from the case above by one blank line.
    const root = fixture({
      'docs/a.md': '# T\n\n| h | i |\n| --- | --- |\n| a | b |\n\n| c | d |\n\nAfter.\n',
    });
    const run = runGate(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('docs/a.md:7');
    expect(run.stderr).toContain('renders as a paragraph');
  });

  it('REJECTS a table whose delimiter row is missing entirely', () => {
    const root = fixture({ 'docs/a.md': '# T\n\n| h | i |\n| a | b |\n' });
    expect(runGate(root).status).toBe(1);
  });

  it('REJECTS a lone pipe line, which is the single-row form of the same defect', () => {
    const root = fixture({ 'docs/a.md': '# T\n\n| R-18 | a residual |\n\ntext\n' });
    expect(runGate(root).status).toBe(1);
  });

  it('does not accept "| |" as a delimiter row', () => {
    // Pins the hyphen requirement: without it, any second pipe line would pass.
    const root = fixture({ 'docs/a.md': '# T\n\n| h | i |\n| |\n| a | b |\n' });
    expect(runGate(root).status).toBe(1);
  });

  it('ignores pipe-leading lines inside a fenced block', () => {
    const root = fixture({
      'docs/a.md': '# T\n\n```\n| not | a | table |\n```\n\ntext\n',
    });
    expect(runGate(root).status).toBe(0);
  });

  it('ignores a fenced block that carries an info string', () => {
    const root = fixture({
      'docs/a.md': '# T\n\n```text\n| not | a | table |\n```\n\ntext\n',
    });
    expect(runGate(root).status).toBe(0);
  });

  it('still sees a broken table AFTER a fenced block has closed', () => {
    // Pins that the fence toggle restores scanning rather than disabling it.
    const root = fixture({
      'docs/a.md': '# T\n\n```\ncode\n```\n\n| orphan | row |\n\ntext\n',
    });
    expect(runGate(root).status).toBe(1);
  });

  it('reports the file and line of every orphan, not just the first', () => {
    const root = fixture({
      'docs/a.md': '# T\n\n| one | x |\n\ntext\n\n| two | y |\n',
      'docs/b.md': '# U\n\n| three | z |\n',
    });
    const run = runGate(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('docs/a.md:3');
    expect(run.stderr).toContain('docs/a.md:7');
    expect(run.stderr).toContain('docs/b.md:3');
    expect(run.stderr).toContain('3 problem(s)');
  });

  it('⚠️ KNOWN LIMIT, pinned so it is a decision and not a surprise: ~~~ fences do not toggle', () => {
    // Documented in the script header. If someone teaches it ~~~ fences, this
    // test goes red and they must delete it deliberately.
    const root = fixture({ 'docs/a.md': '# T\n\n~~~\n| not | a | table |\n~~~\n' });
    expect(runGate(root).status).toBe(1);
  });
});

describe('check-docs.sh — fence balance', () => {
  it('accepts balanced fences', () => {
    const root = fixture({ 'docs/a.md': '# T\n\n```ts\nconst x = 1;\n```\n' });
    expect(runGate(root).status).toBe(0);
  });

  it('REJECTS an unclosed fence', () => {
    const root = fixture({ 'docs/a.md': '# T\n\n```ts\nconst x = 1;\n' });
    const run = runGate(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('never closed');
  });
});

describe('check-docs.sh — derived ADR constants', () => {
  it('accepts counts that match the filesystem', () => {
    expect(runGate(fixture({ ...adrTree(28), 'README.md': GOOD_README })).status).toBe(0);
  });

  it('REJECTS a stale range claim', () => {
    // 28 ADRs on disk, README still says 0001-0026.
    const root = fixture({
      ...adrTree(28),
      'README.md': '# R\n\nTwenty-eight ADRs (0001-0026).\n',
    });
    const run = runGate(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('0001-0028');
  });

  it('REJECTS a stale NUMERIC count, which is a separate spelling of the same fact', () => {
    // Found by this gate missing it on its own first run: adding ADR-0029 left
    // "28 ADRs" stale in the README header while the range and the spelled-out
    // count were both caught. One fact with two spellings needs two checks.
    const root = fixture({
      ...adrTree(28),
      'README.md': '# R\n\nEvery decision recorded: 26 ADRs, a threat model.\n\nTwenty-eight ADRs (0001-0028).\n',
    });
    const run = runGate(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("claims '26 ADRs'");
  });

  it('REJECTS a stale spelled-out count', () => {
    const root = fixture({
      ...adrTree(28),
      'README.md': '# R\n\nTwenty-six ADRs (0001-0028).\n',
    });
    const run = runGate(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('twenty-eight');
  });

  it('REJECTS a gap in ADR numbering rather than reporting an ambiguous count', () => {
    const files = adrTree(28);
    delete files['docs/decisions/0005-x.md'];
    const run = runGate(fixture({ ...files, 'README.md': GOOD_README }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('gap or a duplicate');
  });

  it('REPORTS rather than silently skipping a count it cannot spell', () => {
    // 41 ADRs: outside the twenty/thirty mapping. A skip here would be the
    // proxy-check pattern, going quiet exactly when the repo outgrows it.
    const root = fixture({
      ...adrTree(41),
      'README.md': '# R\n\nTwenty-eight ADRs (0001-0041).\n',
    });
    const run = runGate(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('extend the mapping');
  });
});

describe('check-docs.sh — regression: the defect that motivated it', () => {
  it('fires on the real shape that shipped a residual row outside its table', () => {
    // Reduced from docs/security-model.md at 50efacb, where R-18 was added
    // after the blank line that terminates the §6 table. It rendered as a
    // paragraph with visible pipes; the suite, lint, typecheck and
    // check-links were all green over it, and the commit's stated purpose was
    // adding that row.
    const root = fixture({
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
    });
    const run = runGate(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('docs/security-model.md:8');
  });

  it('passes on the corrected shape, which differs by exactly one blank line', () => {
    const root = fixture({
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
    });
    expect(runGate(root).status).toBe(0);
  });
});
