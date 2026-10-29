import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { TOOL_TARGET_FIELDS } from '../internal/tool-targets.js';
import {
  buildProtectedRoots,
  SELF_PROTECTION_REASON,
  selfProtectionHook,
  SelfProtectionViolation,
} from './self-protection.js';

// Issue #188 (ADR-0042): a built-in, non-configurable deny on agent writes to
// the harness's own state. Jackson's rulings 29/10/2026: both `.harness`
// directories whole, plus the run's skills root and an outside `--db`; the
// target compared as written AND by real path; any Bash/Monitor mention of a
// protected path denied; registered first. Real temp dirs, so the symlink
// cases are real symlinks.

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

const home = tmp('sp-home-');
const project = tmp('sp-proj-');
const outside = tmp('sp-out-');
mkdirSync(join(home, '.harness'));
writeFileSync(join(home, '.harness', 'settings.json'), '{}');
mkdirSync(join(project, '.harness'));
mkdirSync(join(project, 'skills'));
writeFileSync(join(project, 'notes.md'), 'x');
// A sibling whose name shares the prefix: must NOT be protected (boundary).
mkdirSync(join(project, '.harness-extra'));
// Aliases set up before the run.
symlinkSync(join(home, '.harness', 'settings.json'), join(outside, 'innocent.json'));
symlinkSync(join(home, '.harness'), join(outside, 'cfg'));
const outsideDb = join(outside, 'tel.db');

const roots = buildProtectedRoots({
  userDir: home,
  projectDir: project,
  skillsDir: join(project, 'skills'),
  dbPath: outsideDb,
});
const hook = selfProtectionHook(roots);
const call = (tool: string, args: Record<string, unknown>) => hook({ tool, args } as never);
const denied = (tool: string, args: Record<string, unknown>) =>
  expect(call(tool, args)).rejects.toThrowError(SelfProtectionViolation);
const allowed = (tool: string, args: Record<string, unknown>) => expect(call(tool, args)).resolves.toBeUndefined();

describe('the writes marker (D2)', () => {
  it('marks exactly the SDK tools that write a local file', () => {
    const writers = Object.entries(TOOL_TARGET_FIELDS)
      .filter(([, t]) => t.writes === true)
      .map(([name]) => name)
      .sort();
    expect(writers).toEqual(['Edit', 'NotebookEdit', 'Write']);
  });
});

describe('write tools (D1, D2)', () => {
  it.each([
    ['Write', 'file_path', join(home, '.harness', 'settings.json')],
    ['Edit', 'file_path', join(home, '.harness', 'settings.json')],
    ['NotebookEdit', 'notebook_path', join(project, '.harness', 'x.ipynb')],
    ['Write', 'file_path', join(home, '.harness', 'new-file.json')],
    ['Write', 'file_path', join(project, '.harness', 'telemetry.db')],
    ['Write', 'file_path', join(project, 'skills', 'evil', 'SKILL.md')],
    ['Write', 'file_path', `${outsideDb}-wal`],
    ['Write', 'file_path', outsideDb],
    ['Write', 'file_path', join(project, 'skills', '..', '.harness', 'settings.json')],
    ['Write', 'file_path', join(home, '.harness')],
  ])('denies %s to %s=%s', async (tool, field, path) => {
    await denied(tool, { [field]: path });
  });

  it('denies a tilde path (the SDK may expand it)', async () => {
    await denied('Write', { file_path: '~/.harness/settings.json' });
  });

  it('denies with the fixed reason, which never echoes the path (ADR-0031)', async () => {
    const path = join(home, '.harness', 'settings.json');
    await expect(call('Write', { file_path: path })).rejects.toThrow(SELF_PROTECTION_REASON);
    await expect(call('Write', { file_path: path })).rejects.not.toThrow(home);
  });

  it('denies a writer call whose target is not a string (fail closed)', async () => {
    await denied('Write', { file_path: 42 });
    await denied('Edit', {});
  });

  it('denies case variants on a case-insensitive volume', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return;
    await denied('Write', { file_path: join(home, '.HARNESS', 'Settings.JSON') });
  });
});

