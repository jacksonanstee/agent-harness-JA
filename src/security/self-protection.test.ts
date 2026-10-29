import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { CASE_INSENSITIVE_PLATFORM, TOOL_TARGET_FIELDS } from '../internal/tool-targets.js';
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
// protected path denied, a relative name only when it is path-shaped;
// registered first. Real temp dirs, so the symlink cases are real symlinks.

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
mkdirSync(join(home, '.harness', 'sub'), { recursive: true });
writeFileSync(join(home, '.harness', 'settings.json'), '{}');
mkdirSync(join(project, '.harness'));
mkdirSync(join(project, 'skills'));
writeFileSync(join(project, 'notes.md'), 'x');
// A sibling whose name shares the prefix: must NOT be protected (boundary).
mkdirSync(join(project, '.harness-extra'));
// Aliases set up before the run.
symlinkSync(join(home, '.harness', 'settings.json'), join(outside, 'innocent.json'));
symlinkSync(join(home, '.harness'), join(outside, 'cfg'));
symlinkSync(join(home, '.harness', 'sub'), join(outside, 'sublink'));
// A DANGLING link to a protected file that does not exist yet (security review HIGH).
symlinkSync(join(home, '.harness', 'not-yet.json'), join(outside, 'dangling'));
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
  it('is an explicit choice on every table entry: exactly Write, Edit and NotebookEdit write', () => {
    const entries = Object.entries(TOOL_TARGET_FIELDS);
    expect(entries.every(([, t]) => typeof t.writes === 'boolean')).toBe(true);
    expect(entries.filter(([, t]) => t.writes).map(([n]) => n).sort()).toEqual(['Edit', 'NotebookEdit', 'Write']);
    expect(entries.filter(([, t]) => !t.writes).map(([n]) => n).sort()).toEqual([
      'Artifact', 'Bash', 'EnterWorktree', 'Glob', 'Grep', 'Monitor', 'Projects', 'Read', 'Workflow',
    ]);
  });

  it('is false on every command-kind entry (commands are covered by kind)', () => {
    for (const [name, t] of Object.entries(TOOL_TARGET_FIELDS)) {
      if (t.kind === 'command') expect(t.writes, name).toBe(false);
    }
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
    ['Write', 'file_path', `${home}//.harness/./settings.json`],
  ])('denies %s to %s=%s', async (tool, field, path) => {
    await denied(tool, { [field]: path });
  });

  it('denies a tilde path (the SDK may expand it)', async () => {
    await denied('Write', { file_path: '~/.harness/settings.json' });
  });

  it('resolves a relative target against the project directory, not process.cwd()', async () => {
    await denied('Write', { file_path: '.harness/settings.json' });
    await denied('Write', { file_path: 'skills/evil/SKILL.md' });
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

  it.skipIf(!CASE_INSENSITIVE_PLATFORM)('denies case variants on a case-insensitive volume', async () => {
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

  it('denies a write through a DANGLING link whose target would be created in a protected dir', async () => {
    await denied('Write', { file_path: join(outside, 'dangling') });
  });

  it('applies `..` AFTER following a link, as the kernel does', async () => {
    // outside/sublink -> ~/.harness/sub, so sublink/.. is ~/.harness.
    await denied('Write', { file_path: join(outside, 'sublink') + '/../settings.json' });
    // outside/cfg -> ~/.harness, so cfg/../.harness is ~/.harness's parent's .harness = ~/.harness.
    await denied('Write', { file_path: join(outside, 'cfg') + '/../.harness/settings.json' });
  });

  it('denies a target that cannot be resolved (a symlink loop): unresolvable is never "allow"', async () => {
    const d = tmp('sp-loop-');
    symlinkSync(join(d, 'b'), join(d, 'a'));
    symlinkSync(join(d, 'a'), join(d, 'b'));
    await denied('Write', { file_path: join(d, 'a', 'x') });
  });

  it('denies the real-path spelling of a home reached through a symlink (both platforms)', async () => {
    const realHome = tmp('sp-realhome-');
    mkdirSync(join(realHome, '.harness'));
    const linkHome = join(tmp('sp-linkparent-'), 'home');
    symlinkSync(realHome, linkHome);
    const h = selfProtectionHook(buildProtectedRoots({ userDir: linkHome, projectDir: project, skillsDir: null, dbPath: null }));
    await expect(h({ tool: 'Write', args: { file_path: join(realHome, '.harness', 'settings.json') } } as never)).rejects.toThrowError(
      SelfProtectionViolation,
    );
  });
});

describe('negative controls', () => {
  it('allows reading a protected file with the Read tool', async () => {
    await allowed('Read', { file_path: join(home, '.harness', 'settings.json') });
    await allowed('Grep', { path: join(home, '.harness') });
  });

  it('allows writing ordinary project files, a prefix-sharing sibling, and a non-sidecar db neighbour', async () => {
    await allowed('Write', { file_path: join(project, 'notes.md') });
    await allowed('Write', { file_path: join(project, '.harness-extra', 'x') });
    await allowed('Write', { file_path: `${outsideDb}.txt` });
    await allowed('Write', { file_path: join(outside, 'other.db') });
  });

  it('allows unrelated Bash, including bare mentions of the word skills (owner ruling: path-shaped only)', async () => {
    for (const command of [
      'git status',
      'npm run skills-lint',
      'cat .harnessrc',
      'ls myskills',
      'cat foo.harness/x',
      'git commit -m "add skills"',
      'grep skills README.md',
      'npm run build:skills',
      'rm -rf skills',
      'echo .harness',
    ]) {
      await allowed('Bash', { command });
    }
  });

  it("lets Monitor's websocket mode through: no command means nothing to match (architecture H1)", async () => {
    await allowed('Monitor', { ws: { url: 'wss://example.invalid' }, description: 'x' });
  });

  it('ignores tools outside the table', async () => {
    await allowed('WebFetch', { url: 'https://example.invalid' });
  });
});

describe('Bash and Monitor: any path-shaped mention of a protected path (D4)', () => {
  const abs = join(home, '.harness', 'settings.json');
  it.each([
    `cp /tmp/x ${abs}`,
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
    'rm -rf ./skills',
    'rm -rf skills/',
    `python3 -c "open('${abs}','w')"`,
    'rm -rf ~/.harness*',
    // Static spellings the first cut missed (security review MEDIUM).
    'cp x "$HOME"/.harness/settings.json',
    "cp x $HOME'/.harness'/settings.json",
    'cp x ~/./.harness/settings.json',
    'cp x $HOME//.harness/settings.json',
    'cp x ~/.h\\arness/settings.json',
    'cp x ${HOME:-x}/.harness/settings.json',
    'cp x $HOME/Documents/../.harness/settings.json',
    `cp x ${home}/./.harness/settings.json`,
    `cp x ${home}//.harness/settings.json`,
    'cp x ././.harness/settings.json',
    'cp x .//.harness/settings.json',
    'cp x .//skills/evil/SKILL.md',
    `ln -s "$HOME"/.harness/settings.json /tmp/s`,
    `cp x ${join(outside, 'cfg')}/../.harness/settings.json`,
    `cp x ${join(outside, 'dangling')}`,
    // A relative path after `=` is only caught by the path-word check (N21).
    'dd if=/dev/zero of=.harness/telemetry.db',
    'cp --target-directory=./skills/evil x',
  ])('denies %s', async (command) => {
    await denied('Bash', { command });
    await denied('Monitor', { command });
  });

  it('denies a present command that is not a string (fail closed)', async () => {
    await denied('Bash', { command: ['cp', 'x'] });
    await denied('Monitor', { command: 42 });
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

  it('works with the filesystem root as the project directory (code review M3)', async () => {
    const h = selfProtectionHook(buildProtectedRoots({ userDir: home, projectDir: '/', skillsDir: null, dbPath: null }));
    await expect(h({ tool: 'Bash', args: { command: 'echo x > /.harness/settings.json' } } as never)).rejects.toThrowError(
      SelfProtectionViolation,
    );
    await expect(h({ tool: 'Bash', args: { command: 'echo x > .harness/settings.json' } } as never)).rejects.toThrowError(
      SelfProtectionViolation,
    );
    await expect(h({ tool: 'Bash', args: { command: 'cat harness' } } as never)).resolves.toBeUndefined();
  });
});
