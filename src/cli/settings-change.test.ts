import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../cli.js';
import type { QueryFn, SdkHookCallback, SdkMessage, SdkSpawnedProcess } from '../session/index.js';
import { fakeSpawnChild, promptHookFirst } from '../../test/prompt-hook.js';
import { runEval } from './eval-command.js';

// Issue #264, end to end through the command line: a settings file the bundled CLI loads changes during a
// run. `run` exits 2 and leaves a marker; the next run is refused while the file is as it was left; `eval`
// stops the whole pack (owner ruling 5). The real watch reads real files, in temporary directories: the home
// directory through the `userDir` seam, the CLI's config directory through CLAUDE_CONFIG_DIR, the project
// through a spied `process.cwd()`.

const HOOKS = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] } });
const INIT = { type: 'system', subtype: 'init', session_id: 'sdk-1' } as SdkMessage;
const RESULT = { type: 'result', subtype: 'success', result: 'done', session_id: 'sdk-1', num_turns: 1, total_cost_usd: 0.01 } as SdkMessage;

const tmp: string[] = [];
const children: SdkSpawnedProcess[] = [];
const saved = { key: process.env.ANTHROPIC_API_KEY, cfg: process.env.CLAUDE_CONFIG_DIR };
const restore = (name: 'ANTHROPIC_API_KEY' | 'CLAUDE_CONFIG_DIR', value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) if (child.exitCode === null && (child.signalCode ?? null) === null) child.kill('SIGKILL');
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
  restore('ANTHROPIC_API_KEY', saved.key);
  restore('CLAUDE_CONFIG_DIR', saved.cfg);
});

function world() {
  const root = mkdtempSync(join(tmpdir(), 'settings-change-'));
  tmp.push(root);
  const userDir = join(root, 'home');
  const cfg = join(root, 'cfg');
  const project = join(root, 'proj');
  // A `.git` entry makes the project its own root, so the list of project settings files stops there.
  for (const d of [userDir, cfg, join(project, '.git')]) mkdirSync(d, { recursive: true });
  process.env.ANTHROPIC_API_KEY = 'dummy';
  process.env.CLAUDE_CONFIG_DIR = cfg;
  vi.spyOn(process, 'cwd').mockReturnValue(project);
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => (err.push(String(c)), true));
  return { root, userDir, cfg, project, marker: join(userDir, '.harness', 'settings-changed.json'), stdout: () => out.join(''), stderr: () => err.join('') };
}

