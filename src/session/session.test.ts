import { describe, expect, it } from 'vitest';

import { createHookRuntime, HookDenial } from '../hooks/index.js';
import { createMemoryStore, openMemoryDatabase } from '../memory/index.js';
import { route } from '../router/index.js';
import { createSession } from './session.js';
import type {
  QueryFn,
  QueryOptions,
  SdkHookCallback,
  SdkMessage,
  SessionDeps,
} from './types.js';

const INIT: SdkMessage = { type: 'system', subtype: 'init', session_id: 'sdk-123' };
const ASSISTANT: SdkMessage = {
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'hello from claude' }] },
};
const RESULT: SdkMessage = {
  type: 'result',
  subtype: 'success',
  result: 'hello from claude',
  session_id: 'sdk-123',
  num_turns: 1,
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 5 },
};

interface FakeQuery {
  query: QueryFn;
  captured: { prompt: string; options?: QueryOptions }[];
}

/**
 * Fake SDK: replays the scripted messages, and before yielding, drives any
 * registered PreToolUse/PostToolUse hook callbacks for `toolCalls` so the
 * adapter path is exercised the way the real SDK would.
 */
function fakeQuery(
  messages: SdkMessage[],
  toolCalls: { tool: string; input: unknown; output: unknown }[] = [],
): FakeQuery {
  const captured: { prompt: string; options?: QueryOptions }[] = [];
  const query: QueryFn = (args) => {
    captured.push(args);
    return (async function* () {
      const signal = new AbortController().signal;
      for (const call of toolCalls) {
        const pre = args.options?.hooks?.PreToolUse ?? [];
        let denied = false;
        for (const matcher of pre) {
          for (const cb of matcher.hooks as SdkHookCallback[]) {
            const out = await cb(
              { hook_event_name: 'PreToolUse', tool_name: call.tool, tool_input: call.input },
              'toolu_1',
              { signal },
            );
            if (
              'hookSpecificOutput' in out &&
              out.hookSpecificOutput?.permissionDecision === 'deny'
            ) {
              denied = true;
            }
          }
        }
        if (denied) continue; // tool never runs; PostToolUse must not fire
        const post = args.options?.hooks?.PostToolUse ?? [];
        for (const matcher of post) {
          for (const cb of matcher.hooks as SdkHookCallback[]) {
            await cb(
              {
                hook_event_name: 'PostToolUse',
                tool_name: call.tool,
                tool_input: call.input,
                tool_output: call.output,
              },
              'toolu_1',
              { signal },
            );
          }
        }
      }
      for (const message of messages) {
        yield message;
      }
    })();
  };
  return { query, captured };
}

function makeDeps(fake: FakeQuery, overrides: Partial<SessionDeps> = {}): SessionDeps {
  return {
    query: fake.query,
    hooks: createHookRuntime(),
    memory: createMemoryStore(openMemoryDatabase({ path: ':memory:' })),
    loadSkills: () => ({ skills: [], errors: [] }),
    route,
    ...overrides,
  };
}

