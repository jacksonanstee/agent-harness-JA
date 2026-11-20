import { afterEach, describe, expect, it } from 'vitest';

import { createHookRuntime } from '../hooks/index.js';
import { createMemoryStore, openMemoryDatabase } from '../memory/index.js';
import { route } from '../router/index.js';
import type { TelemetryEvent, TelemetryEventInput } from '../telemetry/index.js';
import { fakeChild } from '../../test/prompt-hook.js';
import { spawnChildProcess } from './child-process.js';
import type { ChildKillOutcome } from './child-process.js';
import { CHILD_NOT_OWNED_REASON, ChildNotOwned, createHookCanary, HOOK_CANARY_REASON, HookCanaryMissed } from './hook-canary.js';
import type { CanaryCheckpoint, HookCanary } from './hook-canary.js';
import { createSession } from './session.js';
import type { QueryFn, QueryOptions, SdkMessage, SdkSpawnedProcess, SessionDeps, SpawnChildFn } from './types.js';

// Issue #251. With the CLI's bare mode on, no hook the session registered ran. The canary is the
// session's own prompt hook: the CLI calls it before it sends its init message (observed), so an
// init or assistant message with the canary silent stops the run, and so does a result message or
// the end of the stream. The session kills the CLI itself: it started the process, through the
// SDK's spawn option, and holds it (`child-process.ts`). A turn that starts with no process held
// (a query function that never called the spawn function) is stopped too, whether or not the hook
// ran. These tests use the bare `createSession`; the fakes decide for themselves whether the hook
// is called and whether the spawn function is.

const KILLED_LINE = 'hook canary missed: the CLI process was killed at once';
const GONE_LINE = 'hook canary missed: the CLI process had already exited';
const NOT_HELD_LINE = 'hook canary missed: the harness held no process to kill, so the CLI process was asked to stop and may have run for about two more seconds';
const NOT_KILLED_LINE = 'hook canary missed: the CLI process could not be killed; it was asked to stop and may have run for about two more seconds';
const MISSED_LINE = `hook canary missed: ${HOOK_CANARY_REASON}`;
const NOT_OWNED_LINE = `child not owned: ${CHILD_NOT_OWNED_REASON}`;
const NOT_OWNED_STOP_LINE = 'child not owned: the harness holds no process to signal, so the CLI process was asked to stop and may have run for about two more seconds';
const INIT_NOT_RUN = 'init check did not run';
const CHECKPOINTS: readonly CanaryCheckpoint[] = ['turn-start', 'result', 'stream-end'];

const PROMPT_INPUT = { hook_event_name: 'UserPromptSubmit' as const, prompt: 'p', session_id: 'sdk-1' };
const fire = (canary: HookCanary) => canary.callback(PROMPT_INPUT, undefined, { signal: new AbortController().signal });

const INIT: SdkMessage = { type: 'system', subtype: 'init', session_id: 'sdk-1' };
const ASSISTANT = { type: 'assistant', message: { content: [{ type: 'text', text: 'model text' }] } } as SdkMessage;
const STATUS = { type: 'system', subtype: 'status', session_id: 'sdk-1' } as SdkMessage;
const RESULT = { type: 'result', subtype: 'success', result: 'done', session_id: 'sdk-1', num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } } as SdkMessage;

const children: SdkSpawnedProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && (child.signalCode ?? null) === null) child.kill('SIGKILL');
});
/** A real process that does nothing until it is killed, started as the harness starts the CLI: a stand-in for the CLI child. */
function idleChild(): { child: SdkSpawnedProcess; exit: Promise<NodeJS.Signals | number | null> } {
  const child = spawnChildProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: {}, signal: new AbortController().signal });
  children.push(child);
  return { child, exit: new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal ?? code))) };
}

interface Script {
  /**
   * The process the session's spawn function hands back when the fake calls it, as the SDK does to
   * start the CLI. Default: a stand-in that starts nothing. `null`: the fake never calls it.
   */
  child?: SdkSpawnedProcess | null;
  /** Call the session's prompt hook before the first message, as a CLI with hooks on does. */
  fireCanary?: 'before' | 'after-first' | 'never';
  messages: SdkMessage[];
  /** Thrown when the stream is closed early, as an SDK that fails while a stopped stream closes. */
  throwOnClose?: Error;
  /** Thrown by the stream after its last message, as an SDK whose child died. */
  throwAtEnd?: Error;
  /** Awaited before that throw, as an SDK that throws once its child has exited. */
  beforeThrow?: Promise<unknown>;
  /** Called just before the first message is yielded. */
  beforeFirst?: () => void;
}

