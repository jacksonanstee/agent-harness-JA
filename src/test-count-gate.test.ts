import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Tests for `scripts/check-test-count.sh`.
 *
 * ⚠️ THIS FILE EXISTS BECAUSE THE GATE SHIPPED WITHOUT IT. The commit that
 * added two docs gates unit-tested one of them, and adversarial review found
 * the untested one had a defect that inverted its purpose: it captured
 * vitest's stdout and never read its exit status, so a suite that failed to
 * COLLECT (sixteen tests silently absent) produced "README claims 1135; the
 * suite ran 1119. Re-derive the number" — instructing the developer to write
 * the broken count into the README and hide the real failure.
 *
 * The fixtures below stub `npx` on PATH so the parsing and status logic can be
 * driven without running the real suite. That is the whole reason the script
 * takes a ROOT argument.
 */

const SCRIPT = join(process.cwd(), 'scripts', 'check-test-count.sh');

type Run = { status: number; stderr: string; stdout: string };

function runGate(root: string): Run {
  try {
    const stdout = execFileSync('bash', [SCRIPT, root], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}` },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status: number; stderr: string; stdout: string };
    return { status: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const roots: string[] = [];

/**
 * A fixture root with a README and a fake `npx` that prints `vitestJson` and
 * exits `vitestStatus`, standing in for the real suite.
 */
function fixture(options: {
  readme: string;
  vitestJson?: string;
  vitestStatus?: number;
}): string {
  const root = mkdtempSync(join(tmpdir(), 'testcount-gate-'));
  roots.push(root);
  writeFileSync(join(root, 'README.md'), options.readme);
  mkdirSync(join(root, 'bin'), { recursive: true });
  const npx = join(root, 'bin', 'npx');
  writeFileSync(
    npx,
    `#!/usr/bin/env bash\ncat <<'JSON'\n${options.vitestJson ?? ''}\nJSON\nexit ${options.vitestStatus ?? 0}\n`,
  );
  execFileSync('chmod', ['+x', npx]);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const readmeClaiming = (n: number): string =>
  `# R\n\n| Milestone | Status |\n|---|---|\n| Tests | ${n} at the 2026-08-04 snapshot |\n`;

const green = (total: number): string =>
  JSON.stringify({ numTotalTests: total, numFailedTests: 0, numFailedTestSuites: 0 });

describe('check-test-count.sh', () => {
  it('passes when the README count matches the suite', () => {
    const run = runGate(fixture({ readme: readmeClaiming(1145), vitestJson: green(1145) }));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('OK (1145)');
  });

  it('exits 1 and names both numbers when the count is stale', () => {
    const run = runGate(fixture({ readme: readmeClaiming(1112), vitestJson: green(1145) }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('claims 1112');
    expect(run.stderr).toContain('ran 1145');
  });

  it('⭐ exits 2 on a RED suite instead of blaming the README', () => {
    // The defect this file was written for. A failing suite reports fewer
    // tests, which the first cut read as documentation drift.
    const run = runGate(
      fixture({
        readme: readmeClaiming(1145),
        vitestJson: JSON.stringify({ numTotalTests: 1140, numFailedTests: 5, numFailedTestSuites: 1 }),
      }),
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('not green');
    expect(run.stderr).toContain('README is not the problem');
  });

  it('exits 2 when a suite fails to COLLECT, which is how the defect was found', () => {
    // Collection failure: tests simply vanish, so numFailedTests can be 0
    // while the total is wrong. Only the suite count and the exit status show
    // it, which is why all three are checked.
    const run = runGate(
      fixture({
        readme: readmeClaiming(1145),
        vitestJson: JSON.stringify({ numTotalTests: 1129, numFailedTests: 0, numFailedTestSuites: 1 }),
        vitestStatus: 1,
      }),
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('not green');
  });

  it('exits 2 when vitest exits non-zero even if the JSON looks clean', () => {
    const run = runGate(
      fixture({ readme: readmeClaiming(1145), vitestJson: green(1145), vitestStatus: 1 }),
    );
    expect(run.status).toBe(2);
  });

  it('exits 2 on unparseable output rather than guessing', () => {
    const run = runGate(fixture({ readme: readmeClaiming(1145), vitestJson: 'not json at all' }));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('could not read');
  });

  it('exits 2 when the README row is missing, rather than passing vacuously', () => {
    // A silent pass here is the proxy-check pattern: delete the row and the
    // gate goes quiet forever while still reporting success.
    const run = runGate(fixture({ readme: '# R\n\nNo status table.\n', vitestJson: green(1145) }));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("no '| Tests | N' row");
  });

  it('exits 2 when the root does not exist', () => {
    const run = runGate(join(tmpdir(), 'testcount-gate-missing-4a71'));
    expect(run.status).toBe(2);
  });
});
