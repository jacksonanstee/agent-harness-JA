import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHookRuntime } from '../hooks/index.js';
import { createMemoryStore, openMemoryDatabase } from '../memory/index.js';
import { route } from '../router/index.js';
import type { SettingsChange } from '../security/index.js';
import type { TelemetryEvent, TelemetryEventInput } from '../telemetry/index.js';
import { fakeChild } from '../../test/prompt-hook.js';
import type { ChildKillOutcome } from './child-process.js';
import { HookCanaryMissed } from './hook-canary.js';
import { createSession } from './session.js';
import {
  assertNoPendingSettingsChange,
  createSettingsGuard,
  createSettingsWatch,
  SETTINGS_CHANGE_MARKER_UNREADABLE_REASON,
  SETTINGS_CHANGE_PENDING_REASON,
  SETTINGS_CHANGED_REASON,
  SETTINGS_RECHECK_MS,
  SETTINGS_STOP_DENY,
  SettingsChangeDetected,
} from './settings-watch.js';
import type { SettingsGuardTimers } from './settings-watch.js';
import type { QueryFn, QueryOptions, SdkMessage, SessionDeps, SettingsWatch } from './types.js';

// Issue #264. A settings file the CLI loads that changes during a run stops the run, by two layers that share
// one guard: the CLI's ConfigChange event, and the harness's own re-check of a snapshot (a timer, every tool
// hook entry, the result message, the end of the stream). These tests use the bare `createSession`; the fake
// query stands in for the SDK and the CLI and decides when each hook is called.

const CHANGE: SettingsChange = { source: 'user', path: '/cfg/settings.json', kind: 'content', fingerprint: 'file||sha256:planted', baseline: 'file||sha256:original' };
const SECOND: SettingsChange = { source: 'project', path: '/proj/.claude/settings.json', kind: 'appeared', fingerprint: 'file||sha256:planted', baseline: 'absent||absent' };
const MARKER_LINE =
  'settings changed: the next run is refused until each file named above is back as it was at the start of this run, or the marker file is deleted: /home/u/.harness/settings-changed.json';
const INIT: SdkMessage = { type: 'system', subtype: 'init', session_id: 'sdk-1' };
const RESULT = { type: 'result', subtype: 'success', result: 'done', session_id: 'sdk-1', num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } } as SdkMessage;
const KILLED_LINE = 'settings changed: the CLI process was killed at once';

interface FakeWatch extends SettingsWatch {
  /** What every compare returns from now on. `change` reads and sets it as one difference. */
  changes: SettingsChange[];
  change: SettingsChange | null;
  /** Answers for the next compares, one each, before `changes` is used again. */
  readonly queue: SettingsChange[][];
  pendingValue: readonly SettingsChange[] | 'unreadable';
  changedThrows: Error | null;
  recordThrows: Error | null;
  recordAnswer: 'ok' | 'over-cap';
  readonly recorded: SettingsChange[][];
  readonly calls: string[];
  /** Whether each compare was forced. */
  readonly forces: boolean[];
  /** Called at each compare and each record, for tests that pin the order of a stop. */
  onStep: (step: 'compare' | 'marker') => void;
}
function fakeWatch(): FakeWatch {
  const watch: FakeWatch = {
    markerPath: '/home/u/.harness/settings-changed.json',
    changes: [],
    get change() {
      return watch.changes[0] ?? null;
    },
    set change(value: SettingsChange | null) {
      watch.changes = value === null ? [] : [value];
    },
    queue: [],
    pendingValue: [],
    changedThrows: null,
    recordThrows: null,
    recordAnswer: 'ok',
    recorded: [],
    calls: [],
    forces: [],
    onStep: () => undefined,
    pending: () => (watch.calls.push('pending'), watch.pendingValue),
    snapshot: () => {
      watch.calls.push('snapshot');
      return {
        changes: (force = false) => {
          watch.onStep('compare');
          watch.forces.push(force);
          if (watch.changedThrows !== null) throw watch.changedThrows;
          return watch.queue.shift() ?? watch.changes;
        },
        // The fake snapshot holds the two fixtures' paths and no other.
        baselineOf: (path) => [CHANGE, SECOND].find((known) => known.path === path)?.baseline ?? 'unknown',
      };
    },
    reported: (source, path) => ({ source, path, kind: 'reported', fingerprint: `reported:${path}`, baseline: 'unknown' }),
    record: (changes) => {
      watch.onStep('marker');
      if (watch.recordThrows !== null) throw watch.recordThrows;
      watch.recorded.push([...changes]);
      return watch.recordAnswer;
    },
  };
  return watch;
}

/** What the fake CLI can do during the turn. */
interface Cli {
  aborted(): boolean;
  pre(tool: string): Promise<unknown>;
  post(tool: string): Promise<unknown>;
  fail(tool: string): Promise<unknown>;
  configChange(source: string, filePath?: string): Promise<unknown>;
}

function live(body: (cli: Cli) => AsyncGenerator<SdkMessage>, opts: { fireCanary?: boolean } = {}) {
  const child = fakeChild();
  const options: QueryOptions[] = [];
  const query: QueryFn = (args) => {
    if (args.options !== undefined) options.push(args.options);
    args.options?.spawnClaudeCodeProcess?.({ command: 'fake', args: [], env: {}, signal: new AbortController().signal });
    const hooks = args.options?.hooks;
    const context = { signal: new AbortController().signal };
    const tool = (name: string) => ({ tool_name: name, tool_input: {}, tool_use_id: 't1' });
    const cli: Cli = {
      aborted: () => args.options?.abortController?.signal.aborted === true,
      pre: (name) => hooks!.PreToolUse![0]!.hooks[0]!({ hook_event_name: 'PreToolUse', ...tool(name) } as never, 't1', context),
      post: (name) => hooks!.PostToolUse![0]!.hooks[0]!({ hook_event_name: 'PostToolUse', ...tool(name), tool_response: 'ok' } as never, 't1', context),
      fail: (name) => hooks!.PostToolUseFailure![0]!.hooks[0]!({ hook_event_name: 'PostToolUseFailure', ...tool(name), error: 'boom' } as never, 't1', context),
      configChange: (source, filePath) =>
        hooks!.ConfigChange![0]!.hooks[0]!({ hook_event_name: 'ConfigChange', source, ...(filePath === undefined ? {} : { file_path: filePath }) } as never, undefined, context),
    };
    return (async function* () {
      if (opts.fireCanary !== false) {
        for (const matcher of hooks?.UserPromptSubmit ?? []) for (const cb of matcher.hooks) await cb({ hook_event_name: 'UserPromptSubmit', prompt: args.prompt }, undefined, context);
      }
      yield* body(cli);
    })();
  };
  return { query, child, options };
}