function scripted(script: Script) {
  const options: QueryOptions[] = [];
  const yielded: SdkMessage[] = [];
  let closed = 0;
  const query: QueryFn = (args) => {
    if (args.options !== undefined) options.push(args.options);
    if (script.child !== null) args.options?.spawnClaudeCodeProcess?.({ command: 'fake', args: [], env: {}, signal: new AbortController().signal });
    const fire = async (): Promise<void> => {
      for (const matcher of args.options?.hooks?.UserPromptSubmit ?? []) {
        for (const callback of matcher.hooks) await callback({ ...PROMPT_INPUT, prompt: args.prompt }, undefined, { signal: new AbortController().signal });
      }
    };
    const inner = (async function* () {
      try {
        if ((script.fireCanary ?? 'never') === 'before') await fire();
        for (const [i, message] of script.messages.entries()) {
          if (i === 0) script.beforeFirst?.();
          yielded.push(message);
          yield message;
          if (i === 0 && script.fireCanary === 'after-first') await fire();
        }
        if (script.beforeThrow !== undefined) await script.beforeThrow;
        if (script.throwAtEnd !== undefined) throw script.throwAtEnd;
      } finally {
        closed += 1;
      }
    })();
    if (script.throwOnClose === undefined) return inner;
    const failure = script.throwOnClose;
    // Closing this stream early rejects, after the generator itself has closed.
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => inner.next(),
        return: async () => {
          await inner.return(undefined);
          throw failure;
        },
      }),
    };
  };
  const child = script.child ?? fakeChild();
  const spawnChild: SpawnChildFn = () => child;
  return { query, spawnChild, options, yielded, closed: () => closed };
}

function build(fake: { query: QueryFn; spawnChild: SpawnChildFn }, overrides: Partial<SessionDeps> = {}) {
  const { query, spawnChild } = fake;
  const events: TelemetryEventInput[] = [];
  const memoryDb = openMemoryDatabase({ path: ':memory:' });
  const memory = createMemoryStore(memoryDb);
  const hooks = createHookRuntime();
  const fired: string[] = [];
  hooks.register('stop', () => {
    fired.push('stop');
  });
  const deps: SessionDeps = {
    query,
    hooks,
    memory,
    loadSkills: () => ({ skills: [], errors: [], root: '/skills' }),
    route,
    scanAgents: () => ({ admittedNames: new Set<string>(), refusals: [], filesScanned: 0 }),
    scanSettingsEnv: () => [],
    spawnChild,
    telemetry: {
      record: (event) => {
        events.push(event);
        return { ok: true, value: { ...event, id: 'evt', ts: 1 } as TelemetryEvent };
      },
    },
    ...overrides,
  };
  return { deps, events, memory, fired };
}

/** A canary over a stand-in owner that records each kill. */
function canaryWith(state: { owned: boolean; outcome?: ChildKillOutcome }) {
  let kills = 0;
  const canary = createHookCanary({
    owned: () => state.owned,
    kill: () => {
      kills += 1;
      return state.outcome ?? (state.owned ? 'killed' : 'not-owned');
    },
  });
  return { canary, kills: () => kills };
}

