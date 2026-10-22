import { describe, expect, it } from 'vitest';

import { createHookRuntime } from '../hooks/index.js';
import { createMemoryStore, openMemoryDatabase } from '../memory/index.js';
import { route } from '../router/index.js';
import type { SettingSource } from '../security/index.js';
import { createSession } from './session.js';
import type { QueryFn, QueryOptions, SdkMessage, SessionDeps } from './types.js';

// Issue #140, ADR-0040 D1/D3. The INIT/RESULT messages, the capturing fake
// query and makeDeps are trimmed copies of the helpers in session.test.ts
// (the fake keeps only what this file needs: it records `args` and replays).

const INIT: SdkMessage = { type: 'system', subtype: 'init', session_id: 'sdk-123' };
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

function fakeQuery(messages: SdkMessage[]): FakeQuery {
  const captured: { prompt: string; options?: QueryOptions }[] = [];
  const query: QueryFn = (args) => {
    captured.push(args);
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
  return { query, captured };
}

function makeDeps(fake: FakeQuery): SessionDeps {
  return {
    query: fake.query,
    hooks: createHookRuntime(),
    memory: createMemoryStore(openMemoryDatabase({ path: ':memory:' })),
    loadSkills: () => ({ skills: [], errors: [], root: '/skills' }),
    route,
  };
}

describe('createSession isolates Claude Code settings by default (#140, ADR-0040 D1; spec 6a.1)', () => {
  it('passes settingSources [] and strictMcpConfig true when the config names no sources', async () => {
    const fake = fakeQuery([INIT, RESULT]);
    await createSession(makeDeps(fake), { skillsDir: null }).run('p');
    const options = fake.captured[0]?.options;
    expect(options !== undefined && Object.hasOwn(options, 'settingSources')).toBe(true);
    expect(options?.settingSources).toEqual([]);
    expect(options?.strictMcpConfig).toBe(true);
  });

  it('passes the configured list as a FRESH array and derives strictMcpConfig false (D-3)', async () => {
    const fake = fakeQuery([INIT, RESULT]);
    const sources: SettingSource[] = ['user'];
    await createSession(makeDeps(fake), { skillsDir: null, settingSources: sources }).run('p');
    const options = fake.captured[0]?.options;
    expect(options?.settingSources).toEqual(['user']);
    expect(options?.settingSources).not.toBe(sources);
    expect(options?.strictMcpConfig).toBe(false);
  });

  it('an explicit empty list is the default: [] and strictMcpConfig true', async () => {
    const fake = fakeQuery([INIT, RESULT]);
    await createSession(makeDeps(fake), { skillsDir: null, settingSources: [] }).run('p');
    expect(fake.captured[0]?.options).toMatchObject({ settingSources: [], strictMcpConfig: true });
  });

  it.each([['a string', 'user'], ['null', null], ['an object', { 0: 'user' }]])(
    'refuses %s as the list at runtime (defence in depth) and never calls the SDK',
    async (_name, bad) => {
      const fake = fakeQuery([INIT, RESULT]);
      const attempt = async () =>
        createSession(makeDeps(fake), { skillsDir: null, settingSources: bad as unknown as SettingSource[] }).run('p');
      await expect(attempt()).rejects.toThrow(TypeError);
      expect(fake.captured).toHaveLength(0);
    },
  );
});