function build(fake: ReturnType<typeof live>, watch: SettingsWatch, signal?: AbortSignal, onAny: (w: string) => void = () => undefined) {
  const events: TelemetryEventInput[] = [];
  const hooks = createHookRuntime();
  const fired: string[] = [];
  hooks.register('stop', () => void fired.push('stop'));
  hooks.register('pre-tool', () => void fired.push('pre-tool'));
  hooks.register('post-tool', () => void fired.push('post-tool'));
  const warnings: string[] = [];
  const deps: SessionDeps = {
    query: fake.query,
    hooks,
    memory: createMemoryStore(openMemoryDatabase({ path: ':memory:' })),
    loadSkills: () => ({ skills: [], errors: [], root: '/skills' }),
    route,
    scanAgents: () => ({ admittedNames: new Set<string>(), refusals: [], filesScanned: 0 }),
    scanSettingsEnv: () => [],
    spawnChild: () => fake.child,
    watchSettings: watch,
    telemetry: { record: (event) => (events.push(event), { ok: true, value: { ...event, id: 'evt', ts: 1 } as TelemetryEvent }) },
  };
  // Only this module's lines: the fake init message lists no tools, so every run also warns that the init check did not run.
  const onWarning = (w: string): void => {
    onAny(w);
    if (w.startsWith('settings changed')) warnings.push(w);
  };
  const session = createSession(deps, { skillsDir: null, onWarning, ...(signal === undefined ? {} : { signal }) });
  return { session, events, fired, warnings };
}

