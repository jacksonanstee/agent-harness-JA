import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CHILD_ENV_NAME_POLICY } from '../internal/child-env.js';
import type { SettingsEnvFile } from './settings-env.js';
import { GLOBAL_CONFIRM_MS, GLOBAL_REREAD_MIN_MS, GLOBAL_WATCHED_KEYS, GLOBAL_WATCHED_PROJECT_KEYS, NODE_SNAPSHOT_IO, settingsFingerprint, takeSettingsSnapshot, UNKNOWN_BASELINE } from './settings-snapshot.js';
import type { SettingsSnapshotIo, SnapshotStats } from './settings-snapshot.js';

// Issue #264. The snapshot is what the session compares the CLI's settings files with for the whole run.
// Real files in a temporary directory; the io seam counts calls, skips the confirming wait and pins stat fields.

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ssnap-'));
/** The real io with the wait recorded, not slept. */
function io(overrides: Partial<SettingsSnapshotIo> = {}): SettingsSnapshotIo & { sleeps: number[]; opens: string[]; clock: { ms: number } } {
  const sleeps: number[] = [];
  const opens: string[] = [];
  // A clock the test moves: the limit on re-reading a global config file reads it.
  const clock = { ms: 1_000_000 };
  return {
    ...NODE_SNAPSHOT_IO,
    openSync: (path, flags) => (opens.push(path), NODE_SNAPSHOT_IO.openSync(path, flags)),
    sleepSync: (ms) => void sleeps.push(ms),
    now: () => clock.ms,
    ...overrides,
    sleeps,
    opens,
    clock,
  };
}
const sha = (data: string): string => createHash('sha256').update(data).digest('hex');
const OPTIONS = { policy: CHILD_ENV_NAME_POLICY };
const HOOKS = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] } });

interface Tree {
  root: string;
  user: SettingsEnvFile;
  project: SettingsEnvFile;
  global: SettingsEnvFile;
  dropIns: string;
  files: SettingsEnvFile[];
}
function tree(): Tree {
  const root = tmp();
  mkdirSync(join(root, 'cfg'));
  mkdirSync(join(root, 'proj'));
  mkdirSync(join(root, 'managed', 'managed-settings.d'), { recursive: true });
  const user: SettingsEnvFile = { source: 'user', path: join(root, 'cfg', 'settings.json') };
  const project: SettingsEnvFile = { source: 'project', path: join(root, 'proj', '.claude', 'settings.json') };
  const global: SettingsEnvFile = { source: 'global', path: join(root, 'cfg', '.claude.json') };
  return { root, user, project, global, dropIns: join(root, 'managed', 'managed-settings.d'), files: [global, user, project] };
}
/** The snapshot, with `changed()` as the first difference on a forced check: most tests change one thing. */
const snap = (t: Tree, seam: SettingsSnapshotIo = io()) => {
  const s = takeSettingsSnapshot(t.files, t.dropIns, { ...OPTIONS, io: seam });
  return { ...s, changed: () => s.changes(true)[0] ?? null };
};

