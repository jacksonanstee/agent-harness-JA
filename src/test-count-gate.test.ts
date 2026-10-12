import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
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

function runGateWithEnv(root: string, env: Record<string, string>): Run {
  try {
    const stdout = execFileSync('bash', [SCRIPT, root], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`, ...env },
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
  vitestStderr?: string;
}): string {
  const root = mkdtempSync(join(tmpdir(), 'testcount-gate-'));
  roots.push(root);
  writeFileSync(join(root, 'README.md'), options.readme);
  mkdirSync(join(root, 'bin'), { recursive: true });
  const npx = join(root, 'bin', 'npx');
  writeFileSync(
    npx,
    `#!/usr/bin/env bash\n` +
      (options.vitestStderr ? `cat >&2 <<'ERR'\n${options.vitestStderr}\nERR\n` : '') +
      `cat <<'JSON'\n${options.vitestJson ?? ''}\nJSON\nexit ${options.vitestStatus ?? 0}\n`,
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

  it('exits 2 on failed TESTS alone, with a clean exit status and no failed suites', () => {
    // Round-2 review: each of the three red-suite conditions had a sibling
    // covering it, so dropping numFailedTests left the whole suite green. This
    // fixture isolates that one condition and its mirror below isolates the
    // suite-count one.
    const run = runGate(
      fixture({
        readme: readmeClaiming(1145),
        vitestJson: JSON.stringify({ numTotalTests: 1145, numFailedTests: 3, numFailedTestSuites: 0 }),
        vitestStatus: 0,
      }),
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('3 failed test(s)');
  });

  it('exits 2 on a failed SUITE alone, with a clean exit status and no failed tests', () => {
    const run = runGate(
      fixture({
        readme: readmeClaiming(1145),
        vitestJson: JSON.stringify({ numTotalTests: 1145, numFailedTests: 0, numFailedTestSuites: 2 }),
        vitestStatus: 0,
      }),
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('2 failed suite(s)');
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

  it('⭐ exits 2 when the gate CRASHES, the contract its header always claimed', () => {
    // Round-3: this file declared the same 0/1/2 contract as check-docs.sh and
    // implemented none of it. Under `set -u` a crash exits 1, and the only
    // exit 1 here means "your README count is stale" - so a typo in a message
    // string would have told a developer to write a wrong number into the
    // README, which is the exact defect this gate exists to prevent.
    const root = fixture({ readme: readmeClaiming(1157), vitestJson: green(1157) });
    const run = runGateWithEnv(root, { CHECK_TEST_COUNT_SELFTEST_CRASH: '1' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('did not complete');
  });

  it('tolerates a reformatted status table rather than reporting the row as missing', () => {
    // A markdown formatter pads table columns to align them; the fixed
    // single-space pattern then found nothing and blamed the wrong thing.
    const root = fixture({
      readme: '# R\n\n| Milestone | Status |\n|-----------|--------|\n| Tests     | 1157 at the snapshot |\n',
      vitestJson: green(1157),
    });
    expect(runGate(root).status).toBe(0);
  });

  it('refuses to guess when the README carries two Tests rows', () => {
    const root = fixture({
      readme: `${readmeClaiming(1157)}| Tests | 999 elsewhere |\n`,
      vitestJson: green(1157),
    });
    const run = runGate(root);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('more than one');
  });

  it('exits 2 when the root does not exist', () => {
    const run = runGate(join(tmpdir(), 'testcount-gate-missing-4a71'));
    expect(run.status).toBe(2);
  });

  describe('vitest diagnosis (#175: an exit-139 flake that left no trace)', () => {
    // The gate once discarded vitest's stderr, so a SIGSEGV that produced no
    // JSON reported only "could not read the suite's test count". These pins
    // hold the status and the stderr tail on every exit-2 path after vitest ran.
    // The temp file is steered into the fixture with TMPDIR so its removal can
    // be observed without touching a shared /tmp.
    const tmpIn = (root: string): string => {
      const dir = join(root, 'tmp');
      mkdirSync(dir, { recursive: true });
      return dir;
    };

    it('names SIGSEGV and shows the stderr tail when vitest crashes with no stdout', () => {
      const root = fixture({
        readme: readmeClaiming(1145),
        vitestStderr: 'MARKER-segv-stderr',
        vitestStatus: 139,
      });
      const run = runGateWithEnv(root, { TMPDIR: tmpIn(root) });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('exit 139');
      expect(run.stderr).toContain('SIGSEGV');
      expect(run.stderr).toContain('MARKER-segv-stderr');
    });

    it('names a generic signal for another status above 128', () => {
      const root = fixture({ readme: readmeClaiming(1145), vitestStatus: 137 });
      const run = runGateWithEnv(root, { TMPDIR: tmpIn(root) });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('killed by signal 9');
    });

    it('shows status and stderr tail on a red suite that did print JSON', () => {
      const root = fixture({
        readme: readmeClaiming(1145),
        vitestJson: JSON.stringify({ numTotalTests: 1140, numFailedTests: 5, numFailedTestSuites: 1 }),
        vitestStatus: 1,
        vitestStderr: 'MARKER-red-stderr',
      });
      const run = runGateWithEnv(root, { TMPDIR: tmpIn(root) });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('not green');
      expect(run.stderr).toContain('exit 1');
      expect(run.stderr).not.toContain('SIGSEGV');
      expect(run.stderr).toContain('MARKER-red-stderr');
    });

    it('keeps only the last 20 lines of stderr', () => {
      const lines = Array.from({ length: 30 }, (_, i) => `LINE-${String(i + 1).padStart(2, '0')}`);
      const root = fixture({
        readme: readmeClaiming(1145),
        vitestStderr: lines.join('\n'),
        vitestStatus: 139,
      });
      const run = runGateWithEnv(root, { TMPDIR: tmpIn(root) });
      expect(run.stderr).not.toContain('LINE-10');
      expect(run.stderr).toContain('LINE-11');
      expect(run.stderr).toContain('LINE-30');
    });

    it('prints no stderr tail on the green path', () => {
      const root = fixture({
        readme: readmeClaiming(1145),
        vitestJson: green(1145),
        vitestStderr: 'MARKER-green-stderr',
      });
      const run = runGateWithEnv(root, { TMPDIR: tmpIn(root) });
      expect(run.status).toBe(0);
      expect(run.stdout + run.stderr).not.toContain('MARKER-green-stderr');
    });

    it('removes its temp file on the green path and on the exit-2 path', () => {
      const greenRoot = fixture({ readme: readmeClaiming(1145), vitestJson: green(1145) });
      const greenTmp = tmpIn(greenRoot);
      expect(runGateWithEnv(greenRoot, { TMPDIR: greenTmp }).status).toBe(0);
      expect(readdirSync(greenTmp)).toEqual([]);

      const redRoot = fixture({ readme: readmeClaiming(1145), vitestStatus: 139 });
      const redTmp = tmpIn(redRoot);
      expect(runGateWithEnv(redRoot, { TMPDIR: redTmp }).status).toBe(2);
      expect(readdirSync(redTmp)).toEqual([]);
    });
  });
});