describe('createHookCanary', () => {
  it('has not fired until its callback is called, and the callback returns an empty output', async () => {
    const { canary } = canaryWith({ owned: true });
    expect(canary.fired()).toBe(false);
    await expect(fire(canary)).resolves.toEqual({});
    expect(canary.fired()).toBe(true);
  });

  it("each canary is its own: one firing does not mark another, and one's process is not another's", async () => {
    const a = canaryWith({ owned: true });
    const b = canaryWith({ owned: false });
    await fire(a.canary);
    expect(b.canary.fired()).toBe(false);
    expect(b.canary.check('turn-start')?.error).toBeInstanceOf(ChildNotOwned);
    expect(a.canary.check('turn-start')).toBeNull();
  });

  it.each(CHECKPOINTS)('at %s, a canary that fired over a held process carries on, and nothing is killed', async (at) => {
    const { canary, kills } = canaryWith({ owned: true });
    await fire(canary);
    expect(canary.check(at)).toBeNull();
    expect(kills()).toBe(0);
  });

  it.each(CHECKPOINTS)('at %s, a silent canary kills the held process, once, and returns the miss with its two lines', (at) => {
    const { canary, kills } = canaryWith({ owned: true });
    const stop = canary.check(at);
    expect(kills()).toBe(1);
    expect(stop?.error).toBeInstanceOf(HookCanaryMissed);
    expect((stop?.error as HookCanaryMissed).killOutcome).toBe('killed');
    expect(stop?.warnings).toEqual([MISSED_LINE, KILLED_LINE]);
  });

  it.each([
    [true, 'the hook ran'],
    [false, 'the hook did not run'],
  ])('at the turn start with no process held the run is stopped as ChildNotOwned (fired: %s, %s), and no kill is tried', async (fired) => {
    const { canary, kills } = canaryWith({ owned: false });
    if (fired) await fire(canary);
    const stop = canary.check('turn-start');
    expect(stop?.error).toBeInstanceOf(ChildNotOwned);
    expect(stop?.error).not.toBeInstanceOf(HookCanaryMissed);
    expect(stop?.warnings).toEqual([NOT_OWNED_LINE, NOT_OWNED_STOP_LINE]);
    expect(kills()).toBe(0);
  });

  it.each(['result', 'stream-end'] as const)("the not-owned rule is the turn start's: at %s a canary that fired carries on with no process held", async (at) => {
    const { canary } = canaryWith({ owned: false });
    await fire(canary);
    expect(canary.check(at)).toBeNull();
  });

  it.each(['result', 'stream-end'] as const)('at %s a silent canary with no process held is a miss that says nothing was killed', (at) => {
    const { canary } = canaryWith({ owned: false });
    const stop = canary.check(at);
    expect(stop?.error).toBeInstanceOf(HookCanaryMissed);
    expect((stop?.error as HookCanaryMissed).killOutcome).toBe('not-owned');
    expect((stop?.error as HookCanaryMissed).childKilled).toBe(false);
    expect(stop?.warnings).toEqual([MISSED_LINE, NOT_HELD_LINE]);
  });

  it.each([
    ['already-gone', GONE_LINE],
    ['failed', NOT_KILLED_LINE],
  ] as const)('a kill that reports %s is a miss with that outcome and its own line', (outcome, line) => {
    const { canary } = canaryWith({ owned: true, outcome });
    const stop = canary.check('turn-start');
    expect((stop?.error as HookCanaryMissed).killOutcome).toBe(outcome);
    expect(stop?.warnings).toEqual([MISSED_LINE, line]);
  });
});

describe('the two errors: fixed text, and what the kill did', () => {
  it.each([
    ['killed', true],
    ['already-gone', true],
    ['not-owned', false],
    ['failed', false],
  ] as const)('HookCanaryMissed(%s) carries the outcome, and childKilled is %s', (outcome: ChildKillOutcome, childKilled) => {
    const error = new HookCanaryMissed(outcome);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('HookCanaryMissed');
    expect(error.message).toBe(MISSED_LINE);
    expect(error.killOutcome).toBe(outcome);
    expect(error.childKilled).toBe(childKilled);
  });

  it('ChildNotOwned has its own fixed message', () => {
    const error = new ChildNotOwned();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ChildNotOwned');
    expect(error.message).toBe(NOT_OWNED_LINE);
  });

  it.each([
    ['HOOK_CANARY_REASON', HOOK_CANARY_REASON],
    ['CHILD_NOT_OWNED_REASON', CHILD_NOT_OWNED_REASON],
  ])('%s names the issue, no variable, and no example of a prompt', (_name, reason) => {
    expect(reason).toContain('#251');
    expect(reason).not.toMatch(/CLAUDE_|ANTHROPIC_/i);
    expect(reason).not.toMatch(/slash|\/[a-z]/i);
  });
});