describe('aliases (D3: as written and by real path)', () => {
  it('denies a write through a pre-existing file symlink', async () => {
    await denied('Write', { file_path: join(outside, 'innocent.json') });
  });

  it('denies a new file under a symlinked alias of the directory', async () => {
    await denied('Write', { file_path: join(outside, 'cfg', 'brand-new.json') });
  });

  it('denies the real-path spelling of a protected dir (macOS /var -> /private/var)', async () => {
    await denied('Write', { file_path: join(realpathSync(home), '.harness', 'settings.json') });
  });
});

describe('negative controls', () => {
  it('allows reading a protected file with the Read tool', async () => {
    await allowed('Read', { file_path: join(home, '.harness', 'settings.json') });
    await allowed('Grep', { path: join(home, '.harness') });
  });

  it('allows writing ordinary project files and a prefix-sharing sibling', async () => {
    await allowed('Write', { file_path: join(project, 'notes.md') });
    await allowed('Write', { file_path: join(project, '.harness-extra', 'x') });
    // The DB's sidecars are named (-wal, -shm, -journal), not prefix-matched.
    await allowed('Write', { file_path: `${outsideDb}.txt` });
    await allowed('Write', { file_path: join(outside, 'other.db') });
  });

  it('allows unrelated Bash', async () => {
    await allowed('Bash', { command: 'git status' });
    await allowed('Bash', { command: 'npm run skills-lint' });
    await allowed('Bash', { command: 'cat .harnessrc' });
  });

  it('ignores tools outside the table', async () => {
    await allowed('WebFetch', { url: 'https://example.invalid' });
  });
});

describe('Bash and Monitor: any mention of a protected path (D4)', () => {
  it.each([
    `cp /tmp/x ${join(home, '.harness', 'settings.json')}`,
    'echo {} > ~/.harness/settings.json',
    'echo {} >>~/.harness/settings.json',
    'tee $HOME/.harness/settings.json',
    'sed -i s/1/9/ ${HOME}/.harness/settings.json',
    'mv x .harness/settings.json',
    'cp x ./.harness/telemetry.db',
    `dd if=/dev/zero of=${outsideDb}`,
    `ln -s /tmp/evil ${join(project, 'skills', 'evil')}`,
    'cd ~/.harness && cp /tmp/x settings.json',
    'cat ~/.harness/settings.json',
    'rm -rf skills',
    `python3 -c "open('${join(home, '.harness', 'settings.json')}','w')"`,
    `cat ${join(realpathSync(home), '.harness', 'settings.json')}`,
  ])('denies %s', async (command) => {
    await denied('Bash', { command });
    await denied('Monitor', { command });
  });

  it('denies a non-string command (fail closed)', async () => {
    await denied('Bash', { command: ['cp', 'x'] });
  });
});

describe('buildProtectedRoots', () => {
  it('skips an in-memory database and a null skills root', () => {
    const r = buildProtectedRoots({ userDir: home, projectDir: project, skillsDir: null, dbPath: ':memory:' });
    const h = selfProtectionHook(r);
    return expect(h({ tool: 'Write', args: { file_path: join(project, 'skills', 'x') } } as never)).resolves.toBeUndefined();
  });

  it('protects a skills root and db that do not exist yet', async () => {
    const r = buildProtectedRoots({
      userDir: home,
      projectDir: project,
      skillsDir: join(outside, 'not-yet'),
      dbPath: join(outside, 'later', 'x.db'),
    });
    const h = selfProtectionHook(r);
    await expect(h({ tool: 'Write', args: { file_path: join(outside, 'not-yet', 'a') } } as never)).rejects.toThrowError(
      SelfProtectionViolation,
    );
    await expect(h({ tool: 'Write', args: { file_path: join(outside, 'later', 'x.db-shm') } } as never)).rejects.toThrowError(
      SelfProtectionViolation,
    );
  });
});