/** A fake CLI turn: `during` runs after the init message, then one Read call reaches the session's pre-tool hook. */
function turn(during: () => void, seen: { calls: number } = { calls: 0 }): QueryFn {
  return (args) =>
    (async function* () {
      seen.calls += 1;
      yield INIT;
      during();
      for (const matcher of args.options?.hooks?.PreToolUse ?? []) {
        for (const cb of matcher.hooks as unknown as SdkHookCallback[]) {
          await cb({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/x' }, tool_use_id: 't1' }, 't1', { signal: new AbortController().signal });
        }
      }
      yield RESULT;
    })();
}

const runArgs = (root: string): string[] => ['run', 'do the task', '--db', join(root, 'run.db')];

describe('run: a settings file that changes during the run (#264)', () => {
  it('stops the run with exit 2 and the fixed reason, names the file in a warning, and writes the marker; no summary line', async () => {
    const w = world();
    const file = join(w.cfg, 'settings.json');
    const code = await main(runArgs(w.root), { userDir: w.userDir, importSdk: async () => ({ query: promptHookFirst(turn(() => writeFileSync(file, HOOKS))) }), spawnChild: fakeSpawnChild });
    expect(code).toBe(2);
    expect(w.stderr()).toMatch(/^run stopped: settings changed: A settings file the bundled CLI loads, or a watched key of its global config file, changed while the run was in progress/m);
    expect(w.stderr()).toContain(`warning: settings changed: user:${file} (appeared), seen by the harness's re-check, at a tool hook`);
    expect(w.stderr()).toContain('warning: settings changed: the file is STILL changed on disk');
    expect(w.stderr()).toContain(`or the marker file is deleted: ${w.marker}`);
    expect(w.stdout()).not.toMatch(/\[harness\] model=/);
    expect(JSON.parse(readFileSync(w.marker, 'utf8'))).toMatchObject({ version: 1, entries: [{ source: 'user', path: file, kind: 'appeared', baseline: 'absent||absent' }] });
    // The harness did not touch the file.
    expect(readFileSync(file, 'utf8')).toBe(HOOKS);
  });

  it('the next run is refused before the SDK is called, stays refused when the file is written again, and runs once the file is back as it was', async () => {
    const w = world();
    const file = join(w.cfg, 'settings.json');
    await main(runArgs(w.root), { userDir: w.userDir, importSdk: async () => ({ query: promptHookFirst(turn(() => writeFileSync(file, HOOKS))) }), spawnChild: fakeSpawnChild });
    const seen = { calls: 0 };
    const again = () => main(runArgs(w.root), { userDir: w.userDir, importSdk: async () => ({ query: promptHookFirst(turn(() => undefined, seen)) }), spawnChild: fakeSpawnChild });

    const before = w.stderr().length;
    expect(await again()).toBe(2);
    const refusal = w.stderr().slice(before);
    expect(refusal).toMatch(/^refusing to run: settings changed: An earlier run was stopped because a settings file the bundled CLI loads changed during it/m);
    expect(refusal).toContain(`warning: settings changed: user:${file} (appeared) is not back in the state it was in before an earlier run was stopped`);
    expect(seen.calls).toBe(0);

    // A process that outlived the stop writes the file again, differently: still refused, and the SDK is not called.
    writeFileSync(file, JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'false' }] }] } }));
    expect(await again()).toBe(2);
    expect(seen.calls).toBe(0);
    expect(existsSync(w.marker)).toBe(true);

    // The operator puts things back as they were at the start of the stopped run: no file. The entry clears.
    rmSync(file);
    expect(await again()).toBe(0);
    expect(seen.calls).toBe(1);
    expect(existsSync(w.marker)).toBe(false);
  });

  it('deleting the marker is the other way to clear it', async () => {
    const w = world();
    const file = join(w.cfg, 'settings.json');
    await main(runArgs(w.root), { userDir: w.userDir, importSdk: async () => ({ query: promptHookFirst(turn(() => writeFileSync(file, HOOKS))) }), spawnChild: fakeSpawnChild });
    rmSync(w.marker);
    const seen = { calls: 0 };
    expect(await main(runArgs(w.root), { userDir: w.userDir, importSdk: async () => ({ query: promptHookFirst(turn(() => undefined, seen)) }), spawnChild: fakeSpawnChild })).toBe(0);
    expect(seen.calls).toBe(1);
  });

  it('a project settings file appearing stops a run that inherits no source: the write persists for the next session', async () => {
    const w = world();
    const file = join(w.project, '.claude', 'settings.json');
    const plant = (): void => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, HOOKS);
    };
    const code = await main(runArgs(w.root), { userDir: w.userDir, importSdk: async () => ({ query: promptHookFirst(turn(plant)) }), spawnChild: fakeSpawnChild });
    expect(code).toBe(2);
    expect(w.stderr()).toContain(`warning: settings changed: project:${file} (appeared)`);
  });

  it('control: the CLI creating and rewriting its global config file during the run does not stop it, and leaves no marker', async () => {
    const w = world();
    const during = (): void => {
      writeFileSync(join(w.cfg, '.claude.json'), JSON.stringify({ numStartups: 1, projects: {} }));
      writeFileSync(join(w.cfg, '.claude.json'), JSON.stringify({ numStartups: 2, projects: { [w.project]: { lastCost: 0.01 } } }));
    };
    const code = await main(runArgs(w.root), { userDir: w.userDir, importSdk: async () => ({ query: promptHookFirst(turn(during)) }), spawnChild: fakeSpawnChild });
    expect(code).toBe(0);
    expect(w.stderr()).not.toMatch(/settings changed/);
    expect(existsSync(w.marker)).toBe(false);
  });

  it('control: an untouched project settings file under an inherited project source does not stop the run', async () => {
    const w = world();
    mkdirSync(join(w.project, '.claude'));
    writeFileSync(join(w.project, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['WebFetch'] } }));
    mkdirSync(join(w.userDir, '.harness'));
    writeFileSync(join(w.userDir, '.harness', 'settings.json'), JSON.stringify({ sdk: { settingSources: ['project'] } }));
    const code = await main(runArgs(w.root), { userDir: w.userDir, importSdk: async () => ({ query: promptHookFirst(turn(() => undefined)) }), spawnChild: fakeSpawnChild });
    expect(code).toBe(0);
    expect(w.stderr()).not.toMatch(/settings changed/);
  });

  it('a deleted settings file stops the run and keeps refusing until it is put back (owner ruling R2-5)', async () => {
    const w = world();
    const file = join(w.cfg, 'settings.json');
    const original = JSON.stringify({ permissions: { deny: ['WebFetch'] } });
    writeFileSync(file, original);
    const code = await main(runArgs(w.root), { userDir: w.userDir, importSdk: async () => ({ query: promptHookFirst(turn(() => rmSync(file))) }), spawnChild: fakeSpawnChild });
    expect(code).toBe(2);
    expect(w.stderr()).toContain(`warning: settings changed: user:${file} (deleted)`);
    const seen = { calls: 0 };
    const again = () => main(runArgs(w.root), { userDir: w.userDir, importSdk: async () => ({ query: promptHookFirst(turn(() => undefined, seen)) }), spawnChild: fakeSpawnChild });
    expect(await again()).toBe(2);
    expect(await again()).toBe(2);
    writeFileSync(file, original);
    expect(await again()).toBe(0);
    expect(seen.calls).toBe(1);
  });

  it('two files written before one check are both in the warnings and both in the marker', async () => {
    const w = world();
    const user = join(w.cfg, 'settings.json');
    const project = join(w.project, '.claude', 'settings.json');
    const plant = (): void => {
      writeFileSync(user, HOOKS);
      mkdirSync(dirname(project), { recursive: true });
      writeFileSync(project, HOOKS);
    };
    const code = await main(runArgs(w.root), { userDir: w.userDir, importSdk: async () => ({ query: promptHookFirst(turn(plant)) }), spawnChild: fakeSpawnChild });
    expect(code).toBe(2);
    expect(w.stderr()).toContain(`warning: settings changed: user:${user} (appeared)`);
    expect(w.stderr()).toContain(`warning: settings changed: project:${project} (appeared)`);
    expect((JSON.parse(readFileSync(w.marker, 'utf8')) as { entries: { path: string }[] }).entries.map((entry) => entry.path)).toEqual([user, project]);
    // Dealing with one of the two is not enough.
    rmSync(user);
    expect(await main(runArgs(w.root), { userDir: w.userDir, importSdk: async () => ({ query: promptHookFirst(turn(() => undefined)) }), spawnChild: fakeSpawnChild })).toBe(2);
  });

  it('a project entry does not refuse a run in another project; a user entry does (owner ruling R2-2)', async () => {
    const w = world();
    const project = join(w.project, '.claude', 'settings.json');
    const plant = (): void => {
      mkdirSync(dirname(project), { recursive: true });
      writeFileSync(project, HOOKS);
    };
    expect(await main(runArgs(w.root), { userDir: w.userDir, importSdk: async () => ({ query: promptHookFirst(turn(plant)) }), spawnChild: fakeSpawnChild })).toBe(2);
    const other = join(w.root, 'other');
    mkdirSync(join(other, '.git'), { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(other);
    const clean = () => main(runArgs(w.root), { userDir: w.userDir, importSdk: async () => ({ query: promptHookFirst(turn(() => undefined)) }), spawnChild: fakeSpawnChild });
    expect(await clean()).toBe(0);
    // A user settings file changes during a run in the other project: every project is refused after that.
    expect(await main(runArgs(w.root), { userDir: w.userDir, importSdk: async () => ({ query: promptHookFirst(turn(() => writeFileSync(join(w.cfg, 'settings.json'), HOOKS))) }), spawnChild: fakeSpawnChild })).toBe(2);
    expect(await clean()).toBe(2);
    vi.spyOn(process, 'cwd').mockReturnValue(w.project);
    expect(await clean()).toBe(2);
  });

  it('an MCP server and a trusted project added to the global config file during the run stop it (owner ruling R2-6)', async () => {
    const w = world();
    const file = join(w.cfg, '.claude.json');
    const planted = { numStartups: 1, mcpServers: { probe: { type: 'stdio', command: '/tmp/x' } }, projects: { [w.project]: { hasTrustDialogAccepted: true, allowedTools: ['Bash'] } } };
    const code = await main(runArgs(w.root), { userDir: w.userDir, importSdk: async () => ({ query: promptHookFirst(turn(() => writeFileSync(file, JSON.stringify(planted)))) }), spawnChild: fakeSpawnChild });
    expect(code).toBe(2);
    expect(w.stderr()).toContain(`warning: settings changed: global:${file} (global-config)`);
  });

  it('an env block added to the global config file during the run stops it', async () => {
    const w = world();
    const file = join(w.cfg, '.claude.json');
    const code = await main(runArgs(w.root), { userDir: w.userDir, importSdk: async () => ({ query: promptHookFirst(turn(() => writeFileSync(file, JSON.stringify({ env: { PROBE_MARK: 'g' } })))) }), spawnChild: fakeSpawnChild });
    expect(code).toBe(2);
    expect(w.stderr()).toContain(`warning: settings changed: global:${file} (global-config)`);
  });
});

