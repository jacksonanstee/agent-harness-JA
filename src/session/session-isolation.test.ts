import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHookRuntime } from '../hooks/index.js';
import { ATTACHMENTS_SWITCH, AUTO_MEMORY_SWITCH, BACKGROUND_TASKS_SWITCH, BARE_MODE_SWITCH, CRON_SWITCH } from '../internal/child-env.js';
import { isStrippedVendorName } from '../internal/child-env-policy.js';
import { createMemoryStore, openMemoryDatabase } from '../memory/index.js';
import { route } from '../router/index.js';
import type { SettingSource } from '../security/index.js';
import { createLiveSession as createSession } from '../../test/prompt-hook.js';
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
      await expect(attempt()).rejects.toThrow('SessionConfig.settingSources must be an array');
      expect(fake.captured).toHaveLength(0);
    },
  );
});

describe('createSession turns the bundled CLI\'s background tasks off (#250, ADR-0040 D-8 amended 12/11/2026)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes an env that carries the switch as "1" and every inherited variable outside the stripped vendor names', async () => {
    vi.stubEnv('HARNESS_250_SENTINEL', 'kept');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-not-a-key');
    const fake = fakeQuery([INIT, RESULT]);
    await createSession(makeDeps(fake), { skillsDir: null }).run('p');
    const env = fake.captured[0]?.options?.env;
    expect(env?.[BACKGROUND_TASKS_SWITCH]).toBe('1');
    expect(env?.['HARNESS_250_SENTINEL']).toBe('kept');
    expect(env?.['ANTHROPIC_API_KEY']).toBe('test-not-a-key');
    // The SDK's `env` replaces the child environment, so nothing the agent's tools need may be dropped.
    let carried = 0;
    for (const [name, value] of Object.entries(process.env)) {
      if (isStrippedVendorName(name)) continue;
      expect(env?.[name], name).toBe(value);
      carried += 1;
    }
    expect(carried).toBeGreaterThan(2);
  });

  // #251: the CLI's bare mode ran no harness hook. The primary child never inherits it, in any spelling.
  it.each(['1', 'TRUE', 'on', '0', ''])('holds the bare-mode switch at "0" in env and in flag settings over an inherited %j', async (inherited) => {
    vi.stubEnv(BARE_MODE_SWITCH, inherited);
    const fake = fakeQuery([INIT, RESULT]);
    await createSession(makeDeps(fake), { skillsDir: null }).run('p');
    expect(fake.captured[0]?.options?.env?.[BARE_MODE_SWITCH]).toBe('0');
    expect(fake.captured[0]?.options?.settings?.env[BARE_MODE_SWITCH]).toBe('0');
  });

  it('strips the vendor names that are not kept: a parent CLI session\'s, a model override, a made-up switch', async () => {
    const stripped = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_EFFORT', 'ANTHROPIC_MODEL', 'CLAUDE_MADE_UP_TOMORROW'];
    for (const name of stripped) vi.stubEnv(name, 'operator');
    const fake = fakeQuery([INIT, RESULT]);
    await createSession(makeDeps(fake), { skillsDir: null }).run('p');
    const env = fake.captured[0]?.options?.env ?? {};
    for (const name of stripped) expect(name in env, name).toBe(false);
    // Nothing in the vendor namespace reaches the child except the keep list and the forced table.
    for (const name of Object.keys(env)) expect(isStrippedVendorName(name) && !(name in (fake.captured[0]?.options?.settings?.env ?? {})), name).toBe(false);
  });

  it.each(['0', '', 'false'])('the harness value wins over an inherited %j', async (inherited) => {
    vi.stubEnv(BACKGROUND_TASKS_SWITCH, inherited);
    const fake = fakeQuery([INIT, RESULT]);
    await createSession(makeDeps(fake), { skillsDir: null }).run('p');
    expect(fake.captured[0]?.options?.env?.[BACKGROUND_TASKS_SWITCH]).toBe('1');
  });

  it('reads the environment at run time, not at construction, and never hands the SDK process.env itself', async () => {
    const fake = fakeQuery([INIT, RESULT]);
    const session = createSession(makeDeps(fake), { skillsDir: null });
    const before = process.env[BACKGROUND_TASKS_SWITCH];
    vi.stubEnv('HARNESS_250_LATE', 'late');
    await session.run('p');
    const env = fake.captured[0]?.options?.env;
    expect(env?.['HARNESS_250_LATE']).toBe('late');
    expect(env).not.toBe(process.env);
    // The harness's own environment is not mutated.
    expect(process.env[BACKGROUND_TASKS_SWITCH]).toBe(before);
  });

  // The CLI applies a settings file's env block over its environment; flag settings are applied after the
  // user, project and local files, so the same table goes in as flag settings too.
  it.each([[[]], [['user', 'project', 'local']]] as const)('passes the forced table as flag settings as well (sources %j)', async (sources) => {
    const fake = fakeQuery([INIT, RESULT]);
    await createSession(makeDeps(fake), { skillsDir: null, settingSources: [...sources] }).run('p');
    expect(fake.captured[0]?.options?.settings).toEqual({
      env: { [BACKGROUND_TASKS_SWITCH]: '1', [CRON_SWITCH]: '1', [ATTACHMENTS_SWITCH]: '1', [AUTO_MEMORY_SWITCH]: '1', [BARE_MODE_SWITCH]: '0' },
    });
  });

  // #254 (scheduled tasks) and #255 (attachments): the same two layers, the same precedence.
  it.each([CRON_SWITCH, ATTACHMENTS_SWITCH, AUTO_MEMORY_SWITCH])('forces %s to "1" over an inherited empty value, under any sources', async (name) => {
    vi.stubEnv(name, '');
    const fake = fakeQuery([INIT, RESULT]);
    await createSession(makeDeps(fake), { skillsDir: null, settingSources: ['user', 'project', 'local'] }).run('p');
    expect(fake.captured[0]?.options?.env?.[name]).toBe('1');
    expect(fake.captured[0]?.options?.settings?.env[name]).toBe('1');
  });

  it('is set whatever settingSources says (the switch is not part of the isolation opt-in)', async () => {
    const fake = fakeQuery([INIT, RESULT]);
    await createSession(makeDeps(fake), { skillsDir: null, settingSources: ['user', 'project', 'local'] }).run('p');
    expect(fake.captured[0]?.options?.env?.[BACKGROUND_TASKS_SWITCH]).toBe('1');
  });
});