describe('the session registers the canary and stops a run whose CLI never called it (#251)', () => {
  it('a missed canary kills the child the SDK reported, with SIGKILL, and says so', async () => {
    const { child, exit } = idleChild();
    const fake = scripted({ child, messages: [INIT, ASSISTANT, RESULT] });
    const warnings: string[] = [];
    const run = createSession(build(fake).deps, { skillsDir: null, onWarning: (w) => warnings.push(w) }).run('p');
    await expect(run).rejects.toThrow(HookCanaryMissed);
    await expect(run).rejects.toMatchObject({ killOutcome: 'killed', childKilled: true });
    await expect(exit).resolves.toBe('SIGKILL');
    expect(warnings).toContain(KILLED_LINE);
  });

  it('a run whose canary fired never kills the child', async () => {
    const { child } = idleChild();
    const fake = scripted({ child, fireCanary: 'before', messages: [INIT, ASSISTANT, RESULT] });
    await createSession(build(fake).deps, { skillsDir: null }).run('p');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  });

  it("passes the SDK a spawn function on the primary query, and it is the session's own wrapper: the process it returns is the one the dependency made", async () => {
    const child = fakeChild();
    const fake = scripted({ child, fireCanary: 'before', messages: [INIT, RESULT] });
    const seen: unknown[] = [];
    const b = build({ query: fake.query, spawnChild: (o) => (seen.push(o), child) });
    await createSession(b.deps, { skillsDir: null }).run('p');
    const spawn = fake.options[0]?.spawnClaudeCodeProcess;
    expect(typeof spawn).toBe('function');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ command: 'fake' });
    expect(child.signals).toEqual([]);
  });

  it('a missed canary signals the process the spawn dependency returned, with SIGKILL', async () => {
    const child = fakeChild();
    const fake = scripted({ child, messages: [INIT, RESULT] });
    await expect(createSession(build(fake).deps, { skillsDir: null }).run('p')).rejects.toThrow(HookCanaryMissed);
    expect(child.signals).toEqual(['SIGKILL']);
  });

  it('registers exactly one UserPromptSubmit matcher with one callback, beside the three tool hooks', async () => {
    const fake = scripted({ fireCanary: 'before', messages: [INIT, RESULT] });
    await createSession(build(fake).deps, { skillsDir: null }).run('p');
    const hooks = fake.options[0]?.hooks;
    expect(Object.keys(hooks ?? {}).sort()).toEqual(['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'UserPromptSubmit']);
    expect(hooks?.UserPromptSubmit).toHaveLength(1);
    expect(hooks?.UserPromptSubmit?.[0]?.hooks).toHaveLength(1);
    expect(Object.keys(hooks?.UserPromptSubmit?.[0] ?? {})).toEqual(['hooks']);
  });

  it('a run whose CLI called the hook before its init message completes as before', async () => {
    const fake = scripted({ fireCanary: 'before', messages: [INIT, ASSISTANT, RESULT] });
    const warnings: string[] = [];
    const result = await createSession(build(fake).deps, { skillsDir: null, onWarning: (w) => warnings.push(w) }).run('p');
    expect(result.resultText).toBe('done');
    expect(fake.yielded).toHaveLength(3);
    expect(fake.options[0]?.abortController?.signal.aborted).toBe(false);
    expect(warnings.filter((w) => w.startsWith('hook canary missed') || w.startsWith('child not owned'))).toEqual([]);
  });

  it('an init message with the canary silent stops the run: HookCanaryMissed, the child aborted, nothing after the init message read', async () => {
    const fake = scripted({ messages: [INIT, ASSISTANT, RESULT] });
    const texts: string[] = [];
    const warnings: string[] = [];
    const b = build(fake);
    const run = createSession(b.deps, { skillsDir: null, onText: (t) => texts.push(t), onWarning: (w) => warnings.push(w) }).run('p');
    await expect(run).rejects.toThrow(HookCanaryMissed);
    await expect(run).rejects.toThrow(MISSED_LINE);
    expect(fake.yielded).toEqual([INIT]);
    expect(fake.closed()).toBe(1);
    expect(fake.options[0]?.abortController?.signal.aborted).toBe(true);
    expect(texts).toEqual([]);
    // The stand-in process took the signal: the second line says the child was killed.
    expect(warnings.filter((w) => w.startsWith('hook canary missed'))).toEqual([MISSED_LINE, KILLED_LINE]);
  });

  it('an assistant message with the canary silent stops the run too, when no init message came first; its text is not emitted', async () => {
    const fake = scripted({ messages: [ASSISTANT, RESULT] });
    const texts: string[] = [];
    const run = createSession(build(fake).deps, { skillsDir: null, onText: (t) => texts.push(t) }).run('p');
    await expect(run).rejects.toThrow(HookCanaryMissed);
    expect(fake.yielded).toEqual([ASSISTANT]);
    expect(fake.options[0]?.abortController?.signal.aborted).toBe(true);
    expect(texts).toEqual([]);
  });

  it('the hook must have run BEFORE the message: a canary that fires after the init message is too late', async () => {
    const fake = scripted({ fireCanary: 'after-first', messages: [INIT, RESULT] });
    await expect(createSession(build(fake).deps, { skillsDir: null }).run('p')).rejects.toThrow(HookCanaryMissed);
    expect(fake.yielded).toEqual([INIT]);
  });

  it('each run has its own canary: a first run that fired does not vouch for a second that did not', async () => {
    let n = 0;
    const live = scripted({ fireCanary: 'before', messages: [INIT, RESULT] });
    const bare = scripted({ messages: [INIT, RESULT] });
    const query: QueryFn = (args) => (n++ === 0 ? live.query(args) : bare.query(args));
    const session = createSession(build({ query, spawnChild: live.spawnChild }).deps, { skillsDir: null });
    await expect(session.run('p')).resolves.toMatchObject({ resultText: 'done' });
    await expect(session.run('p')).rejects.toThrow(HookCanaryMissed);
  });

  it('each run has its own owner: a first run that started a process does not lend it to a second that did not', async () => {
    let n = 0;
    const first = scripted({ fireCanary: 'before', messages: [INIT, RESULT] });
    const second = scripted({ child: null, fireCanary: 'before', messages: [INIT, RESULT] });
    const query: QueryFn = (args) => (n++ === 0 ? first.query(args) : second.query(args));
    const session = createSession(build({ query, spawnChild: first.spawnChild }).deps, { skillsDir: null });
    await expect(session.run('p')).resolves.toMatchObject({ resultText: 'done' });
    await expect(session.run('p')).rejects.toThrow(ChildNotOwned);
  });

  it('the stopped run still fires the stop hook, writes its turn-cost row as not interrupted, and leaves a failed memory entry', async () => {
    const fake = scripted({ messages: [INIT, RESULT] });
    const b = build(fake);
    await expect(createSession(b.deps, { skillsDir: null }).run('p')).rejects.toThrow(HookCanaryMissed);
    expect(b.fired).toEqual(['stop']);
    const cost = b.events.filter((event) => event.type === 'turn-cost');
    expect(cost).toHaveLength(1);
    expect(cost[0]?.payload).toMatchObject({ interrupted: false, resultSubtype: null });
    const rows = b.memory.read({ type: 'project' });
    expect(rows.map((row) => (JSON.parse(row.content) as { failed: boolean }).failed)).toEqual([true]);
  });

  it("the caller's signal is not aborted, and an SDK throw while the stopped stream closes does not replace the canary's error", async () => {
    const fake = scripted({ messages: [INIT, RESULT], throwOnClose: new Error('SDK: process exited with code 143') });
    const caller = new AbortController();
    const run = createSession(build(fake).deps, { skillsDir: null, signal: caller.signal }).run('p');
    await expect(run).rejects.toThrow(HookCanaryMissed);
    expect(caller.signal.aborted).toBe(false);
  });

  it('a stop does not also say the init check did not run: the init message arrived and was set aside unread', async () => {
    const fake = scripted({ messages: [INIT, RESULT] });
    const warnings: string[] = [];
    await expect(createSession(build(fake).deps, { skillsDir: null, onWarning: (w) => warnings.push(w) }).run('p')).rejects.toThrow(HookCanaryMissed);
    expect(warnings.filter((w) => w.includes(INIT_NOT_RUN))).toEqual([]);
  });

  it('a healthy run with no init message still says the init check did not run', async () => {
    const fake = scripted({ fireCanary: 'before', messages: [ASSISTANT, RESULT] });
    const warnings: string[] = [];
    await createSession(build(fake).deps, { skillsDir: null, onWarning: (w) => warnings.push(w) }).run('p');
    expect(warnings.filter((w) => w.includes(INIT_NOT_RUN))).toHaveLength(1);
  });
});