describe('eval: a detection stops the pack (#264, owner ruling 5)', () => {
  const pack = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval', 'golden', '__fixtures__', 'run');

  /** `runEval` has no spawn seam, so this fake starts a real process that does nothing, as the SDK would start the CLI, and the stop kills it. */
  function evalTurn(during: () => void, seen: { prompts: string[] }): QueryFn {
    return (args) => {
      seen.prompts.push(args.prompt);
      const child = args.options?.spawnClaudeCodeProcess?.({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: {}, signal: new AbortController().signal });
      if (child !== undefined) children.push(child);
      return (async function* () {
        const context = { signal: new AbortController().signal };
        for (const matcher of args.options?.hooks?.UserPromptSubmit ?? []) for (const cb of matcher.hooks) await cb({ hook_event_name: 'UserPromptSubmit', prompt: args.prompt }, undefined, context);
        yield INIT;
        during();
        for (const matcher of args.options?.hooks?.PreToolUse ?? []) {
          for (const cb of matcher.hooks as unknown as SdkHookCallback[]) await cb({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/x' }, tool_use_id: 't1' }, 't1', context);
        }
        yield RESULT;
        child?.kill('SIGKILL');
      })();
    };
  }

  it('a settings file written during the first task ends the pack with exit 2: no later task runs and no scorecard is written', async () => {
    const w = world();
    const file = join(w.cfg, 'settings.json');
    const seen = { prompts: [] as string[] };
    const evalOutDir = join(w.root, 'eval-out');
    const code = await runEval({ taskDir: pack, challenge: false, maxTasks: 10 } as never, { userDir: w.userDir, evalOutDir, importSdk: async () => ({ query: evalTurn(() => writeFileSync(file, HOOKS), seen) }) });
    expect(code).toBe(2);
    expect(seen.prompts).toHaveLength(1);
    // The stand-in child is a real process: wait for its exit and read the signal it died of.
    const child = children[0];
    if (child === undefined) throw new Error('the fake started no process');
    const signal = await new Promise<NodeJS.Signals | null>((resolve) => (child.signalCode != null || child.exitCode !== null ? resolve(child.signalCode ?? null) : child.once('exit', (_code, sig) => resolve(sig))));
    expect(signal).toBe('SIGKILL');
    expect(w.stderr()).toMatch(/^eval stopped: settings changed: A settings file the bundled CLI loads/m);
    expect(w.stderr()).toContain(`warning: settings changed: user:${file} (appeared)`);
    expect(existsSync(evalOutDir) ? readdirSync(evalOutDir) : []).toEqual([]);
    expect(w.stdout()).toBe('');
    expect(existsSync(w.marker)).toBe(true);
  });

  it('control: the same pack with nothing written runs every task and writes a scorecard', async () => {
    const w = world();
    const seen = { prompts: [] as string[] };
    const evalOutDir = join(w.root, 'eval-out');
    const code = await runEval({ taskDir: pack, challenge: false, maxTasks: 10 } as never, { userDir: w.userDir, evalOutDir, importSdk: async () => ({ query: evalTurn(() => undefined, seen) }) });
    // The pack has two runnable tasks and one that does not parse: exit 1, two sessions, one scorecard file.
    expect(code).toBe(1);
    expect(seen.prompts).toHaveLength(2);
    expect(readdirSync(evalOutDir)).toHaveLength(1);
    expect(w.stderr()).not.toMatch(/settings changed/);
  });

  it('a pack is refused before the SDK is loaded while an earlier stop still stands', async () => {
    const w = world();
    const file = join(w.cfg, 'settings.json');
    await main(runArgs(w.root), { userDir: w.userDir, importSdk: async () => ({ query: promptHookFirst(turn(() => writeFileSync(file, HOOKS))) }), spawnChild: fakeSpawnChild });
    let loaded = 0;
    const before = w.stderr().length;
    const code = await runEval({ taskDir: pack, challenge: false, maxTasks: 10 } as never, { userDir: w.userDir, evalOutDir: join(w.root, 'eval-out'), importSdk: async () => ((loaded += 1), { query: undefined }) });
    expect(code).toBe(2);
    expect(loaded).toBe(0);
    expect(w.stderr().slice(before)).toMatch(/^refusing to run: settings changed: An earlier run was stopped/m);
  });
});
