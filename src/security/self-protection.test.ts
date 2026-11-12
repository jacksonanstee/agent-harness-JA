import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { SCHEDULED_TASKS_FILE } from '../internal/child-env.js';
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
// target compared as written AND by real path; any Bash mention of a
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

const configDir = tmp('sp-cfg-');
const roots = buildProtectedRoots({
  userDir: home,
  projectDir: project,
  skillsDir: join(project, 'skills'),
  dbPath: outsideDb,
  claudeConfigDir: configDir,
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
      'Bash', 'EnterWorktree', 'Glob', 'Grep', 'Projects', 'Read', 'Workflow',
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

  it('caps the TOTAL symlink hops per path, so a doubling link tree cannot hang the hook (parity H1)', async () => {
    const d = tmp('sp-dos-');
    symlinkSync('.', join(d, 'L0'));
    for (let n = 1; n <= 24; n += 1) symlinkSync(`L${n - 1}/L${n - 1}`, join(d, `L${n}`));
    const started = Date.now();
    await denied('Write', { file_path: join(d, 'L24', 'x') });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('counts hops across NESTED links against one budget: 53 hops in a shallow tree is ELOOP (mutation N31)', async () => {
    // L0 -> .; L1 -> L0/L0/... (25 times); L2 -> L1/L1. Resolving L2 follows
    // 1 + 2 * (1 + 25) = 53 links, though no branch nests deeper than 3.
    const d = tmp('sp-wide-');
    symlinkSync('.', join(d, 'L0'));
    symlinkSync(Array.from({ length: 25 }, () => 'L0').join('/'), join(d, 'L1'));
    symlinkSync('L1/L1', join(d, 'L2'));
    await denied('Write', { file_path: join(d, 'L2', 'x') });
  });

  it('denies a path through more than 40 links in total, as the kernel would (ELOOP)', async () => {
    const d = tmp('sp-chain-');
    mkdirSync(join(d, 'real'));
    // Each real/sN -> real, so real/s0/s1/.../s40 follows 41 links in turn.
    for (let n = 0; n < 41; n += 1) symlinkSync(join(d, 'real'), join(d, 'real', `s${n}`));
    const path = [join(d, 'real'), ...Array.from({ length: 41 }, (_, n) => `s${n}`)].join('/');
    await denied('Write', { file_path: `${path}/x` });
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

// Issue #254 (ADR-0042 as amended 13/11/2026): the bundled CLI reads durable scheduled jobs from
// `<cwd>/.claude/scheduled_tasks.json` and sends each due job's prompt to the model as a user
// turn. The harness turns that off in its own children; the deny stops the agent planting one
// for any other Claude Code session started in the same directory.
describe('the scheduled-tasks file (#254)', () => {
  const planted = join(project, '.claude', 'scheduled_tasks.json');

  it('is the file name the CLI reads', () => {
    expect(SCHEDULED_TASKS_FILE).toBe('scheduled_tasks.json');
  });

  it.each(['Write', 'Edit'])('denies %s to it, absolute and relative', async (tool) => {
    await denied(tool, { file_path: planted });
    await denied(tool, { file_path: '.claude/scheduled_tasks.json' });
    await denied(tool, { file_path: './.claude/../.claude/scheduled_tasks.json' });
  });

  it('denies NotebookEdit to it', async () => {
    await denied('NotebookEdit', { notebook_path: planted });
  });

  it('denies a Bash command that names it, absolute, relative or through a redirect', async () => {
    await denied('Bash', { command: `echo '{}' > ${planted}` });
    await denied('Bash', { command: 'mkdir -p .claude && cp /tmp/x .claude/scheduled_tasks.json' });
    await denied('Bash', { command: 'tee .claude/scheduled_tasks.json < /tmp/x' });
  });

  it('denies a write through a symlink set up before the call', async () => {
    mkdirSync(join(project, '.claude'), { recursive: true });
    symlinkSync(planted, join(outside, 'tasks-alias.json'));
    await denied('Write', { file_path: join(outside, 'tasks-alias.json') });
  });

  it('protects the file, not the directory: its neighbours and a prefix-sharing name stay writable', async () => {
    await allowed('Write', { file_path: join(project, '.claude', 'settings.local.json') });
    await allowed('Write', { file_path: join(project, '.claude', 'scheduled_tasks.json.bak') });
    await allowed('Write', { file_path: join(project, '.claude', 'my-scheduled_tasks.json') });
    await allowed('Read', { file_path: planted });
  });

  it('is protected whatever the skills root and db are', async () => {
    const bare = selfProtectionHook(buildProtectedRoots({ userDir: home, projectDir: project, skillsDir: null, dbPath: null }));
    await expect(bare({ tool: 'Write', args: { file_path: planted } } as never)).rejects.toThrowError(SelfProtectionViolation);
  });
});

// Review of #254 (code, architecture and security lenses, 13/11/2026): a file root had no bare-word
// coverage, so `cd .claude && echo {} > scheduled_tasks.json` passed. The rule now is by NAME: a
// writer target or a Bash path word whose last component folds (case) to a protected file's name
// is refused wherever it points. It also covers the same file under a subdirectory, which a later
// session started there would read.
describe('a protected file is refused by name, wherever the path points (#254 review)', () => {
  it.each([
    'cd .claude && echo {} > scheduled_tasks.json',
    'cd .claude; cp /tmp/x scheduled_tasks.json',
    'pushd .claude; tee scheduled_tasks.json',
    '(cd alias && cp /tmp/x scheduled_tasks.json)',
    'cd .claude && echo {} >scheduled_tasks.json',
    'cd .claude && echo {} >>scheduled_tasks.json',
    'cd .claude && cp /tmp/x SCHEDULED_TASKS.JSON',
    'cd .claude && cp /tmp/x "scheduled_tasks.json"',
    "cd .claude && cp /tmp/x 'scheduled_tasks.json'",
    'cd .claude && dd if=/tmp/x of=scheduled_tasks.json',
    'cp /tmp/x sub/.claude/scheduled_tasks.json',
    'cp /tmp/x /somewhere/else/scheduled_tasks.json',
    'cd .claude && mv tmp.json ./scheduled_tasks.json',
    'cat scheduled_tasks.json',
    `cd ${outside} && cp /tmp/x tel.db`,
    `cd ${outside} && rm tel.db-wal`,
    `cd ${outside} && sqlite3 TEL.DB 'delete from events'`,
  ])('denies %s', async (command) => {
    await denied('Bash', { command });
  });

  it.each(['Write', 'Edit'])('denies %s to the scheduled-tasks file under any directory, in any letter case', async (tool) => {
    await denied(tool, { file_path: join(project, 'sub', '.claude', 'scheduled_tasks.json') });
    await denied(tool, { file_path: join(project, 'scheduled_tasks.json') });
    await denied(tool, { file_path: join(outside, 'x', 'Scheduled_Tasks.JSON') });
    await denied(tool, { file_path: 'scheduled_tasks.json' });
  });

  // Mutation M13: a trailing separator must not hide the name.
  it('denies the name with a trailing slash, in a writer target and in a Bash word', async () => {
    await denied('Write', { file_path: `${join(project, 'sub', 'scheduled_tasks.json')}/` });
    await denied('Bash', { command: 'cd .claude && cp /tmp/x ./scheduled_tasks.json/' });
  });

  it('denies a writer target named like the outside database or a sidecar of it', async () => {
    await denied('Write', { file_path: join(project, 'tel.db') });
    await denied('Write', { file_path: join(project, 'deep', 'tel.db-shm') });
    await denied('NotebookEdit', { notebook_path: join(project, 'TEL.db-journal') });
  });

  it('does not take the name of a database INSIDE a protected directory: only the directory protects it', async () => {
    const inside = buildProtectedRoots({ userDir: home, projectDir: project, skillsDir: null, dbPath: join(project, '.harness', 'telemetry.db'), claudeConfigDir: null });
    const h = selfProtectionHook(inside);
    await expect(h({ tool: 'Write', args: { file_path: join(project, 'data', 'telemetry.db') } } as never)).resolves.toBeUndefined();
    await expect(h({ tool: 'Bash', args: { command: 'cd data && cp /tmp/x telemetry.db' } } as never)).resolves.toBeUndefined();
    await expect(h({ tool: 'Write', args: { file_path: join(project, '.harness', 'telemetry.db') } } as never)).rejects.toThrowError(SelfProtectionViolation);
  });

  it('leaves other names alone: a longer name, the name inside quoted prose, and a read by the Read tool', async () => {
    await allowed('Bash', { command: 'cp /tmp/x scheduled_tasks.json.bak' });
    await allowed('Bash', { command: 'cp /tmp/x my-scheduled_tasks.json' });
    await allowed('Bash', { command: 'git commit -m "document scheduled_tasks.json handling"' });
    await allowed('Bash', { command: 'cp /tmp/x other.db' });
    await allowed('Write', { file_path: join(project, 'scheduled_tasks.json.md') });
    await allowed('Read', { file_path: join(project, 'sub', '.claude', 'scheduled_tasks.json') });
  });
});

// Security review of #254/#255 (13/11/2026): the bundled CLI delivers the project's auto-memory index
// to the model at the start of a session and let the agent write it with no grant. The harness turns
// auto-memory off in its own children; the deny stops the agent leaving a note for any other session.
// The index is <config dir>/projects/<project slug>/memory/MEMORY.md; the whole `projects` directory
// is protected, so the rule does not depend on how the CLI builds the slug.
describe('the auto-memory directory (#254/#255 security review)', () => {
  const underHome = join(home, '.claude', 'projects', '-some-project', 'memory', 'MEMORY.md');
  const underConfig = join(configDir, 'projects', '-some-project', 'memory', 'MEMORY.md');

  it.each(['Write', 'Edit'])('denies %s under ~/.claude/projects and under the named config directory', async (tool) => {
    await denied(tool, { file_path: underHome });
    await denied(tool, { file_path: underConfig });
    await denied(tool, { file_path: '~/.claude/projects/-p/memory/notes.md' });
    await denied(tool, { file_path: join(configDir, 'projects', 'new-slug', 'memory', 'MEMORY.md') });
  });

  it.each([
    `echo note > ${underHome}`,
    `echo note > ${underConfig}`,
    'echo note > ~/.claude/projects/-p/memory/MEMORY.md',
    'echo note >> $HOME/.claude/projects/-p/memory/MEMORY.md',
    'cd ~/.claude/projects/-p/memory && echo note > MEMORY.md',
    'cd ~/.claude && echo note > projects/-p/memory/MEMORY.md',
    `cd ${configDir} && mkdir -p projects/-p/memory && cp /tmp/x projects/-p/memory/MEMORY.md`,
    'cd ~/.claude && tee ./projects/-p/memory/topic.md',
  ])('denies %s', async (command) => {
    await denied('Bash', { command });
  });

  it('protects only that directory: the rest of the config directory, and a project folder of the same name, stay writable', async () => {
    await allowed('Write', { file_path: join(home, '.claude', 'notes.md') });
    await allowed('Write', { file_path: join(configDir, 'notes.md') });
    await allowed('Write', { file_path: join(project, 'projects', 'readme.md') });
    await allowed('Write', { file_path: join(project, 'memory', 'MEMORY.md') });
    await allowed('Bash', { command: 'ls projects' });
    await allowed('Bash', { command: 'cat memory/notes.md' });
    await allowed('Read', { file_path: underHome });
  });

  it('reads CLAUDE_CONFIG_DIR when no config directory is passed, and always protects the one under the user directory', async () => {
    const previous = process.env['CLAUDE_CONFIG_DIR'];
    const fromEnv = tmp('sp-envcfg-');
    process.env['CLAUDE_CONFIG_DIR'] = fromEnv;
    try {
      const h = selfProtectionHook(buildProtectedRoots({ userDir: home, projectDir: project, skillsDir: null, dbPath: null }));
      await expect(h({ tool: 'Write', args: { file_path: join(fromEnv, 'projects', 's', 'memory', 'MEMORY.md') } } as never)).rejects.toThrowError(SelfProtectionViolation);
      await expect(h({ tool: 'Write', args: { file_path: underHome } } as never)).rejects.toThrowError(SelfProtectionViolation);
      await expect(h({ tool: 'Write', args: { file_path: underConfig } } as never)).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
      else process.env['CLAUDE_CONFIG_DIR'] = previous;
    }
  });

  it('an empty CLAUDE_CONFIG_DIR is read as unset, not as the working directory', async () => {
    const previous = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = '';
    try {
      const h = selfProtectionHook(buildProtectedRoots({ userDir: home, projectDir: project, skillsDir: null, dbPath: null }));
      await expect(h({ tool: 'Write', args: { file_path: join(project, 'projects', 'readme.md') } } as never)).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
      else process.env['CLAUDE_CONFIG_DIR'] = previous;
    }
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

  it('allows unrelated Bash, and the word skills inside quoted text with a space (owner ruling: a bare word, quoted or not, is a path)', async () => {
    for (const command of [
      'git status',
      'npm run skills-lint',
      'cat .harnessrc',
      'ls myskills',
      'cat foo.harness/x',
      'git commit -m "add skills"',
      'echo "skills: done"',
      'npm run build:skills',
      'grep -r "update the skills list" docs',
      'ls -la',
      'git log -n5',
      'tar -xzf a.tgz',
      'gcc -O2 -Wall -o out main.c',
    ]) {
      await allowed('Bash', { command });
    }
  });

  it('lets a command tool with no command through: nothing to match (architecture H1)', async () => {
    await allowed('Bash', { description: 'x' });
  });

  // #248: Monitor left the table (the tool-name deny refuses it by name, in every mode), so this
  // hook no longer reads its command. Pinned so re-adding a table entry is a visible act.
  it('does not see Monitor: it is outside the table since #248', async () => {
    await allowed('Monitor', { command: `cp /tmp/x ${join(home, '.harness', 'settings.json')}` });
    await allowed('Monitor', { command: 42 });
    await allowed('Monitor', { ws: { url: 'wss://example.invalid' }, description: 'x' });
  });

  it('ignores tools outside the table', async () => {
    await allowed('WebFetch', { url: 'https://example.invalid' });
  });
});

describe('Bash: any path-shaped mention of a protected path (D4)', () => {
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
    // A bare word, quoted or not, is the folder (owner ruling, revised 29/10): a bare
    // destination writes (security re-check).
    'cp -r /tmp/evil skills',
    'mv /tmp/evil skills',
    'tar -xf x.tar -C .harness',
    'cp /tmp/s .harness',
    'rm -rf skills',
    "cp -r /tmp/evil 'skills'",
    'cp -r /tmp/evil --target-directory=skills',
    // `=` inside a later component, and every HOME form (security re-check).
    'cp x skills/x=1/SKILL.md',
    'cp x .harness/a=settings.json',
    'cp x ${HOME%/}/.harness/settings.json',
    'cp x ${HOME:0}/.harness/settings.json',
    'cp x ${HOME/x/y}/.harness/settings.json',
    'cp x ${HOME:-${HOME}}/.harness/settings.json',
    'cp x ~+/.harness/settings.json',
    "cp x ~/$'.harness'/settings.json",
    // A short option glued to its value (parity re-check N2).
    'sort -o.harness/settings.json x',
    'curl -o.harness/settings.json https://e.invalid',
    'tar -xf a.tar -C.harness',
    'cp -t.harness x',
    'cp -tskills x',
    'cp -rt.harness x',
    'tar -xfC.harness a',
    // A path glued to an earlier token by a comma inside quoted code (parity M2).
    `python3 -c "import shutil; shutil.copy('/tmp/x','.harness/settings.json')"`,
    `python3 -c "import os; os.symlink('/tmp/x','skills/evil')"`,
    `python3 -c "import shutil; shutil.copy('/tmp/x','${join(outside, 'cfg')}/settings.json')"`,
  ])('denies %s', async (command) => {
    await denied('Bash', { command });
  });

  it('denies a present command that is not a string (fail closed)', async () => {
    await denied('Bash', { command: ['cp', 'x'] });
    await denied('Bash', { command: 42 });
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