describe('no process held at the start of the turn: the run is stopped there (#251)', () => {
  it.each([
    ['an init message', [INIT, ASSISTANT, RESULT], INIT],
    ['an assistant message', [ASSISTANT, RESULT], ASSISTANT],
  ])('%s from a query that never called the spawn function stops the run although the hook ran: ChildNotOwned, aborted, nothing more read, no text', async (_name, messages, first) => {
    const fake = scripted({ child: null, fireCanary: 'before', messages });
    const texts: string[] = [];
    const warnings: string[] = [];
    const run = createSession(build(fake).deps, { skillsDir: null, onText: (t) => texts.push(t), onWarning: (w) => warnings.push(w) }).run('p');
    await expect(run).rejects.toThrow(ChildNotOwned);
    await expect(run).rejects.toThrow(NOT_OWNED_LINE);
    expect(fake.yielded).toEqual([first]);
    expect(fake.closed()).toBe(1);
    expect(fake.options[0]?.abortController?.signal.aborted).toBe(true);
    expect(texts).toEqual([]);
    expect(warnings.filter((w) => w.startsWith('child not owned'))).toEqual([NOT_OWNED_LINE, NOT_OWNED_STOP_LINE]);
    expect(warnings.filter((w) => w.startsWith('hook canary missed'))).toEqual([]);
    expect(warnings.filter((w) => w.includes(INIT_NOT_RUN))).toEqual([]);
  });

  it('with no process held and the hook silent it is still ChildNotOwned: nothing could be killed, and the run does not claim a kill', async () => {
    const fake = scripted({ child: null, messages: [INIT, RESULT] });
    const run = createSession(build(fake).deps, { skillsDir: null }).run('p');
    await expect(run).rejects.toThrow(ChildNotOwned);
    await expect(run).rejects.not.toBeInstanceOf(HookCanaryMissed);
    expect(fake.options[0]?.abortController?.signal.aborted).toBe(true);
  });

  it('the stopped run still fires the stop hook and leaves a failed memory entry', async () => {
    const fake = scripted({ child: null, fireCanary: 'before', messages: [INIT, RESULT] });
    const b = build(fake);
    await expect(createSession(b.deps, { skillsDir: null }).run('p')).rejects.toThrow(ChildNotOwned);
    expect(b.fired).toEqual(['stop']);
    const rows = b.memory.read({ type: 'project' });
    expect(rows.map((row) => (JSON.parse(row.content) as { failed: boolean }).failed)).toEqual([true]);
  });
});