describe('takeSettingsSnapshot (#264): an untouched tree is no change', () => {
  it('reports nothing, and counts the files it compares', () => {
    const t = tree();
    writeFileSync(t.user.path, '{"model":"x"}');
    const s = snap(t);
    expect(s.size).toBe(3);
    expect(s.changed()).toBeNull();
    expect(s.changed()).toBeNull();
  });

  it('a check of an untouched tree opens no file: the stat fields are the pre-filter', () => {
    const t = tree();
    writeFileSync(t.user.path, '{"model":"x"}');
    writeFileSync(t.global.path, '{"numStartups":1}');
    const seam = io();
    const s = snap(t, seam);
    const opensAtSnapshot = seam.opens.length;
    expect(opensAtSnapshot).toBeGreaterThan(0);
    for (let i = 0; i < 5; i += 1) expect(s.changed()).toBeNull();
    expect(seam.opens.length).toBe(opensAtSnapshot);
  });

  it('the budget of a check of an untouched tree: one lstat and one realpath per existing path, one lstat per absent one, one listing', () => {
    const t = tree();
    writeFileSync(t.user.path, '{"model":"x"}');
    const calls = { lstat: 0, stat: 0, realpath: 0, readlink: 0, readdir: 0 };
    const seam = io({
      lstatSync: (path) => ((calls.lstat += 1), NODE_SNAPSHOT_IO.lstatSync(path)),
      statSync: (path) => ((calls.stat += 1), NODE_SNAPSHOT_IO.statSync(path)),
      realpathSync: (path) => ((calls.realpath += 1), NODE_SNAPSHOT_IO.realpathSync(path)),
      readlinkSync: (path) => ((calls.readlink += 1), NODE_SNAPSHOT_IO.readlinkSync(path)),
      readdirSync: (path) => ((calls.readdir += 1), NODE_SNAPSHOT_IO.readdirSync(path)),
    });
    const s = snap(t, seam);
    for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key] = 0;
    expect(s.changed()).toBeNull();
    // Three paths, one of which exists.
    expect(calls).toEqual({ lstat: 3, stat: 0, realpath: 1, readlink: 0, readdir: 1 });
  });

  it('a directory appearing where a settings file is looked for is not a change, and neither is the directory above one', () => {
    const t = tree();
    const s = snap(t);
    mkdirSync(join(t.root, 'proj', '.claude'));
    expect(s.changed()).toBeNull();
    mkdirSync(t.user.path);
    expect(s.changed()).toBeNull();
  });
});