async function stopOf(run: Promise<unknown>): Promise<SettingsChangeDetected> {
  const error: unknown = await run.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof SettingsChangeDetected)) throw new Error(`the run did not end with SettingsChangeDetected: ${String(error)}`);
  return error;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the session watches the CLI settings files for the whole run (#264)', () => {
  it('an untouched run completes, and takes its snapshot after the marker check and before the SDK is called', async () => {
    const watch = fakeWatch();
    const fake = live(async function* () {
      expect(watch.calls).toEqual(['pending', 'snapshot']);
      yield INIT;
      yield RESULT;
    });
    const b = build(fake, watch);
    const result = await b.session.run('p');
    expect(result.resultText).toBe('done');
    expect(fake.child.signals).toEqual([]);
    expect(watch.recorded).toEqual([]);
    expect(b.warnings.filter((w) => w.startsWith('settings changed'))).toEqual([]);
  });

  it('registers exactly one ConfigChange matcher with one callback', async () => {
    const fake = live(async function* () {
      yield INIT;
      yield RESULT;
    });
    await build(fake, fakeWatch()).session.run('p');
    expect(fake.options[0]?.hooks?.ConfigChange).toHaveLength(1);
    expect(fake.options[0]?.hooks?.ConfigChange?.[0]?.hooks).toHaveLength(1);
  });

  it('the timer sees a change with no hook and no message in between: the child is killed, then the query aborted, and the run ends with the fixed reason', async () => {
    // Fake timers: the session's own interval is driven by hand, so the test waits for nothing.
    vi.useFakeTimers();
    try {
      const watch = fakeWatch();
      const seen: { signals: readonly string[]; aborted: boolean }[] = [];
      const fake = live(async function* (cli) {
        yield INIT;
        const look = (): void => void seen.push({ signals: [...fake.child.signals], aborted: cli.aborted() });
        await vi.advanceTimersByTimeAsync(SETTINGS_RECHECK_MS * 3);
        look();
        watch.change = CHANGE;
        await vi.advanceTimersByTimeAsync(SETTINGS_RECHECK_MS - 1);
        look();
        await vi.advanceTimersByTimeAsync(1);
        look();
        yield RESULT;
      });
      const b = build(fake, watch);
      const error = await stopOf(b.session.run('p'));
      // Three ticks with nothing changed; nothing one millisecond before the next tick; the stop on it.
      expect(seen).toEqual([
        { signals: [], aborted: false },
        { signals: [], aborted: false },
        { signals: ['SIGKILL'], aborted: true },
      ]);
      expect(error.message).toBe(`settings changed: ${SETTINGS_CHANGED_REASON}`);
      expect(error).toMatchObject({ name: 'SettingsChangeDetected', layer: 'snapshot', killOutcome: 'killed', changes: [CHANGE] });
      expect(watch.recorded).toEqual([[CHANGE]]);
      expect(b.warnings).toEqual([
        "settings changed: user:/cfg/settings.json (content), seen by the harness's re-check, on its timer",
        KILLED_LINE,
        'settings changed: the file is STILL changed on disk; read it before the next Claude Code session or harness run',
        'settings changed: a process the agent started may still be running, and the harness has not stopped it',
        'settings changed: an operator or another Claude Code session editing the file during a run stops the run too',
        MARKER_LINE,
      ]);
      // The stop hook and the run's telemetry rows are still written, as for the canary.
      expect(b.fired).toContain('stop');
      expect(b.events.map((e) => e.type)).toEqual(expect.arrayContaining(['init-check', 'turn-cost']));
    } finally {
      vi.useRealTimers();
    }
  });

  it('two files changed before one check are both named, both recorded, and so is one that changes just after the stop', async () => {
    const watch = fakeWatch();
    const third: SettingsChange = { source: 'local', path: '/proj/.claude/settings.local.json', kind: 'appeared', fingerprint: 'file||sha256:late', baseline: 'absent||absent' };
    const fake = live(async function* () {
      yield INIT;
      watch.changes = [CHANGE, SECOND];
      // The compare the stop makes after the kill sees one more file, and a newer state of the first.
      const later = { ...CHANGE, fingerprint: 'file||sha256:rewritten' };
      watch.queue.push([CHANGE, SECOND], [later, SECOND, third]);
      yield RESULT;
    });
    const b = build(fake, watch);
    const error = await stopOf(b.session.run('p'));
    expect(error.changes).toEqual([{ ...CHANGE, fingerprint: 'file||sha256:rewritten' }, SECOND, third]);
    expect(watch.recorded).toEqual([error.changes]);
    expect(b.warnings.slice(0, 3)).toEqual([
      "settings changed: user:/cfg/settings.json (content), seen by the harness's re-check, at the result message",
      "settings changed: project:/proj/.claude/settings.json (appeared), seen by the harness's re-check, at the result message",
      "settings changed: local:/proj/.claude/settings.local.json (appeared), seen by the harness's re-check, just after the stop",
    ]);
  });

  it('the fixed reason says who else stops a run, that the file is still changed, that a process may still run, and how the marker is cleared', () => {
    for (const phrase of ['another Claude Code session', 'you in an editor', 'STILL changed on disk', 'A process the agent started may still be running', 'settings-changed.json', '~/.harness', '#264']) {
      expect(SETTINGS_CHANGED_REASON).toContain(phrase);
    }
    expect(SETTINGS_CHANGED_REASON).toContain('back as it was at the start of this run');
    expect(SETTINGS_CHANGED_REASON).not.toContain('changes again');
    expect(SETTINGS_CHANGE_PENDING_REASON).toContain('delete the marker file');
    expect(SETTINGS_CHANGE_PENDING_REASON).toContain('put it back as it was');
  });

  it('a pre-tool hook entry sees the change before the hook does its own work: the tool is denied and no harness pre-tool hook fires', async () => {
    const watch = fakeWatch();
    let answer: unknown;
    // Read here and asserted after the run: an assertion thrown inside the fake would be replaced by the stop itself.
    let atReturn: unknown;
    const fake = live(async function* (cli) {
      yield INIT;
      watch.change = CHANGE;
      answer = await cli.pre('Read');
      atReturn = { signals: [...fake.child.signals], aborted: cli.aborted() };
      yield RESULT;
    });
    const b = build(fake, watch);
    const error = await stopOf(b.session.run('p'));
    expect(atReturn).toEqual({ signals: ['SIGKILL'], aborted: true });
    expect(answer).toBe(SETTINGS_STOP_DENY);
    expect(b.fired).not.toContain('pre-tool');
    expect(error.layer).toBe('snapshot');
    expect(b.warnings[0]).toBe("settings changed: user:/cfg/settings.json (content), seen by the harness's re-check, at a tool hook");
  });

  it('a pre-tool hook entry with nothing changed runs the hook as before', async () => {
    const fake = live(async function* (cli) {
      yield INIT;
      await cli.pre('Read');
      yield RESULT;
    });
    const b = build(fake, fakeWatch());
    await b.session.run('p');
    expect(b.fired).toContain('pre-tool');
  });

  it.each(['post', 'fail'] as const)('a %s-tool hook entry sees the change, for any tool, and then does none of its own work', async (which) => {
    const watch = fakeWatch();
    let atReturn: unknown;
    const answers: unknown[] = [];
    const fake = live(async function* (cli) {
      yield INIT;
      watch.change = CHANGE;
      answers.push(await cli[which]('SomeOtherTool'));
      // The change is withdrawn here, so that only the hook entry can have seen it: the later check points see nothing.
      watch.change = null;
      atReturn = { signals: [...fake.child.signals], aborted: cli.aborted() };
      // A second call after the stop: still no work, whatever the files look like now.
      answers.push(await cli[which]('SomeOtherTool'));
      yield RESULT;
    });
    const b = build(fake, watch);
    const error = await stopOf(b.session.run('p'));
    expect(atReturn).toEqual({ signals: ['SIGKILL'], aborted: true });
    expect(error.layer).toBe('snapshot');
    expect(b.warnings[0]).toContain('at a tool hook');
    // Once stopped the wrapper answers with nothing and the hook body never runs: no scan, no redaction, no judge child.
    expect(answers).toEqual([{}, {}]);
    expect(b.fired).not.toContain('post-tool');
  });

  it('a post-tool hook entry with nothing changed runs the hook as before', async () => {
    const fake = live(async function* (cli) {
      yield INIT;
      await cli.post('Read');
      yield RESULT;
    });
    const b = build(fake, fakeWatch());
    await b.session.run('p');
    expect(b.fired).toContain('post-tool');
  });

  it('after a stop every later pre-tool call is denied, and the child is killed once', async () => {
    const watch = fakeWatch();
    const answers: unknown[] = [];
    const fake = live(async function* (cli) {
      yield INIT;
      watch.change = CHANGE;
      answers.push(await cli.pre('Read'));
      watch.change = null;
      answers.push(await cli.pre('Bash'));
      yield RESULT;
    });
    await stopOf(build(fake, watch).session.run('p'));
    expect(answers).toEqual([SETTINGS_STOP_DENY, SETTINGS_STOP_DENY]);
    expect(fake.child.signals).toEqual(['SIGKILL']);
    expect(watch.recorded).toHaveLength(1);
  });

  it('the result message is a check point: a change seen there fails the run before the result is used', async () => {
    const watch = fakeWatch();
    const fake = live(async function* () {
      yield INIT;
      watch.change = CHANGE;
      yield RESULT;
    });
    const b = build(fake, watch);
    const error = await stopOf(b.session.run('p'));
    expect(error.layer).toBe('snapshot');
    expect(b.warnings[0]).toContain('at the result message');
  });

  it('the end of the stream is a check point: a change made after the result still fails the run', async () => {
    const watch = fakeWatch();
    const fake = live(async function* () {
      yield INIT;
      yield RESULT;
      watch.change = CHANGE;
    });
    const b = build(fake, watch);
    const error = await stopOf(b.session.run('p'));
    expect(b.warnings[0]).toContain('at the end of the run');
    expect(error.killOutcome).toBe('killed');
  });

  it('a stream that throws for its own reason is still checked, and the change is what the run ends with', async () => {
    const watch = fakeWatch();
    const fake = live(async function* () {
      yield INIT;
      watch.change = CHANGE;
      throw new Error('the child died');
    });
    const error = await stopOf(build(fake, watch).session.run('p'));
    expect(error.layer).toBe('snapshot');
  });

  it('a re-check that throws is not a clean one: the run is stopped and says the files could not be vouched for', async () => {
    const watch = fakeWatch();
    const fake = live(async function* () {
      yield INIT;
      watch.changedThrows = new Error('EIO');
      yield RESULT;
    });
    const b = build(fake, watch);
    const error = await stopOf(b.session.run('p'));
    expect(error.changes).toEqual([]);
    expect(b.warnings).toContain('settings changed: the re-check itself failed (EIO), so the files could not be vouched for');
    expect(b.warnings.at(-1)).toMatch(/^settings changed: no marker was written: no listed file differs .* The next run will NOT be refused$/);
    expect(fake.child.signals).toEqual(['SIGKILL']);
  });

  it('a marker that cannot be written does not hide the stop, and says the next run will not be refused', async () => {
    const watch = fakeWatch();
    watch.recordThrows = new Error('EACCES');
    const fake = live(async function* () {
      yield INIT;
      watch.change = CHANGE;
      yield RESULT;
    });
    const b = build(fake, watch);
    await stopOf(b.session.run('p'));
    expect(b.warnings).toContain('settings changed: the marker file could not be written (EACCES), so the next run will NOT be refused');
  });

  it('a marker that now holds more entries than it may is said plainly: every run is refused until it is deleted (owner ruling R3-4)', async () => {
    const watch = fakeWatch();
    watch.recordAnswer = 'over-cap';
    const fake = live(async function* () {
      yield INIT;
      watch.change = CHANGE;
      yield RESULT;
    });
    const b = build(fake, watch);
    await stopOf(b.session.run('p'));
    expect(b.warnings.at(-1)).toBe(
      'settings changed: the marker file now holds more entries than it may (256), so EVERY run is refused until you have read it and deleted it: /home/u/.harness/settings-changed.json',
    );
  });

  it("the caller's own interrupt comes first: the lines are warned and the marker written, and the run ends as the interrupt", async () => {
    const watch = fakeWatch();
    const caller = new AbortController();
    const failure = new Error('aborted by caller');
    const fake = live(async function* () {
      yield INIT;
      watch.change = CHANGE;
      caller.abort();
      throw failure;
    });
    const b = build(fake, watch, caller.signal);
    await expect(b.session.run('p')).rejects.toBe(failure);
    expect(watch.recorded).toEqual([[CHANGE]]);
    expect(b.warnings).toContain(KILLED_LINE);
  });

  it('a missed hook canary and a changed file at once: the settings stop is the one the run ends with, both are said, and the marker is written', async () => {
    const watch = fakeWatch();
    const all: string[] = [];
    const fake = live(
      async function* () {
        // The canary stops the run at this message; the file changed before it.
        watch.change = CHANGE;
        yield INIT;
        yield RESULT;
      },
      { fireCanary: false },
    );
    const b = build(fake, watch, undefined, (w) => all.push(w));
    const error = await stopOf(b.session.run('p'));
    expect(error).toMatchObject({ layer: 'snapshot', changes: [CHANGE] });
    expect(watch.recorded).toEqual([[CHANGE]]);
    expect(all.some((w) => w.startsWith('hook canary missed:'))).toBe(true);
    expect(b.warnings[0]).toContain('at the end of the run');
  });

  it('a missed hook canary with no file changed is still checked at the end, and stays the canary stop', async () => {
    const watch = fakeWatch();
    const fake = live(
      async function* () {
        yield INIT;
        yield RESULT;
      },
      { fireCanary: false },
    );
    await expect(build(fake, watch).session.run('p')).rejects.toThrow(HookCanaryMissed);
    // One compare, forced: the end-of-stream check ran after the canary stop.
    expect(watch.forces).toEqual([true]);
  });

  it('a missed hook canary is still the canary stop, and the timer is cleared', async () => {
    const set = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const fake = live(
      async function* () {
        yield INIT;
        yield RESULT;
      },
      { fireCanary: false },
    );
    await expect(build(fake, fakeWatch()).session.run('p')).rejects.toThrow(HookCanaryMissed);
    expect(recheckTimers(set)).toHaveLength(1);
    expect(clear).toHaveBeenCalledWith(recheckTimers(set)[0]);
  });
});