describe('no run completes with the canary silent: the result message and the end of the stream are checked too (#251)', () => {
  it('a result message with the canary silent and no init or assistant message before it stops the run; the result is not returned', async () => {
    const { child, exit } = idleChild();
    const fake = scripted({ child, messages: [RESULT] });
    const warnings: string[] = [];
    const run = createSession(build(fake).deps, { skillsDir: null, onWarning: (w) => warnings.push(w) }).run('p');
    await expect(run).rejects.toThrow(HookCanaryMissed);
    await expect(exit).resolves.toBe('SIGKILL');
    expect(fake.options[0]?.abortController?.signal.aborted).toBe(true);
    expect(warnings.filter((w) => w.startsWith('hook canary missed'))).toEqual([MISSED_LINE, KILLED_LINE]);
  });

  it.each([
    ['no message at all', []],
    ['only a message that is not init, assistant or result', [STATUS]],
  ])('a stream that ends with %s and the canary silent is a miss', async (_name, messages) => {
    const { child, exit } = idleChild();
    const fake = scripted({ child, messages });
    const run = createSession(build(fake).deps, { skillsDir: null }).run('p');
    await expect(run).rejects.toThrow(HookCanaryMissed);
    await expect(exit).resolves.toBe('SIGKILL');
  });

  it("a result-only stream whose hook ran completes, with or without a process held (the not-owned rule is the turn start's)", async () => {
    for (const held of [true, false]) {
      const fake = scripted({ ...(held ? {} : { child: null }), fireCanary: 'before', messages: [RESULT] });
      const result = await createSession(build(fake).deps, { skillsDir: null }).run('p');
      expect(result.resultText).toBe('done');
      expect(fake.options[0]?.abortController?.signal.aborted).toBe(false);
    }
  });

  it('a stream that fails keeps its own error: the end-of-stream check is for a stream that ended on its own', async () => {
    const failure = new Error('SDK: process exited with code 1');
    const fake = scripted({ messages: [STATUS], throwAtEnd: failure });
    const warnings: string[] = [];
    await expect(createSession(build(fake).deps, { skillsDir: null, onWarning: (w) => warnings.push(w) }).run('p')).rejects.toBe(failure);
    expect(warnings.filter((w) => w.startsWith('hook canary missed'))).toEqual([]);
  });
});