describe('takeSettingsSnapshot (#264): each compared attribute, on its own', () => {
  it('appearance: a file where there was none', () => {
    const t = tree();
    const s = snap(t);
    mkdirSync(join(t.root, 'proj', '.claude'));
    writeFileSync(t.project.path, HOOKS);
    expect(s.changed()).toMatchObject({ source: 'project', path: t.project.path, kind: 'appeared' });
  });

  it('appearance through a directory copied, moved or linked into place: the call never names the file', () => {
    const t = tree();
    mkdirSync(join(t.root, 'proj', 'pstage'));
    writeFileSync(join(t.root, 'proj', 'pstage', 'settings.json'), HOOKS);
    const moved = snap(t);
    renameSync(join(t.root, 'proj', 'pstage'), join(t.root, 'proj', '.claude'));
    expect(moved.changed()).toMatchObject({ path: t.project.path, kind: 'appeared' });
    renameSync(join(t.root, 'proj', '.claude'), join(t.root, 'proj', 'pstage'));
    const linked = snap(t);
    symlinkSync('pstage', join(t.root, 'proj', '.claude'));
    expect(linked.changed()).toMatchObject({ path: t.project.path, kind: 'appeared' });
  });

  it('deletion: a file that is gone', () => {
    const t = tree();
    writeFileSync(t.user.path, '{"permissions":{"deny":["Bash"]}}');
    const s = snap(t);
    rmSync(t.user.path);
    expect(s.changed()).toMatchObject({ source: 'user', path: t.user.path, kind: 'deleted' });
  });

  it('content: different bytes', () => {
    const t = tree();
    writeFileSync(t.user.path, '{"model":"x"}');
    const s = snap(t);
    writeFileSync(t.user.path, HOOKS);
    const change = s.changed();
    expect(change).toMatchObject({ source: 'user', path: t.user.path, kind: 'content' });
    expect(change?.fingerprint).toBe(`file||sha256:${sha(HOOKS)}`);
    expect(change?.baseline).toBe(`file||sha256:${sha('{"model":"x"}')}`);
  });

  it('content: the same size with the modification time put back is still seen, through the change time', () => {
    const t = tree();
    writeFileSync(t.user.path, '{"model":"aaaa"}');
    const before = NODE_SNAPSHOT_IO.lstatSync(t.user.path);
    const s = snap(t);
    writeFileSync(t.user.path, '{"model":"bbbb"}');
    const seconds = Number(before.mtimeNs) / 1e9;
    utimesSync(t.user.path, seconds, seconds);
    const after = NODE_SNAPSHOT_IO.lstatSync(t.user.path);
    expect(after.size).toBe(before.size);
    expect(s.changed()).toMatchObject({ path: t.user.path, kind: 'content' });
  });

  it('content: with EVERY stat field held as it was, the bytes are not read, which is what the pre-filter gives up', () => {
    const t = tree();
    writeFileSync(t.user.path, '{"model":"aaaa"}');
    const frozen = NODE_SNAPSHOT_IO.lstatSync(t.user.path);
    const pinned = (path: string, real: SnapshotStats): SnapshotStats => (path === t.user.path ? frozen : real);
    const seam = io({ lstatSync: (path) => pinned(path, NODE_SNAPSHOT_IO.lstatSync(path)), statSync: (path) => pinned(path, NODE_SNAPSHOT_IO.statSync(path)) });
    const s = snap(t, seam);
    writeFileSync(t.user.path, '{"model":"bbbb"}');
    expect(s.changed()).toBeNull();
  });

  it('kind: a file that became a symlink to a file with the same bytes', () => {
    const t = tree();
    writeFileSync(t.user.path, HOOKS);
    writeFileSync(join(t.root, 'elsewhere.json'), HOOKS);
    const s = snap(t);
    rmSync(t.user.path);
    symlinkSync(join(t.root, 'elsewhere.json'), t.user.path);
    expect(s.changed()).toMatchObject({ path: t.user.path, kind: 'kind' });
  });

  it('symlink target: a link pointed at another file with the same bytes', () => {
    const t = tree();
    writeFileSync(join(t.root, 'a.json'), HOOKS);
    writeFileSync(join(t.root, 'b.json'), HOOKS);
    symlinkSync(join(t.root, 'a.json'), t.user.path);
    const s = snap(t);
    rmSync(t.user.path);
    symlinkSync(join(t.root, 'b.json'), t.user.path);
    expect(s.changed()).toMatchObject({ path: t.user.path, kind: 'symlink-target' });
  });

  it('symlink target: a link that points at nothing, pointed at another missing file (only the link text differs)', () => {
    const t = tree();
    symlinkSync(join(t.root, 'missing-a.json'), t.user.path);
    const s = snap(t);
    expect(s.changed()).toBeNull();
    rmSync(t.user.path);
    symlinkSync(join(t.root, 'missing-b.json'), t.user.path);
    expect(s.changed()).toMatchObject({ path: t.user.path, kind: 'symlink-target' });
  });

  it('symlink target: the directory above the file swapped for a link to a directory holding the same bytes', () => {
    const t = tree();
    mkdirSync(join(t.root, 'proj', '.claude'));
    writeFileSync(t.project.path, HOOKS);
    mkdirSync(join(t.root, 'proj', 'twin'));
    writeFileSync(join(t.root, 'proj', 'twin', 'settings.json'), HOOKS);
    const s = snap(t);
    renameSync(join(t.root, 'proj', '.claude'), join(t.root, 'proj', 'old'));
    symlinkSync('twin', join(t.root, 'proj', '.claude'));
    expect(s.changed()).toMatchObject({ path: t.project.path, kind: 'symlink-target' });
  });

  it('drop-in listing: a name added to the managed drop-in directory, and the directory itself appearing', () => {
    const t = tree();
    const s = snap(t);
    writeFileSync(join(t.dropIns, '10-new.json'), '{}');
    expect(s.changed()).toMatchObject({ source: 'managed', path: t.dropIns, kind: 'drop-in-listing' });
    const late = join(t.root, 'managed', 'later.d');
    const absent = takeSettingsSnapshot([], late, { ...OPTIONS, io: io() });
    expect(absent.changes()).toEqual([]);
    mkdirSync(late);
    expect(absent.changes()).toMatchObject([{ kind: 'drop-in-listing', baseline: 'listing|unlistable' }]);
  });
});

