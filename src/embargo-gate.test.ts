import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Tests for `scripts/check-embargo.sh` and the hooks `scripts/install-hooks.sh`
 * installs. Each case builds a throwaway git repository with its own
 * tasks/embargo.txt holding a FAKE term, so the real (gitignored) list is never
 * read. Every bypass here was reproduced by review of the first version
 * (13/11/2026): '++' lines, binary and UTF-16 content, external diff, file and
 * ref names, tag messages, merge content, spelling variants, untrimmed list
 * lines, and hooks silently skipped in a worktree.
 */

const REPO = process.cwd();
const TERM = 'zq_fake_embargo_term';
const tmpDirs: string[] = [];

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

type Run = { status: number; stdout: string; stderr: string };

function run(cmd: string, args: string[], cwd: string): Run {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

const git = (dir: string, ...args: string[]): Run => run('git', args, dir);
const check = (dir: string, ...args: string[]): Run => run('bash', [join(dir, 'scripts', 'check-embargo.sh'), ...args], dir);

function makeRepo(list: string | Buffer | null = `# comment\n${TERM}\n`): string {
  const dir = mkdtempSync(join(tmpdir(), 'embargo-gate-'));
  tmpDirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'scripts'));
  cpSync(join(REPO, 'scripts', 'check-embargo.sh'), join(dir, 'scripts', 'check-embargo.sh'));
  cpSync(join(REPO, 'scripts', 'install-hooks.sh'), join(dir, 'scripts', 'install-hooks.sh'));
  cpSync(join(REPO, '.githooks'), join(dir, '.githooks'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), 'tasks/\n');
  if (list !== null) {
    mkdirSync(join(dir, 'tasks'));
    writeFileSync(join(dir, 'tasks', 'embargo.txt'), list);
  }
  writeFileSync(join(dir, 'README'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

function textFile(dir: string, content: string | Buffer): string {
  const p = join(dir, 'tasks-probe.txt');
  writeFileSync(p, content);
  return p;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('check-embargo.sh text matching', () => {
  it('passes clean text and blocks the term without echoing it', () => {
    const dir = makeRepo();
    expect(check(dir, 'text', textFile(dir, 'nothing here\n')).status).toBe(0);
    const r = check(dir, 'text', textFile(dir, `see ${TERM} here\n`));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('line 2');
    expect(r.stderr + r.stdout).not.toContain(TERM);
  });

  it.each([
    ['upper case', TERM.toUpperCase()],
    ['markdown-escaped underscores', TERM.replaceAll('_', '\\_')],
    ['hyphens for underscores', TERM.replaceAll('_', '-')],
    ['wrapped across lines', TERM.replace('_embargo_', '_embargo\n')],
    ['on a line with invalid UTF-8', `\xff ${TERM}`],
  ])('blocks the term %s', (_name, spelling) => {
    const dir = makeRepo();
    const content = spelling.includes('\xff') ? Buffer.from(`x\n${spelling}\n`, 'latin1') : `x\n${spelling}\n`;
    expect(check(dir, 'text', textFile(dir, content)).status).toBe(1);
  });

  it('blocks the term in UTF-16 text', () => {
    const dir = makeRepo();
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`a ${TERM}\n`, 'utf16le')]);
    expect(check(dir, 'text', textFile(dir, utf16)).status).toBe(1);
  });
});