/** The timers the session started for the re-check: the ones at its interval. */
function recheckTimers(set: { mock: { calls: unknown[][]; results: { value: unknown }[] } }): unknown[] {
  return set.mock.calls.flatMap((call, i) => (call[1] === SETTINGS_RECHECK_MS ? [set.mock.results[i]?.value] : []));
}

describe("the session's re-check timer is unref'd and cleared on every way out (#264)", () => {
  const cases: [string, (watch: FakeWatch) => (cli: Cli) => AsyncGenerator<SdkMessage>, boolean][] = [
    ['a run that completes', () => async function* () { yield INIT; yield RESULT; }, false],
    ['a stream that throws', () => async function* () { yield INIT; throw new Error('boom'); }, true],
    ['a settings stop at a tool hook', (watch) => async function* (cli) { yield INIT; watch.change = CHANGE; await cli.pre('Read'); yield RESULT; }, true],
    ['a settings stop at the end of the stream', (watch) => async function* () { yield INIT; yield RESULT; watch.change = CHANGE; }, true],
  ];
  it.each(cases)('%s', async (_name, body, rejects) => {
    const set = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const watch = fakeWatch();
    const run = build(live(body(watch)), watch).session.run('p');
    if (rejects) await expect(run).rejects.toThrow();
    else await run;
    const started = recheckTimers(set);
    expect(started).toHaveLength(1);
    expect((started[0] as { hasRef(): boolean }).hasRef()).toBe(false);
    expect(clear).toHaveBeenCalledWith(started[0]);
  });

  it('a run refused at its start starts no timer and never calls the SDK', async () => {
    const set = vi.spyOn(globalThis, 'setInterval');
    const watch = fakeWatch();
    watch.pendingValue = [CHANGE];
    const fake = live(async function* () {
      yield INIT;
      yield RESULT;
    });
    await expect(build(fake, watch).session.run('p')).rejects.toThrow(SettingsChangeDetected);
    expect(recheckTimers(set)).toEqual([]);
    expect(fake.options).toEqual([]);
  });
});