describe('takeSettingsSnapshot (#264): the global config file is compared by what the scan reads from it', () => {
  it("the CLI's own rewrite is no change: the file created, then rewritten with other keys, with and without an untouched env object", () => {
    const t = tree();
    const s = snap(t);
    writeFileSync(t.global.path, JSON.stringify({ numStartups: 1, projects: {} }));
    expect(s.changed()).toBeNull();
    writeFileSync(t.global.path, JSON.stringify({ numStartups: 2, projects: { '/x': { lastCost: 1 } }, userID: 'u' }));
    expect(s.changed()).toBeNull();

    const kept = tree();
    writeFileSync(kept.global.path, JSON.stringify({ env: { B: '2', A: '1' }, numStartups: 1 }));
    const k = snap(kept);
    writeFileSync(kept.global.path, JSON.stringify({ numStartups: 9, env: { A: '1', B: '2' } }));
    expect(k.changed()).toBeNull();
  });

  it('an env key added to it is a change, confirmed by a second read after the wait', () => {
    const t = tree();
    writeFileSync(t.global.path, JSON.stringify({ numStartups: 1 }));
    const seam = io();
    const s = snap(t, seam);
    writeFileSync(t.global.path, JSON.stringify({ numStartups: 1, env: { PROBE_MARK: 'g' } }));
    const change = s.changed();
    expect(change).toMatchObject({ source: 'global', path: t.global.path, kind: 'global-config' });
    expect(change?.fingerprint).toBe(`verdict:pass|keys:${sha('{"env":{"PROBE_MARK":"g"}}')}`);
    expect(change?.baseline).toBe('verdict:pass|keys:none');
    expect(seam.sleeps).toEqual([GLOBAL_CONFIRM_MS]);
  });

  it('an env value changed, an env key removed, and a name the scan refuses are each a change', () => {
    const base = { env: { A: '1' } };
    for (const next of [{ env: { A: '2' } }, { env: {} }, {}, { env: { A: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } }]) {
      const t = tree();
      writeFileSync(t.global.path, JSON.stringify(base));
      const s = snap(t);
      writeFileSync(t.global.path, JSON.stringify(next));
      expect(s.changed(), JSON.stringify(next)).toMatchObject({ kind: 'global-config' });
    }
  });

  it('a read that lands in the middle of a rewrite does not stop the run: the difference must survive the confirming read', () => {
    const t = tree();
    const whole = JSON.stringify({ numStartups: 1, env: { A: '1' } });
    writeFileSync(t.global.path, whole);
    // The wait is where the writer finishes: the first read sees half a file, the confirming read the whole one.
    const seam = io({ sleepSync: () => writeFileSync(t.global.path, whole) });
    const s = snap(t, seam);
    writeFileSync(t.global.path, whole.slice(0, 12));
    expect(s.changed()).toBeNull();
    writeFileSync(t.global.path, whole.slice(0, 12));
    const torn = takeSettingsSnapshot([t.global], t.dropIns, { ...OPTIONS, io: io() });
    writeFileSync(t.global.path, whole);
    expect(torn.changes(true)).toMatchObject([{ kind: 'global-config' }]);
  });

  it('a global config file that is not JSON is compared by its bytes, so a change to it is never invisible', () => {
    const t = tree();
    writeFileSync(t.global.path, '{ not json');
    const s = snap(t);
    expect(s.changed()).toBeNull();
    writeFileSync(t.global.path, '{ not json, env PROBE');
    expect(s.changed()).toMatchObject({ kind: 'global-config' });
  });
});