describe("the caller's own interrupt comes first (#251)", () => {
  it('a run the caller aborted ends as an interrupt, not as a missed canary, though the miss is still acted on and warned', async () => {
    const { child, exit } = idleChild();
    const caller = new AbortController();
    const fake = scripted({ child, messages: [INIT, ASSISTANT, RESULT], beforeFirst: () => caller.abort() });
    const warnings: string[] = [];
    const result = await createSession(build(fake).deps, { skillsDir: null, signal: caller.signal, onWarning: (w) => warnings.push(w) }).run('p');
    expect(result.interrupted).toBe(true);
    expect(result.resultText).toBeNull();
    expect(fake.yielded).toEqual([INIT]);
    await expect(exit).resolves.toBe('SIGKILL');
    expect(warnings.filter((w) => w.startsWith('hook canary missed'))).toEqual([MISSED_LINE, KILLED_LINE]);
  });

  it("an SDK throw while the caller's aborted stream closes is what the run rejects with, not the canary's error", async () => {
    const caller = new AbortController();
    const failure = new Error('SDK: aborted by user');
    const fake = scripted({ messages: [INIT, RESULT], beforeFirst: () => caller.abort(), throwOnClose: failure });
    await expect(createSession(build(fake).deps, { skillsDir: null, signal: caller.signal }).run('p')).rejects.toBe(failure);
  });
});

describe("the child's last words on stderr go on the SDK's exit error (#251, owner ruling 20/11/2026)", () => {
  function exiting(script: string): { child: SdkSpawnedProcess; exit: Promise<NodeJS.Signals | number | null> } {
    const child = spawnChildProcess({ command: process.execPath, args: ['-e', script], env: {}, signal: new AbortController().signal });
    children.push(child);
    return { child, exit: new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal ?? code))) };
  }

  it('a stream that fails after its child exited non-zero rejects with the same error, the stderr tail on its message', async () => {
    const { child, exit } = exiting("process.stderr.write('the CLI said why\\n', () => process.exit(2))");
    const failure = new Error('Claude Code process exited with code 2');
    const fake = scripted({ child, fireCanary: 'before', messages: [INIT], beforeThrow: exit, throwAtEnd: failure });
    await expect(createSession(build(fake).deps, { skillsDir: null }).run('p')).rejects.toBe(failure);
    expect(failure.message).toBe('Claude Code process exited with code 2. stderr: the CLI said why');
  });

  it('a stream that fails while its child is alive, or after it exited zero, keeps its message as it was', async () => {
    const quiet = exiting("process.stderr.write('noise', () => process.exit(0))");
    const first = new Error('SDK: something else');
    const a = scripted({ child: quiet.child, fireCanary: 'before', messages: [INIT], beforeThrow: quiet.exit, throwAtEnd: first });
    await expect(createSession(build(a).deps, { skillsDir: null }).run('p')).rejects.toBe(first);
    expect(first.message).toBe('SDK: something else');
    const { child } = idleChild();
    const second = new Error('SDK: stream broke');
    const b = scripted({ child, fireCanary: 'before', messages: [INIT], throwAtEnd: second });
    await expect(createSession(build(b).deps, { skillsDir: null }).run('p')).rejects.toBe(second);
    expect(second.message).toBe('SDK: stream broke');
  });

  it("a missed canary's error carries no stderr: the harness killed that child", async () => {
    const { child } = exiting("process.stderr.write('chatter'); setInterval(() => {}, 1000)");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const fake = scripted({ child, messages: [INIT, RESULT], throwOnClose: new Error('SDK: process exited') });
    const run = createSession(build(fake).deps, { skillsDir: null }).run('p');
    await expect(run).rejects.toThrow(HookCanaryMissed);
    await expect(run).rejects.not.toThrow(/stderr|chatter/);
  });
});