describe("the CLI's ConfigChange event stops the run (#264, layer 1)", () => {
  const SOURCES: [string, string][] = [
    ['user_settings', 'user'],
    ['project_settings', 'project'],
    ['local_settings', 'local'],
    ['policy_settings', 'managed'],
  ];
  it.each(SOURCES)('%s: the child is killed inside the callback, the answer is block, and the file the CLI named is recorded', async (source, mapped) => {
    const watch = fakeWatch();
    let answer: unknown;
    let atReturn: unknown;
    const fake = live(async function* (cli) {
      yield INIT;
      // The re-check sees nothing here: this layer does not depend on it.
      answer = await cli.configChange(source, '/cfg/settings.json');
      atReturn = { signals: [...fake.child.signals], aborted: cli.aborted() };
      yield RESULT;
    });
    const b = build(fake, watch);
    const error = await stopOf(b.session.run('p'));
    expect(atReturn).toEqual({ signals: ['SIGKILL'], aborted: true });
    expect(answer).toMatchObject({ decision: 'block' });
    expect(error).toMatchObject({ layer: 'config-change', killOutcome: 'killed' });
    // The re-check saw nothing, so the entry is the path the CLI named, with the start state the snapshot holds for it.
    expect(error.changes).toEqual([{ source: mapped, path: '/cfg/settings.json', kind: 'reported', fingerprint: 'reported:/cfg/settings.json', baseline: CHANGE.baseline }]);
    expect(watch.recorded).toEqual([error.changes]);
    expect(b.warnings[0]).toBe(`settings changed: ${mapped}:/cfg/settings.json (reported), reported by the CLI's ConfigChange event (${source}) before it applied the file`);
  });

  it('skills does not stop the run (owner ruling 3)', async () => {
    const watch = fakeWatch();
    let answer: unknown;
    const fake = live(async function* (cli) {
      yield INIT;
      answer = await cli.configChange('skills', '/proj/.claude/skills/x/SKILL.md');
      yield RESULT;
    });
    const result = await build(fake, watch).session.run('p');
    expect(answer).toEqual({});
    expect(result.resultText).toBe('done');
    expect(fake.child.signals).toEqual([]);
  });

  it('a skills event is still a re-check point', async () => {
    const watch = fakeWatch();
    let answer: unknown;
    const fake = live(async function* (cli) {
      yield INIT;
      watch.change = CHANGE;
      answer = await cli.configChange('skills');
      yield RESULT;
    });
    const error = await stopOf(build(fake, watch).session.run('p'));
    expect(answer).toMatchObject({ decision: 'block' });
    expect(error.layer).toBe('snapshot');
  });

  it.each(['some_new_source', 'constructor', '__proto__', ''])('a source the harness does not know (%j) stops the run, with no file recorded from the event', async (source) => {
    const watch = fakeWatch();
    const fake = live(async function* (cli) {
      yield INIT;
      await cli.configChange(source, '/cfg/settings.json');
      yield RESULT;
    });
    const b = build(fake, watch);
    const error = await stopOf(b.session.run('p'));
    expect(error).toMatchObject({ layer: 'config-change', changes: [] });
    expect(fake.child.signals).toEqual(['SIGKILL']);
    expect(watch.recorded).toEqual([]);
  });

  it('when the re-check also sees the file, both are recorded once: the snapshot entry, and the named path only if it differs', async () => {
    const watch = fakeWatch();
    const fake = live(async function* (cli) {
      yield INIT;
      watch.change = CHANGE;
      await cli.configChange('user_settings', CHANGE.path);
      yield RESULT;
    });
    const same = await stopOf(build(fake, watch).session.run('p'));
    expect(same.changes).toEqual([CHANGE]);

    const other = fakeWatch();
    const fake2 = live(async function* (cli) {
      yield INIT;
      other.change = CHANGE;
      await cli.configChange('local_settings', '/proj/.claude/settings.local.json');
      yield RESULT;
    });
    const both = await stopOf(build(fake2, other).session.run('p'));
    expect(both.changes.map((c) => [c.path, c.kind])).toEqual([
      ['/proj/.claude/settings.local.json', 'reported'],
      [CHANGE.path, 'content'],
    ]);
    // A named path the snapshot does not hold has no known start state: only deleting the marker clears it.
    expect(both.changes[0]?.baseline).toBe('unknown');
  });

  it.each([undefined, 'relative/settings.json', 'with\0nul', 7])('a path the marker could not hold (%j) is not recorded, and the run stops all the same', async (path) => {
    const watch = fakeWatch();
    const fake = live(async function* (cli) {
      yield INIT;
      await cli.configChange('user_settings', path as string | undefined);
      yield RESULT;
    });
    const b = build(fake, watch);
    const error = await stopOf(b.session.run('p'));
    expect(error.changes).toEqual([]);
    expect(b.warnings[0]).toContain('settings changed: no file could be named, reported by the CLI');
    expect(b.warnings.at(-1)).toContain('no marker was written');
  });

  it('an event that names no usable path still records every listed file that differs (security review LOW-4)', async () => {
    const watch = fakeWatch();
    const fake = live(async function* (cli) {
      yield INIT;
      watch.changes = [CHANGE, SECOND];
      await cli.configChange('user_settings');
      yield RESULT;
    });
    const b = build(fake, watch);
    const error = await stopOf(b.session.run('p'));
    expect(error).toMatchObject({ layer: 'config-change', changes: [CHANGE, SECOND] });
    expect(watch.recorded).toEqual([[CHANGE, SECOND]]);
    expect(b.warnings.at(-1)).toBe(MARKER_LINE);
  });
});

describe('a run is refused at its start while an earlier stop still stands (#264, owner ruling 4)', () => {
  it('the marker still matches: the fixed pending reason, the file named in a warning, layer marker', async () => {
    const watch = fakeWatch();
    watch.pendingValue = [CHANGE];
    const fake = live(async function* () {
      yield INIT;
      yield RESULT;
    });
    const b = build(fake, watch);
    const error = await stopOf(b.session.run('p'));
    expect(error).toMatchObject({ layer: 'marker', killOutcome: null, changes: [CHANGE] });
    expect(error.message).toBe(`settings changed: ${SETTINGS_CHANGE_PENDING_REASON}`);
    expect(b.warnings).toEqual([
      'settings changed: user:/cfg/settings.json (content) is not back in the state it was in before an earlier run was stopped',
      'settings changed: the marker file is /home/u/.harness/settings-changed.json',
    ]);
    expect(watch.calls).toEqual(['pending']);
  });

  it('a marker that cannot be read refuses the run too, with its own fixed reason', () => {
    const watch = fakeWatch();
    watch.pendingValue = 'unreadable';
    const lines: string[] = [];
    let thrown: unknown;
    try {
      assertNoPendingSettingsChange(watch, (line) => lines.push(line));
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SettingsChangeDetected);
    expect((thrown as SettingsChangeDetected).message).toBe(`settings changed: ${SETTINGS_CHANGE_MARKER_UNREADABLE_REASON}`);
    expect(lines).toEqual(['settings changed: the marker file at /home/u/.harness/settings-changed.json cannot be read']);
  });

  it('no marker: nothing is warned and nothing thrown', () => {
    const lines: string[] = [];
    expect(() => assertNoPendingSettingsChange(fakeWatch(), (line) => lines.push(line))).not.toThrow();
    expect(lines).toEqual([]);
  });
});