describe('check-embargo.sh list states', () => {
  it('says NOT CHECKED on stderr when there is no list', () => {
    const dir = makeRepo(null);
    const r = check(dir, 'text', textFile(dir, TERM));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('NOT CHECKED');
  });

  it('says NOT CHECKED for a list with only comments and blank lines', () => {
    const dir = makeRepo('# only a comment\n\n   \n');
    const r = check(dir, 'text', textFile(dir, TERM));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('NOT CHECKED');
  });

  it('refuses to run (exit 2) when the list cannot be read', () => {
    if (process.getuid?.() === 0) return; // root reads a mode-000 file
    const dir = makeRepo();
    chmodSync(join(dir, 'tasks', 'embargo.txt'), 0o000);
    const r = check(dir, 'text', textFile(dir, 'clean'));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('exists but cannot be read');
  });

  it('trims list lines: trailing space, tab and BOM still match, a tab-only line matches nothing', () => {
    const dir = makeRepo(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${TERM}  \t\n\t\n`)]));
    expect(check(dir, 'text', textFile(dir, `end ${TERM}`)).status).toBe(1);
    expect(check(dir, 'text', textFile(dir, 'clean\twith a tab\n')).status).toBe(0);
  });

  it('exits 2 on a usage error', () => {
    const dir = makeRepo();
    expect(check(dir, 'bogus').status).toBe(2);
    expect(check(dir, 'text', join(dir, 'missing')).status).toBe(2);
  });
});

describe('check-embargo.sh staged', () => {
  const staged = (setup: (dir: string) => void): number => {
    const dir = makeRepo();
    setup(dir);
    git(dir, 'add', '-A');
    return check(dir, 'staged').status;
  };

  it('passes a clean change', () => {
    expect(staged((d) => writeFileSync(join(d, 'a.txt'), 'clean\n'))).toBe(0);
  });

  it.each<[string, (d: string) => void]>([
    ['an added line starting with ++', (d) => writeFileSync(join(d, 'a.txt'), `++${TERM}\n`)],
    ['a file with a NUL byte', (d) => writeFileSync(join(d, 'a.bin'), Buffer.from(`\0${TERM}\0`))],
    ['a -diff attribute', (d) => { writeFileSync(join(d, '.gitattributes'), 'a.snap -diff\n'); writeFileSync(join(d, 'a.snap'), `${TERM}\n`); }],
    ['an external diff', (d) => { git(d, 'config', 'diff.external', 'true'); writeFileSync(join(d, 'a.txt'), `${TERM}\n`); }],
    ['only the file name', (d) => writeFileSync(join(d, `${TERM}.txt`), 'clean\n')],
  ])('blocks %s', (_name, setup) => {
    expect(staged(setup)).toBe(1);
  });
});

describe('check-embargo.sh range and ref', () => {
  it('blocks a term in a commit message, and exits 2 on a bad revision', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'a.txt'), 'clean\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `mention ${TERM}`);
    expect(check(dir, 'range', 'HEAD~1..HEAD').status).toBe(1);
    expect(check(dir, 'range', 'no-such-rev..HEAD').status).toBe(2);
  });

  it('ignores a term that a commit only REMOVES', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'a.txt'), `${TERM}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--no-verify', '-m', 'add');
    writeFileSync(join(dir, 'a.txt'), 'clean\n');
    git(dir, 'commit', '-q', '-am', 'scrub');
    expect(check(dir, 'range', 'HEAD~1..HEAD').status).toBe(0);
  });

  it('blocks a term added only while resolving a merge', () => {
    const dir = makeRepo();
    git(dir, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(dir, 's.txt'), 'side\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'side');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--no-ff', '--no-commit', 'side');
    writeFileSync(join(dir, 'm.txt'), `${TERM}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--no-verify', '-m', 'merge');
    expect(check(dir, 'range', 'HEAD~1..HEAD').status).toBe(1);
  });

  it('blocks a ref name and an annotated tag message', () => {
    const dir = makeRepo();
    expect(check(dir, 'ref', `refs/heads/${TERM}`).status).toBe(1);
    git(dir, 'tag', '-a', 'v1', '-m', `release ${TERM}`);
    const sha = git(dir, 'rev-parse', 'v1').stdout.trim();
    expect(check(dir, 'ref', 'refs/tags/v1', sha).status).toBe(1);
    expect(check(dir, 'ref', 'refs/heads/main').status).toBe(0);
  });
});

describe('install-hooks.sh', () => {
  it('moves a foreign hook aside, reports a core.hooksPath it removes, and is idempotent', () => {
    const dir = makeRepo();
    const hooks = join(dir, '.git', 'hooks');
    writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\necho foreign\n', { mode: 0o755 });
    git(dir, 'config', 'core.hooksPath', '.husky');
    const first = run('bash', [join(dir, 'scripts', 'install-hooks.sh')], dir);
    expect(first.status).toBe(0);
    expect(first.stderr).toContain('was: .husky');
    expect(first.stderr).toContain('pre-push moved to');
    expect(readFileSync(join(hooks, 'pre-push.pre-embargo'), 'utf8')).toContain('foreign');
    expect(git(dir, 'config', 'core.hooksPath').status).not.toBe(0);
    const second = run('bash', [join(dir, 'scripts', 'install-hooks.sh')], dir);
    expect(second.stderr).not.toContain('moved to');
  });

  it('warns at commit time when the installed check differs from the checkout', () => {
    const dir = makeRepo();
    run('bash', [join(dir, 'scripts', 'install-hooks.sh')], dir);
    appendFileSync(join(dir, 'scripts', 'check-embargo.sh'), '\n# edited\n');
    writeFileSync(join(dir, 'a.txt'), 'clean\n');
    git(dir, 'add', 'a.txt');
    const r = git(dir, 'commit', '-q', '-m', 'clean');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('installed check differs');
  });
});

describe('installed hooks', () => {
  it('block a dirty commit in a worktree checked out from a commit that has no hooks', () => {
    const dir = makeRepo();
    const base = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    git(dir, 'rm', '-rq', '.githooks');
    git(dir, 'commit', '-q', '-m', 'drop hooks from this commit');
    // install from the original files, which the base commit still carries
    git(dir, 'checkout', '-q', base);
    expect(run('bash', [join(dir, 'scripts', 'install-hooks.sh')], dir).status).toBe(0);
    git(dir, 'checkout', '-q', 'main');
    const wt = join(dir, 'wt');
    git(dir, 'worktree', 'add', '-q', wt, 'HEAD');
    writeFileSync(join(wt, 'a.txt'), `${TERM}\n`);
    git(wt, 'add', 'a.txt');
    expect(git(wt, 'commit', '-q', '-m', 'dirty').status).not.toBe(0);
    expect(git(wt, 'commit', '-q', '-m', `clean file, dirty message ${TERM}`).status).not.toBe(0);
    writeFileSync(join(wt, 'a.txt'), 'clean\n');
    git(wt, 'add', 'a.txt');
    expect(git(wt, 'commit', '-q', '-m', 'clean').status).toBe(0);
  });
});
