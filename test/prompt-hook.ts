import { PassThrough } from 'node:stream';

import { createSession } from '../src/session/session.js';
import type { QueryFn, SdkSpawnedProcess, Session, SessionConfig, SessionDeps, SettingsWatch, SpawnChildFn } from '../src/session/types.js';

// Issue #251. The session stops a run whose query function started no process through the
// harness's spawn function by the time the turn starts, and one whose CLI began the turn without
// calling the session's prompt hook. The real SDK starts the CLI through that function, and the
// real CLI calls the hook before it sends anything (observed), so a fake query that stands in for
// a healthy SDK and CLI must do both. These helpers do that for a whole test file, so each fake
// does not have to. Tests of the canary itself use the bare `createSession` and a fake that
// decides for itself.

/** A process that is not one: it starts nothing, and a kill only records the signal. */
export function fakeChild(): SdkSpawnedProcess & { readonly signals: NodeJS.Signals[] } {
  const signals: NodeJS.Signals[] = [];
  return {
    signals,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: (signal) => {
      signals.push(signal);
      return true;
    },
    on: () => undefined,
    once: () => undefined,
    off: () => undefined,
  };
}

/** The `spawnChild` seam for a test whose fake query must not start a real process. */
export const fakeSpawnChild: SpawnChildFn = () => fakeChild();

/** The fake `query`, made to start its "process" through the session's spawn function and call the session's prompt hook first, as the SDK and the CLI do. */
export function promptHookFirst(query: QueryFn): QueryFn {
  return (args) => {
    // The fake is called first and synchronously, so it captures its arguments and throws exactly as before.
    const inner = query(args);
    // A tool-less child (the judge, the eval adversary) registers no prompt hook and is left alone.
    if (Array.isArray(args.options?.tools) && args.options.tools.length === 0) return inner;
    const matchers = args.options?.hooks?.UserPromptSubmit;
    if (matchers === undefined || matchers.length === 0) {
      throw new Error('test/prompt-hook.ts: the primary query registered no UserPromptSubmit hook, so there is no canary to call (#251)');
    }
    const spawnChild = args.options?.spawnClaudeCodeProcess;
    if (spawnChild === undefined) {
      throw new Error('test/prompt-hook.ts: the primary query passed no spawnClaudeCodeProcess, so the session holds no process (#251)');
    }
    // The session under test must have been given `fakeSpawnChild`: the default starts this command for real.
    const child = spawnChild({ command: 'test/prompt-hook.ts: not a command', args: [], env: {}, signal: new AbortController().signal });
    if (!Object.hasOwn(child, 'signals')) {
      child.on('error', () => undefined);
      throw new Error('test/prompt-hook.ts: the session was not given fakeSpawnChild (deps.spawnChild, the spawnChild seam of main, or the spawnChild of the eval session factory), so a real process was started (#251)');
    }
    return (async function* () {
      const input = { hook_event_name: 'UserPromptSubmit' as const, prompt: args.prompt, session_id: 'sdk-test' };
      for (const matcher of matchers) for (const callback of matcher.hooks) await callback(input, undefined, { signal: new AbortController().signal });
      yield* inner;
    })();
  };
}

/**
 * Issue #264. A settings watch that watches nothing: no marker, no file, no change. The session's default reads the
 * real settings files and keeps its marker under the real home directory, which a unit test must neither read nor
 * write, so every test session that is not about the watch is given this one.
 */
export const noSettingsWatch: SettingsWatch = {
  markerPath: 'test/prompt-hook.ts: no marker',
  pending: () => [],
  snapshot: () => ({ changes: () => [], baselineOf: () => 'unknown' }),
  reported: (source, path) => ({ source, path, kind: 'reported', fingerprint: 'test', baseline: 'unknown' }),
  record: () => 'ok',
};

/** `createSession` over a fake query that behaves like a healthy SDK and CLI, with a spawn function that starts nothing and a settings watch that watches nothing. */
export function createLiveSession(deps: SessionDeps, config: SessionConfig): Session {
  return createSession({ spawnChild: fakeSpawnChild, watchSettings: noSettingsWatch, ...deps, query: promptHookFirst(deps.query) }, config);
}