describe('createSettingsGuard (#264): one stop path', () => {
  function guard(outcome: ChildKillOutcome = 'killed') {
    const watch = fakeWatch();
    const order: string[] = [];
    const started: { run: () => void; ms: number; unref: number; cleared: boolean }[] = [];
    const timers: SettingsGuardTimers = {
      setInterval: (run, ms) => {
        const timer = { run, ms, unref: 0, cleared: false };
        started.push(timer);
        return { unref: () => (timer.unref += 1) };
      },
      clearInterval: () => {
        const last = started.at(-1);
        if (last !== undefined) last.cleared = true;
      },
    };
    const g = createSettingsGuard({
      watch,
      snapshot: watch.snapshot(),
      child: { kill: () => (order.push('kill'), outcome) },
      onStop: () => void order.push('abort'),
      timers,
    });
    watch.onStep = (step) => void order.push(step);
    return { g, watch, order, started };
  }

  it('the timer runs at the pinned interval, is unref\'d, starts once, and each tick is a re-check', () => {
    const { g, watch, started, order } = guard();
    g.start();
    g.start();
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ ms: 250, unref: 1, cleared: false });
    expect(SETTINGS_RECHECK_MS).toBe(250);
    started[0]?.run();
    expect(g.stopped()).toBeNull();
    watch.change = CHANGE;
    started[0]?.run();
    expect(g.stopped()?.error.layer).toBe('snapshot');
    // Two clean compares, the one that saw the change, the kill, the compare after it, the marker, the abort.
    expect(order).toEqual(['compare', 'compare', 'kill', 'compare', 'marker', 'abort']);
    expect(started[0]?.cleared).toBe(true);
    // A timer check is not forced; the compare after a stop is.
    expect(watch.forces).toEqual([false, false, true]);
  });

  it('dispose clears the timer and may be called again; a stopped guard starts no timer', () => {
    const { g, started, watch } = guard();
    g.start();
    g.dispose();
    g.dispose();
    expect(started[0]?.cleared).toBe(true);
    watch.change = CHANGE;
    g.check('result');
    g.start();
    expect(started).toHaveLength(1);
  });

  it('the kill comes first, and happens once however often the guard is asked', async () => {
    const { g, watch, order } = guard();
    watch.change = CHANGE;
    const first = g.check('tool-hook');
    expect(g.check('result')).toBe(first);
    expect(g.check('stream-end')).toBe(first);
    await g.configChangeCallback({ hook_event_name: 'ConfigChange', source: 'user_settings' }, undefined, { signal: new AbortController().signal });
    expect(order).toEqual(['compare', 'kill', 'compare', 'marker', 'abort']);
  });

  it("on the CLI's event the kill comes before anything is read: kill, then the compare, then the marker, then the abort", async () => {
    const { g, watch, order } = guard();
    watch.change = CHANGE;
    await g.configChangeCallback({ hook_event_name: 'ConfigChange', source: 'user_settings', file_path: CHANGE.path }, undefined, { signal: new AbortController().signal });
    expect(order).toEqual(['kill', 'compare', 'marker', 'abort']);
    expect(watch.recorded).toEqual([[CHANGE]]);
  });

  it('the checks that end a run are forced, the others are not', () => {
    const { g, watch } = guard();
    for (const at of ['timer', 'tool-hook', 'config-change', 'result', 'stream-end'] as const) g.check(at);
    expect(watch.forces).toEqual([false, false, false, true, true]);
  });

  it('after dispose the guard is inert: it compares nothing, kills nothing, writes nothing, and its event callback answers with nothing', async () => {
    const { g, watch, order } = guard();
    g.dispose();
    watch.change = CHANGE;
    expect(g.check('timer')).toBeNull();
    expect(g.check('stream-end')).toBeNull();
    expect(await g.configChangeCallback({ hook_event_name: 'ConfigChange', source: 'user_settings' }, undefined, { signal: new AbortController().signal })).toEqual({});
    g.start();
    expect(order).toEqual([]);
    expect(watch.recorded).toEqual([]);
  });

  it('a guard that stopped and was then disposed still says it stopped', () => {
    const { g, watch } = guard();
    watch.change = CHANGE;
    const stop = g.check('result');
    g.dispose();
    expect(g.check('stream-end')).toBe(stop);
    expect(g.stopped()).toBe(stop);
  });

  it('with nothing changed the guard kills nothing and aborts nothing', () => {
    const { g, order } = guard();
    for (const at of ['timer', 'tool-hook', 'config-change', 'result', 'stream-end'] as const) expect(g.check(at)).toBeNull();
    expect(order).toEqual(['compare', 'compare', 'compare', 'compare', 'compare']);
  });

  it.each([
    ['killed', KILLED_LINE],
    ['already-gone', 'settings changed: the CLI process had already exited'],
    ['not-owned', 'settings changed: the harness held no process to kill, so the CLI process was asked to stop and may have run for about two more seconds'],
    ['failed', 'settings changed: the CLI process could not be killed; it was asked to stop and may have run for about two more seconds'],
  ] as const)('a kill that reports %s is carried on the error and said in a line', (outcome, line) => {
    const { g, watch } = guard(outcome);
    watch.change = CHANGE;
    const stop = g.check('timer');
    expect(stop?.error.killOutcome).toBe(outcome);
    expect(stop?.warnings).toContain(line);
  });

  it('a path with control or bidi characters is cleaned in the line that names it', () => {
    const { g, watch } = guard();
    watch.change = { ...CHANGE, path: '/cfg/‮evil\u001b[31m/settings.json' };
    const line = g.check('timer')?.warnings[0] ?? '';
    expect(line).toContain('settings.json (content)');
    expect(line).not.toMatch(/[‮\u001b]/u);
  });

  it('an abort that throws does not undo the stop', () => {
    const watch = fakeWatch();
    watch.change = CHANGE;
    const g = createSettingsGuard({
      watch,
      snapshot: watch.snapshot(),
      child: { kill: () => 'killed' },
      onStop: () => {
        throw new Error('abort failed');
      },
    });
    expect(g.check('result')?.error).toBeInstanceOf(SettingsChangeDetected);
    expect(g.stopped()).not.toBeNull();
  });
});