describe('takeSettingsSnapshot (#264): every difference is reported, each with its start-of-run state', () => {
  it('two files changed before one check are both returned, in list order, with the drop-in listing last', () => {
    const t = tree();
    writeFileSync(t.user.path, '{"model":"x"}');
    const s = snap(t);
    writeFileSync(t.user.path, HOOKS);
    mkdirSync(join(t.root, 'proj', '.claude'));
    writeFileSync(t.project.path, HOOKS);
    writeFileSync(t.global.path, JSON.stringify({ env: { X: '1' } }));
    writeFileSync(join(t.dropIns, 'z.json'), '{}');
    expect(s.changes(true)).toEqual([
      { source: 'global', path: t.global.path, kind: 'global-config', fingerprint: `verdict:pass|keys:${sha('{"env":{"X":"1"}}')}`, baseline: 'verdict:pass|keys:none' },
      { source: 'user', path: t.user.path, kind: 'content', fingerprint: `file||sha256:${sha(HOOKS)}`, baseline: `file||sha256:${sha('{"model":"x"}')}` },
      { source: 'project', path: t.project.path, kind: 'appeared', fingerprint: `file||sha256:${sha(HOOKS)}`, baseline: 'absent||absent' },
      { source: 'managed', path: t.dropIns, kind: 'drop-in-listing', fingerprint: `listing|${sha('z.json')}`, baseline: `listing|${sha('')}` },
    ]);
  });

  it('baselineOf gives the start state of a listed path and of the drop-in directory, and the unknown mark for any other path', () => {
    const t = tree();
    writeFileSync(t.user.path, '{"model":"x"}');
    const s = snap(t);
    writeFileSync(t.user.path, HOOKS);
    expect(s.baselineOf(t.user.path)).toBe(`file||sha256:${sha('{"model":"x"}')}`);
    expect(s.baselineOf(t.project.path)).toBe('absent||absent');
    expect(s.baselineOf(t.dropIns)).toBe(`listing|${sha('')}`);
    expect(s.baselineOf(join(t.root, 'not-listed.json'))).toBe(UNKNOWN_BASELINE);
  });

  it('a symlink is fingerprinted by a hash of its link text, not the text', () => {
    const t = tree();
    const target = join(t.root, `${'long-'.repeat(40)}target.json`);
    writeFileSync(target, HOOKS);
    const s = snap(t);
    symlinkSync(target, t.user.path);
    expect(s.changed()?.fingerprint).toBe(`symlink|${sha(target).slice(0, 16)}|sha256:${sha(HOOKS)}`);
  });
});