describe('createSession', () => {
  it('runs end-to-end: routes, fires hooks in order, writes a memory entry', async () => {
    const fake = fakeQuery([INIT, ASSISTANT, RESULT], [
      { tool: 'Read', input: { file_path: '/tmp/x' }, output: 'contents' },
    ]);
    const fired: string[] = [];
    const hooks = createHookRuntime({
      onEvent: (record) => {
        if (record.kind === 'hook-fired') fired.push(record.event);
      },
    });
    const deps = makeDeps(fake, { hooks });
    const session = createSession(deps, { skillsDir: '/nowhere', now: () => 1000 });

    const result = await session.run('say hello');

    expect(fired).toEqual(['session-start', 'pre-tool', 'post-tool', 'stop']);
    expect(result.resultText).toBe('hello from claude');
    expect(result.sessionId).toBe('sdk-123');
    expect(result.costUsd).toBe(0.01);
    expect(result.numTurns).toBe(1);
    expect(result.denied).toEqual([]);
    expect(result.memoryEntryId).toBe('session-sdk-123');
    const rows = deps.memory.read({ type: 'project' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('session-sdk-123');
    expect(rows[0]?.tags).toContain('session');
  });

  it('passes the routed model to the SDK options', async () => {
    const fake = fakeQuery([INIT, RESULT]);
    const session = createSession(makeDeps(fake), {
      skillsDir: '/nowhere',
      descriptor: { shape: 'lookup', sensitivity: 'low', expected_tokens: 100 },
    });
    const result = await session.run('quick lookup');
    expect(fake.captured[0]?.options?.model).toBe(result.modelChoice.model);
    expect(result.modelChoice.model).toBeTruthy();
  });

  it('bridges a harness pre-tool denial to an SDK deny output and records it', async () => {
    const fake = fakeQuery([INIT, RESULT], [
      { tool: 'Bash', input: { command: 'rm -rf /' }, output: 'never' },
    ]);
    const hooks = createHookRuntime();
    hooks.register('pre-tool', (payload) => {
      if (payload.tool === 'Bash') throw new HookDenial('bash is blocked');
    });
    const postFired: string[] = [];
    hooks.register('post-tool', (payload) => {
      postFired.push(payload.tool);
    });
    const session = createSession(makeDeps(fake, { hooks }), { skillsDir: '/nowhere' });

    const result = await session.run('do something dangerous');

    expect(result.denied).toEqual([{ tool: 'Bash', reason: expect.stringContaining('blocked') }]);
    expect(postFired).toEqual([]); // denied tool never ran, post-tool never fired
  });

  it('injects loaded skill names into the system prompt and surfaces load errors as warnings', async () => {
    const fake = fakeQuery([INIT, RESULT]);
    const warnings: string[] = [];
    const session = createSession(
      makeDeps(fake, {
        loadSkills: () => ({
          skills: [
            {
              name: 'greeting',
              description: 'How to greet',
              version: '1.0.0',
              body: '...',
              path: '/skills/greeting.md',
            },
          ],
          errors: [{ file: '/skills/bad.md', kind: 'parse', message: 'broken frontmatter' }],
        }),
      }),
      { skillsDir: '/skills', onWarning: (w) => warnings.push(w) },
    );

    const result = await session.run('hi');

    expect(fake.captured[0]?.options?.systemPrompt).toContain('greeting');
    expect(fake.captured[0]?.options?.systemPrompt).toContain('How to greet');
    expect(warnings.some((w) => w.includes('bad.md'))).toBe(true);
    expect(result.skillErrors).toHaveLength(1);
  });

  it('fires stop and reports null result fields when the stream errors mid-run', async () => {
    const captured: { prompt: string }[] = [];
    const query: QueryFn = (args) => {
      captured.push(args);
      return (async function* () {
        yield INIT;
        throw new Error('stream died');
      })();
    };
    const fired: string[] = [];
    const hooks = createHookRuntime({
      onEvent: (record) => {
        if (record.kind === 'hook-fired') fired.push(record.event);
      },
    });
    const session = createSession(
      makeDeps({ query, captured: [] }, { hooks }),
      { skillsDir: '/nowhere' },
    );

    await expect(session.run('boom')).rejects.toThrow('stream died');
    expect(fired).toEqual(['session-start', 'stop']);
  });

  it('falls back to the harness-generated session id when the SDK never sends init', async () => {
    const fake = fakeQuery([
      {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        session_id: '',
        num_turns: 1,
        total_cost_usd: 0,
      },
    ]);
    const session = createSession(makeDeps(fake), {
      skillsDir: '/nowhere',
      generateId: () => 'local-abc',
    });
    const result = await session.run('hi');
    expect(result.sessionId).toBe('local-abc');
    expect(result.memoryEntryId).toBe('session-local-abc');
  });

  it('warns instead of throwing when the memory write fails', async () => {
    const fake = fakeQuery([INIT, RESULT]);
    const warnings: string[] = [];
    const memory = createMemoryStore(openMemoryDatabase({ path: ':memory:' }));
    const failingMemory = {
      ...memory,
      write: () => ({ ok: false as const, error: { kind: 'db' as const, message: 'disk full' } }),
    };
    const session = createSession(makeDeps(fake, { memory: failingMemory }), {
      skillsDir: '/nowhere',
      onWarning: (w) => warnings.push(w),
    });
    const result = await session.run('hi');
    expect(result.memoryEntryId).toBeNull();
    expect(warnings.some((w) => w.includes('disk full'))).toBe(true);
  });

  it('surfaces session-start, post-tool, and stop hook errors as warnings', async () => {
    const fake = fakeQuery([INIT, ASSISTANT, RESULT], [
      { tool: 'Read', input: {}, output: 'x' },
    ]);
    const warnings: string[] = [];
    const hooks = createHookRuntime();
    hooks.register('session-start', () => {
      throw new Error('start observer broke');
    });
    hooks.register('post-tool', () => {
      throw new Error('post observer broke');
    });
    hooks.register('stop', () => {
      throw new Error('stop observer broke');
    });
    const session = createSession(makeDeps(fake, { hooks }), {
      skillsDir: '/nowhere',
      onWarning: (w) => warnings.push(w),
    });

    const result = await session.run('hi');

    expect(result.resultText).toBe('hello from claude'); // observers never abort the run
    expect(warnings.some((w) => w.includes('session-start hook error'))).toBe(true);
    expect(warnings.some((w) => w.includes('post-tool hook error'))).toBe(true);
    expect(warnings.some((w) => w.includes('stop hook error'))).toBe(true);
  });

  it('persists a failure summary and rethrows when the stream errors mid-run', async () => {
    const query: QueryFn = () =>
      (async function* () {
        yield INIT;
        throw new Error('stream died');
      })();
    const memory = createMemoryStore(openMemoryDatabase({ path: ':memory:' }));
    const session = createSession(
      makeDeps({ query, captured: [] }, { memory }),
      { skillsDir: '/nowhere' },
    );

    await expect(session.run('boom')).rejects.toThrow('stream died');

    const rows = memory.read({ type: 'project' });
    expect(rows).toHaveLength(1);
    const content = JSON.parse(rows[0]?.content ?? '{}') as { failed: boolean };
    expect(content.failed).toBe(true);
  });

  it('threads the result subtype through and keeps telemetry metrics out of memory', async () => {
    const fake = fakeQuery([
      INIT,
      {
        type: 'result',
        subtype: 'error_max_turns',
        result: 'partial answer',
        session_id: 'sdk-123',
        num_turns: 10,
        total_cost_usd: 0.5,
      },
    ]);
    const memory = createMemoryStore(openMemoryDatabase({ path: ':memory:' }));
    const session = createSession(makeDeps(fake, { memory }), { skillsDir: '/nowhere' });

    const result = await session.run('hi');

    expect(result.resultSubtype).toBe('error_max_turns');
    expect(result.costUsd).toBe(0.5); // still returned to the caller...
    const content = JSON.parse(memory.read({})[0]?.content ?? '{}') as Record<string, unknown>;
    expect(content.resultSubtype).toBe('error_max_turns');
    expect(content).not.toHaveProperty('costUsd'); // ...but not persisted (telemetry is Week 2)
    expect(content).not.toHaveProperty('usage');
  });

  it('sanitizes control characters and truncates persisted prompt/result text', async () => {
    const longPrompt = `evil\u001b[2Jtext ${'a'.repeat(300)}`;
    const fake = fakeQuery([INIT, RESULT], [
      { tool: 'Bash\u001b[31m', input: {}, output: 'x' },
    ]);
    const hooks = createHookRuntime();
    hooks.register('pre-tool', () => {
      throw new HookDenial('nope');
    });
    const memory = createMemoryStore(openMemoryDatabase({ path: ':memory:' }));
    const session = createSession(makeDeps(fake, { hooks, memory }), { skillsDir: '/nowhere' });

    const result = await session.run(longPrompt);

    expect(result.denied[0]?.tool).not.toContain('\u001b');
    const row = memory.read({})[0];
    expect(row?.content).not.toContain('\u001b');
    expect(row?.staleAfter).not.toBeNull();
    const content = JSON.parse(row?.content ?? '{}') as { prompt: string };
    expect(content.prompt.length).toBeLessThanOrEqual(201); // 200 + ellipsis
  });

  it('streams assistant text through onText', async () => {
    const fake = fakeQuery([INIT, ASSISTANT, RESULT]);
    const chunks: string[] = [];
    const session = createSession(makeDeps(fake), {
      skillsDir: '/nowhere',
      onText: (t) => chunks.push(t),
    });
    await session.run('hi');
    expect(chunks).toEqual(['hello from claude']);
  });
});