describe('createSettingsWatch (#264): the real files, in a temporary home', () => {
  function world(root: string = mkdtempSync(join(tmpdir(), 'swatch-')), project = 'proj') {
    const homeDir = join(root, 'home');
    const cwd = join(root, project);
    const cfg = join(root, 'cfg');
    for (const dir of [homeDir, cwd, cfg, join(cwd, '.git')]) mkdirSync(dir, { recursive: true });
    const watch = createSettingsWatch({ homeDir, cwd, env: { CLAUDE_CONFIG_DIR: cfg }, managedDir: join(root, 'managed'), now: () => Date.UTC(2026, 10, 23) });
    return { root, homeDir, cwd, cfg, watch };
  }
  const HOOKS = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] } });
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
  const HOOKS_2 = JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'false' }] }] } });
  const ORIGINAL = JSON.stringify({ permissions: { deny: ['WebFetch'] } });
  /** A run in `w` during which `path` is written: the change the stop would record. */
  function stopOn(w: ReturnType<typeof world>, path: string, text: string | null): SettingsChange {
    const snapshot = w.watch.snapshot();
    if (text === null) rmSync(path);
    else {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text);
    }
    const found = snapshot.changes(true);
    if (found.length !== 1 || found[0] === undefined) throw new Error(`expected one change, saw ${found.length}`);
    w.watch.record(found);
    return found[0];
  }

  it('watches every source, whatever the run inherits: a user and a project settings file each show, together', () => {
    const w = world();
    const snapshot = w.watch.snapshot();
    expect(snapshot.changes()).toEqual([]);
    writeFileSync(join(w.cfg, 'settings.json'), HOOKS);
    mkdirSync(join(w.cwd, '.claude'));
    writeFileSync(join(w.cwd, '.claude', 'settings.json'), HOOKS);
    expect(snapshot.changes().map((c) => [c.source, c.path, c.kind])).toEqual([
      ['user', join(w.cfg, 'settings.json'), 'appeared'],
      ['project', join(w.cwd, '.claude', 'settings.json'), 'appeared'],
    ]);
  });

  it('the CLI creating its global config file is no change; an MCP server and a trusted project in it are', () => {
    const w = world();
    const snapshot = w.watch.snapshot();
    writeFileSync(join(w.cfg, '.claude.json'), JSON.stringify({ numStartups: 1 }));
    expect(snapshot.changes(true)).toEqual([]);
    writeFileSync(join(w.cfg, '.claude.json'), JSON.stringify({ numStartups: 1, mcpServers: { p: { command: '/tmp/x' } }, projects: { [w.cwd]: { hasTrustDialogAccepted: true } } }));
    expect(snapshot.changes(true)).toMatchObject([{ source: 'global', kind: 'global-config' }]);
  });

  it('the marker is under the home directory and holds the start state beside the state seen', () => {
    const w = world();
    const file = join(w.cfg, 'settings.json');
    writeFileSync(file, ORIGINAL);
    const change = stopOn(w, file, HOOKS);
    expect(w.watch.markerPath).toBe(join(w.homeDir, '.harness', 'settings-changed.json'));
    expect(JSON.parse(readFileSync(w.watch.markerPath, 'utf8'))).toEqual({ version: 1, entries: [{ ...change, detectedAt: '2026-11-23T00:00:00.000Z' }] });
    expect(change).toEqual({ source: 'user', path: file, kind: 'content', fingerprint: `file||sha256:${sha(HOOKS)}`, baseline: `file||sha256:${sha(ORIGINAL)}` });
    expect(w.watch.pending()).toEqual([{ ...change, detectedAt: '2026-11-23T00:00:00.000Z' }]);
  });

  it('R2-1: a later write does NOT clear the entry, and reading the marker does not rewrite it', () => {
    const w = world();
    const file = join(w.cfg, 'settings.json');
    writeFileSync(file, ORIGINAL);
    stopOn(w, file, HOOKS);
    const bytes = readFileSync(w.watch.markerPath, 'utf8');
    const stamp = statSync(w.watch.markerPath).mtimeMs;
    // What a process that outlived the stop does: a second, different write.
    writeFileSync(file, HOOKS_2);
    expect(w.watch.pending()).toHaveLength(1);
    writeFileSync(file, '{}');
    expect(w.watch.pending()).toHaveLength(1);
    expect(readFileSync(w.watch.markerPath, 'utf8')).toBe(bytes);
    expect(statSync(w.watch.markerPath).mtimeMs).toBe(stamp);
    expect(existsSync(`${w.watch.markerPath}.lock`)).toBe(false);
  });

  it('R2-1: the entry clears when the file is back as it was at the start, and the marker goes with its last entry', () => {
    const w = world();
    const file = join(w.cfg, 'settings.json');
    writeFileSync(file, ORIGINAL);
    stopOn(w, file, HOOKS);
    writeFileSync(file, ORIGINAL);
    expect(w.watch.pending()).toEqual([]);
    expect(existsSync(w.watch.markerPath)).toBe(false);
  });

  it('R2-1: a file that did not exist at the start clears when it is removed, and not while anything is there', () => {
    const w = world();
    const file = join(w.cfg, 'settings.json');
    stopOn(w, file, HOOKS);
    writeFileSync(file, '{}');
    expect(w.watch.pending()).toHaveLength(1);
    rmSync(file);
    expect(w.watch.pending()).toEqual([]);
    expect(existsSync(w.watch.markerPath)).toBe(false);
  });

  it('R2-5: a deleted file keeps refusing until it is put back', () => {
    const w = world();
    const file = join(w.cfg, 'settings.json');
    writeFileSync(file, ORIGINAL);
    const change = stopOn(w, file, null);
    expect(change).toMatchObject({ kind: 'deleted', fingerprint: 'absent||absent' });
    expect(w.watch.pending()).toHaveLength(1);
    expect(w.watch.pending()).toHaveLength(1);
    writeFileSync(file, HOOKS);
    expect(w.watch.pending()).toHaveLength(1);
    writeFileSync(file, ORIGINAL);
    expect(w.watch.pending()).toEqual([]);
  });

  it('only the entry that is back at its start state is dropped; the other stays in the marker', () => {
    const w = world();
    const user = join(w.cfg, 'settings.json');
    const project = join(w.cwd, '.claude', 'settings.json');
    stopOn(w, user, HOOKS);
    stopOn(w, project, HOOKS);
    expect(w.watch.pending()).toHaveLength(2);
    rmSync(user);
    const left = w.watch.pending();
    expect(left === 'unreadable' ? left : left.map((entry) => entry.path)).toEqual([project]);
    expect(JSON.parse(readFileSync(w.watch.markerPath, 'utf8')).entries).toHaveLength(1);
  });

  it('a second stop on the same path keeps the first start state: the planted file is never taken for the original', () => {
    const w = world();
    const file = join(w.cfg, 'settings.json');
    writeFileSync(file, ORIGINAL);
    const first = stopOn(w, file, HOOKS);
    // Marker deleted by the operator without restoring? No: here a run that began with the planted file in place stops again.
    const second = stopOn(w, file, HOOKS_2);
    expect(second.baseline).toBe(first.fingerprint);
    const entries = JSON.parse(readFileSync(w.watch.markerPath, 'utf8')).entries as SettingsChange[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ fingerprint: second.fingerprint, baseline: first.baseline });
    writeFileSync(file, HOOKS);
    expect(w.watch.pending()).toHaveLength(1);
    writeFileSync(file, ORIGINAL);
    expect(w.watch.pending()).toEqual([]);
  });

  describe('R2-2: which runs an entry refuses', () => {
    it('a project or local entry refuses a run in that project and not a run in another one; the marker keeps it either way', () => {
      const a = world();
      const b = world(a.root, 'other');
      stopOn(a, join(a.cwd, '.claude', 'settings.json'), HOOKS);
      stopOn(a, join(a.cwd, '.claude', 'settings.local.json'), HOOKS);
      expect(a.watch.pending()).toHaveLength(2);
      expect(b.watch.pending()).toEqual([]);
      expect(JSON.parse(readFileSync(a.watch.markerPath, 'utf8')).entries).toHaveLength(2);
      expect(a.watch.pending()).toHaveLength(2);
    });

    it('a project entry refuses a run started in a directory below that project, whose list reaches up to it', () => {
      const a = world();
      stopOn(a, join(a.cwd, '.claude', 'settings.json'), HOOKS);
      mkdirSync(join(a.cwd, 'packages', 'x'), { recursive: true });
      const below = createSettingsWatch({ homeDir: a.homeDir, cwd: join(a.cwd, 'packages', 'x'), env: { CLAUDE_CONFIG_DIR: a.cfg }, managedDir: join(a.root, 'managed') });
      expect(below.pending()).toHaveLength(1);
    });

    it.each(['user', 'global', 'managed'] as const)('a %s entry refuses every run, in any project and under any config directory', (source) => {
      const a = world();
      const b = world(a.root, 'other');
      const elsewhere = createSettingsWatch({ homeDir: a.homeDir, cwd: b.cwd, env: { CLAUDE_CONFIG_DIR: join(a.root, 'another-cfg') }, managedDir: join(a.root, 'another-managed') });
      const path = join(a.root, 'somewhere', `${source}.json`);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, source === 'global' ? JSON.stringify({ env: { X: '1' } }) : HOOKS);
      a.watch.record([{ source, path, kind: source === 'global' ? 'global-config' : 'content', fingerprint: 'seen', baseline: source === 'global' ? 'verdict:pass|keys:none' : 'absent||absent' }]);
      expect(a.watch.pending()).toHaveLength(1);
      expect(b.watch.pending()).toHaveLength(1);
      expect(elsewhere.pending()).toHaveLength(1);
    });
  });

  it('a path the CLI named that the list does not hold has no known start state: it refuses until the marker is deleted', () => {
    const w = world();
    const odd = join(w.cfg, 'not-on-the-list.json');
    writeFileSync(odd, HOOKS);
    const reported = w.watch.reported('user', odd);
    expect(reported).toMatchObject({ kind: 'reported', baseline: 'unknown' });
    w.watch.record([reported]);
    rmSync(odd);
    expect(w.watch.pending()).toHaveLength(1);
    rmSync(w.watch.markerPath);
    expect(w.watch.pending()).toEqual([]);
  });

  it('R3-4: no entry is ever dropped; past the cap the marker refuses every run, in every project, and the write says so', () => {
    const w = world();
    const other = world(w.root, 'other');
    const many = Array.from({ length: 256 }, (_unused, i): SettingsChange => ({ source: 'project', path: join(w.root, 'elsewhere', `${i}.json`), kind: 'content', fingerprint: 'seen', baseline: 'file||sha256:start' }));
    expect(w.watch.record(many)).toBe('ok');
    // 256 entries for paths on no run's list: nothing is refused yet.
    expect(other.watch.pending()).toEqual([]);
    expect(w.watch.record([{ ...many[0]!, path: join(w.root, 'elsewhere', 'one-more.json') }])).toBe('over-cap');
    expect((JSON.parse(readFileSync(w.watch.markerPath, 'utf8')) as { entries: unknown[] }).entries).toHaveLength(257);
    expect(w.watch.pending()).toBe('unreadable');
    expect(other.watch.pending()).toBe('unreadable');
    // A later stop still merges into all of them: none is lost to the cap.
    expect(w.watch.record([{ ...many[0]!, path: join(w.root, 'elsewhere', 'and-another.json') }])).toBe('over-cap');
    expect((JSON.parse(readFileSync(w.watch.markerPath, 'utf8')) as { entries: unknown[] }).entries).toHaveLength(258);
  });

  it('a marker that is not one is unreadable', () => {
    const w = world();
    stopOn(w, join(w.cfg, 'settings.json'), HOOKS);
    writeFileSync(w.watch.markerPath, 'garbage');
    expect(w.watch.pending()).toBe('unreadable');
  });

  it('a relative config directory is resolved against the working directory, so the marker holds absolute paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'swatch-rel-'));
    mkdirSync(join(root, 'proj', 'relcfg'), { recursive: true });
    mkdirSync(join(root, 'proj', '.git'));
    const watch = createSettingsWatch({ homeDir: join(root, 'home'), cwd: join(root, 'proj'), env: { CLAUDE_CONFIG_DIR: 'relcfg' }, managedDir: join(root, 'managed') });
    const snapshot = watch.snapshot();
    writeFileSync(join(root, 'proj', 'relcfg', 'settings.json'), HOOKS);
    expect(snapshot.changes().map((c) => c.path)).toEqual([join(root, 'proj', 'relcfg', 'settings.json')]);
  });
});