describe('takeSettingsSnapshot (#264, owner ruling R2-6): which keys of the global config file are watched', () => {
  const start = { numStartups: 1, projects: { '/work/a': { lastCost: 1 } } };
  const changedBy = (next: unknown): unknown => {
    const t = tree();
    writeFileSync(t.global.path, JSON.stringify(start));
    const s = snap(t);
    writeFileSync(t.global.path, JSON.stringify(next));
    return s.changed();
  };

  it('the lists are the documented ones', () => {
    expect(GLOBAL_WATCHED_KEYS).toEqual(['env', 'mcpServers', 'hooks', 'permissions', 'bypassPermissionsModeAccepted']);
    expect(GLOBAL_WATCHED_PROJECT_KEYS).toEqual([
      'hasTrustDialogAccepted',
      'allowedTools',
      'mcpServers',
      'enabledMcpjsonServers',
      'disabledMcpjsonServers',
      'enableAllProjectMcpServers',
      'enabledMcpServers',
      'disabledMcpServers',
      'mcpContextUris',
      'hasClaudeMdExternalIncludesApproved',
    ]);
  });

  it.each([
    ['env', { X: '1' }],
    ['mcpServers', { probe: { type: 'stdio', command: '/tmp/x' } }],
    ['hooks', { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] }],
    ['permissions', { allow: ['Bash'] }],
    ['bypassPermissionsModeAccepted', true],
  ])('a top-level %s that holds something is a change', (key, value) => {
    expect(changedBy({ ...start, [key]: value })).toMatchObject({ kind: 'global-config' });
  });

  it.each([
    ['hasTrustDialogAccepted', true],
    ['allowedTools', ['Bash']],
    ['mcpServers', { probe: { type: 'stdio', command: '/tmp/x' } }],
    ['enabledMcpjsonServers', ['probe']],
    ['disabledMcpjsonServers', ['other']],
    ['enableAllProjectMcpServers', true],
    ['enabledMcpServers', ['computer-use']],
    ['disabledMcpServers', ['some-server']],
    ['mcpContextUris', ['file:///tmp/x']],
    ['hasClaudeMdExternalIncludesApproved', true],
  ])('%s set on a project entry is a change, on an entry that was there and on a new one', (key, value) => {
    expect(changedBy({ ...start, projects: { '/work/a': { lastCost: 1, [key]: value } } })).toMatchObject({ kind: 'global-config' });
    expect(changedBy({ ...start, projects: { ...start.projects, '/work/new': { [key]: value } } })).toMatchObject({ kind: 'global-config' });
  });

  it("the CLI's routine churn is no change: counters, ids, caches, and a project entry written with its defaults", () => {
    const defaults = { allowedTools: [], hasTrustDialogAccepted: false, mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [], mcpContextUris: [], history: ['x'], lastCost: 0.02, lastSessionId: 's' };
    expect(changedBy({ numStartups: 7, userID: 'u', machineID: 'm', seenNotifications: { a: 1 }, pluginUsage: {}, projects: { '/work/a': { ...defaults, lastCost: 9 }, '/work/b': defaults } })).toBeNull();
    expect(changedBy({ ...start, mcpServers: {}, hooks: {}, permissions: {}, env: {} })).toBeNull();
    expect(changedBy({ ...start, projects: {} })).toBeNull();
    expect(changedBy({ numStartups: 1 })).toBeNull();
    // The keys added by ruling R3-3, at their defaults, and where the CLI does not read them, are no change either.
    expect(changedBy({ ...start, bypassPermissionsModeAccepted: false, projects: { '/work/a': { lastCost: 1, enabledMcpServers: [], disabledMcpServers: [], mcpContextUris: [], hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true } } })).toBeNull();
    expect(changedBy({ ...start, enabledMcpServers: ['x'], disabledMcpServers: ['y'], mcpContextUris: ['z'], hasClaudeMdExternalIncludesApproved: true })).toBeNull();
    expect(changedBy({ ...start, projects: { '/work/a': { lastCost: 1, bypassPermissionsModeAccepted: true } } })).toBeNull();
  });

  it('a watched key that was set at the start and is changed, emptied or removed is a change', () => {
    const base = { mcpServers: { a: { command: '/a' } }, projects: { '/work/a': { hasTrustDialogAccepted: true, allowedTools: ['Read'] } } };
    for (const next of [
      { mcpServers: { a: { command: '/b' } }, projects: base.projects },
      { mcpServers: {}, projects: base.projects },
      { projects: base.projects },
      { ...base, projects: { '/work/a': { hasTrustDialogAccepted: false, allowedTools: ['Read'] } } },
      { ...base, projects: { '/work/a': { hasTrustDialogAccepted: true, allowedTools: ['Read', 'Bash'] } } },
      { ...base, projects: {} },
    ]) {
      const t = tree();
      writeFileSync(t.global.path, JSON.stringify(base));
      const s = snap(t);
      writeFileSync(t.global.path, JSON.stringify(next));
      expect(s.changed(), JSON.stringify(next)).toMatchObject({ kind: 'global-config' });
    }
  });

  it('a directory at the global config path reads as no file', () => {
    const t = tree();
    const s = snap(t);
    mkdirSync(t.global.path);
    expect(s.changed()).toBeNull();
  });
});

describe('takeSettingsSnapshot (#264): a global config file the CLI keeps rewriting is not read on every check', () => {
  const rewrite = (path: string, n: number, extra: object = {}): void => writeFileSync(path, JSON.stringify({ numStartups: n, pad: 'x'.repeat(n), ...extra }));
  const globalOpens = (seam: { opens: string[] }, path: string): number => seam.opens.filter((opened) => opened === path).length;

  it('the limit is one second', () => {
    expect(GLOBAL_REREAD_MIN_MS).toBe(1000);
  });

  it('an unforced check reads it at most once per second, however often it is rewritten', () => {
    const t = tree();
    rewrite(t.global.path, 1);
    const seam = io();
    const s = takeSettingsSnapshot(t.files, t.dropIns, { ...OPTIONS, io: seam });
    const atStart = globalOpens(seam, t.global.path);
    for (let tick = 0; tick < 8; tick += 1) {
      rewrite(t.global.path, tick + 2);
      expect(s.changes()).toEqual([]);
      seam.clock.ms += 100;
    }
    // 800 ms of rewrites: one read. Then the second passes and the next rewrite is read.
    expect(globalOpens(seam, t.global.path) - atStart).toBe(1);
    // 800 ms have passed since that read: 200 more, and it is a second.
    seam.clock.ms += 199;
    rewrite(t.global.path, 19);
    expect(s.changes()).toEqual([]);
    expect(globalOpens(seam, t.global.path) - atStart).toBe(1);
    seam.clock.ms += 1;
    rewrite(t.global.path, 20);
    expect(s.changes()).toEqual([]);
    expect(globalOpens(seam, t.global.path) - atStart).toBe(2);
  });

  it('detection is kept: a watched key written inside that window is seen by a forced check at once, and by an unforced one once the time has passed', () => {
    const t = tree();
    rewrite(t.global.path, 1);
    const seam = io();
    const s = takeSettingsSnapshot(t.files, t.dropIns, { ...OPTIONS, io: seam });
    rewrite(t.global.path, 2);
    expect(s.changes()).toEqual([]);
    seam.clock.ms += 10;
    rewrite(t.global.path, 3, { mcpServers: { probe: { command: '/tmp/x' } } });
    expect(s.changes()).toEqual([]);
    expect(s.changes(true)).toMatchObject([{ kind: 'global-config' }]);

    const u = tree();
    rewrite(u.global.path, 1);
    const later = io();
    const unforced = takeSettingsSnapshot(u.files, u.dropIns, { ...OPTIONS, io: later });
    rewrite(u.global.path, 2);
    expect(unforced.changes()).toEqual([]);
    rewrite(u.global.path, 3, { env: { X: '1' } });
    later.clock.ms += 999;
    expect(unforced.changes()).toEqual([]);
    later.clock.ms += 1;
    expect(unforced.changes()).toMatchObject([{ kind: 'global-config' }]);
  });

  it('the limit is for the global config file only: a settings file is read on every check that finds its stat fields changed', () => {
    const t = tree();
    writeFileSync(t.user.path, '{"model":"x"}');
    const s = takeSettingsSnapshot(t.files, t.dropIns, { ...OPTIONS, io: io() });
    writeFileSync(t.user.path, HOOKS);
    expect(s.changes()).toMatchObject([{ kind: 'content' }]);
  });
});

describe('settingsFingerprint (#264): the present state, in the form the marker keeps', () => {
  it('is the state now: it equals a change\'s baseline again only once the path is back as it was at the start', () => {
    const t = tree();
    writeFileSync(t.user.path, '{"model":"x"}');
    const s = snap(t);
    writeFileSync(t.user.path, HOOKS);
    const change = s.changed();
    if (change === null) throw new Error('no change seen');
    expect(settingsFingerprint(change, OPTIONS)).toBe(`file||sha256:${sha(HOOKS)}`);
    // A second, different write: still not the baseline.
    writeFileSync(t.user.path, '{"model":"y"}');
    expect(settingsFingerprint(change, OPTIONS)).toBe(`file||sha256:${sha('{"model":"y"}')}`);
    rmSync(t.user.path);
    expect(settingsFingerprint(change, OPTIONS)).toBe('absent||absent');
    writeFileSync(t.user.path, '{"model":"x"}');
    expect(settingsFingerprint(change, OPTIONS)).toBe(change.baseline);
  });

  it('for a deletion it is the absent state, and for the drop-in directory its listing', () => {
    const t = tree();
    writeFileSync(t.user.path, '{}');
    const s = snap(t);
    rmSync(t.user.path);
    const gone = s.changed();
    expect(gone).toMatchObject({ kind: 'deleted', fingerprint: 'absent||absent', baseline: `file||sha256:${sha('{}')}` });
    const listing = { source: 'managed' as const, path: t.dropIns, kind: 'drop-in-listing' as const };
    expect(settingsFingerprint(listing, OPTIONS)).toBe(`listing|${sha('')}`);
    writeFileSync(join(t.dropIns, 'a.json'), '{}');
    expect(settingsFingerprint(listing, OPTIONS)).toBe(`listing|${sha('a.json')}`);
  });
});
