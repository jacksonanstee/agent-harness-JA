import { describe, expect, it } from 'vitest';

import { createMemoryStore } from '../memory/index.js';
import { createSession } from '../session/index.js';
import type { QueryFn, QueryOptions, SdkHookCallback, SdkMessage, SessionDeps } from '../session/index.js';
import { mergeLayers, parsePermissionSettings } from '../security/index.js';
import type { SettingSource } from '../security/index.js';
import { createTelemetryStore, openTelemetryDatabase } from '../telemetry/index.js';
import { USAGE } from './shared.js';
import { buildAdversary, makeEvalSessionFactory, parseEvalArgs } from './eval-command.js';

const RESULT: SdkMessage = {
  type: 'result',
  subtype: 'success',
  result: 'adversary verdict text',
  session_id: 'sdk-adv-1',
  num_turns: 1,
  total_cost_usd: 0.002,
  usage: { input_tokens: 10, output_tokens: 5 },
};

interface FakeQuery {
  query: QueryFn;
  captured: { prompt: string; options?: QueryOptions }[];
}

/** Fake SDK: replays the scripted messages, capturing the options each call
 *  was invoked with (mirrors session.test.ts's fakeQuery pattern). */
function fakeQuery(messages: SdkMessage[]): FakeQuery {
  const captured: { prompt: string; options?: QueryOptions }[] = [];
  const query: QueryFn = (args) => {
    captured.push(args);
    return (async function* () {
      for (const message of messages) yield message;
    })();
  };
  return { query, captured };
}

describe('parseEvalArgs', () => {
  it('defaults taskDir to ./eval/golden and challenge to false', () => {
    const result = parseEvalArgs([]);
    expect(result).toEqual({
      ok: true,
      value: { command: 'eval', taskDir: './eval/golden', challenge: false, maxTasks: 100 },
    });
  });

  it('accepts a positional task directory', () => {
    const result = parseEvalArgs(['./my-tasks']);
    expect(result).toEqual({
      ok: true,
      value: { command: 'eval', taskDir: './my-tasks', challenge: false, maxTasks: 100 },
    });
  });

  it('parses --challenge with default taskDir', () => {
    const result = parseEvalArgs(['--challenge']);
    expect(result).toEqual({
      ok: true,
      value: { command: 'eval', taskDir: './eval/golden', challenge: true, maxTasks: 100 },
    });
  });

  it('parses --challenge before the positional taskDir', () => {
    const result = parseEvalArgs(['--challenge', './my-tasks']);
    expect(result).toEqual({
      ok: true,
      value: { command: 'eval', taskDir: './my-tasks', challenge: true, maxTasks: 100 },
    });
  });

  it('parses --challenge after the positional taskDir', () => {
    const result = parseEvalArgs(['./my-tasks', '--challenge']);
    expect(result).toEqual({
      ok: true,
      value: { command: 'eval', taskDir: './my-tasks', challenge: true, maxTasks: 100 },
    });
  });

  it('rejects unknown flags', () => {
    const result = parseEvalArgs(['--nope', '5']);
    expect(result.ok).toBe(false);
  });

  it('rejects extra positional arguments', () => {
    const result = parseEvalArgs(['a', 'b']);
    expect(result.ok).toBe(false);
  });

  // --max-tasks (issue #95). The default is pinned by LITERAL above (100), not
  // by importing DEFAULT_MAX_TASKS, so a silent change of the default goes red
  // here and has to be made visible in the diff (the #88 idiom).
  it('parses --max-tasks before and after the positional taskDir, and beside --challenge', () => {
    expect(parseEvalArgs(['--max-tasks', '5', './my-tasks'])).toEqual({
      ok: true,
      value: { command: 'eval', taskDir: './my-tasks', challenge: false, maxTasks: 5 },
    });
    expect(parseEvalArgs(['./my-tasks', '--challenge', '--max-tasks', '250'])).toEqual({
      ok: true,
      value: { command: 'eval', taskDir: './my-tasks', challenge: true, maxTasks: 250 },
    });
  });

  it('rejects --max-tasks without a value', () => {
    const result = parseEvalArgs(['--max-tasks']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Missing value for --max-tasks/);
  });

  it('rejects a non-positive, non-integer or unsafe --max-tasks', () => {
    // Above 2^53 parseInt silently rewrites the digits (code lens on 472b1eb);
    // a limit the operator never typed is worse than a rejection.
    for (const value of ['0', '-1', 'abc', '4.5', '5abc', '99999999999999999999']) {
      const result = parseEvalArgs(['--max-tasks', value]);
      expect(result.ok, value).toBe(false);
      if (result.ok) continue;
      expect(result.error, value).toMatch(/--max-tasks must be a positive integer/);
    }
  });

  it('pins the --max-tasks rejection message byte for byte and its floor of 1 (#128)', () => {
    for (const bad of ['0', 'abc', '99999999999999999999']) {
      expect(parseEvalArgs(['--max-tasks', bad]), bad).toEqual({
        ok: false,
        error: `--max-tasks must be a positive integer. ${USAGE}`,
      });
    }
    const one = parseEvalArgs(['--max-tasks', '1']);
    expect(one.ok).toBe(true);
    if (one.ok) expect(one.value.maxTasks).toBe(1);
    const top = parseEvalArgs(['--max-tasks', '9007199254740991']);
    expect(top.ok).toBe(true);
    if (top.ok) expect(top.value.maxTasks).toBe(9007199254740991);
  });

  it('takes the last --max-tasks when the flag repeats (last-wins, as every run flag does)', () => {
    const result = parseEvalArgs(['--max-tasks', '5', '--max-tasks', '7']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.maxTasks).toBe(7);
  });
});

describe('buildAdversary', () => {
  it('extracts { text, costUsd } from the result message', async () => {
    const fake = fakeQuery([RESULT]);
    const adversary = buildAdversary(fake.query, 'claude-adversary-model');

    const outcome = await adversary('challenge this transcript');

    expect(outcome).toEqual({ text: 'adversary verdict text', costUsd: 0.002 });
  });

  it('returns empty text and null cost when no result message is yielded', async () => {
    const fake = fakeQuery([]);
    const adversary = buildAdversary(fake.query, 'claude-adversary-model');

    const outcome = await adversary('challenge this transcript');

    expect(outcome).toEqual({ text: '', costUsd: null });
  });

  it('treats a non-finite total_cost_usd (Infinity) as null, not a real price (differential-review nit N2)', async () => {
    // A hostile/misbehaving SDK result message must not report an infinite
    // cost as if it were priced — it falls into the existing null/unpriced
    // path instead.
    const fake = fakeQuery([{ ...RESULT, total_cost_usd: Infinity }]);
    const adversary = buildAdversary(fake.query, 'claude-adversary-model');

    const outcome = await adversary('challenge this transcript');

    expect(outcome).toEqual({ text: 'adversary verdict text', costUsd: null });
  });

  it('calls query with maxTurns: 1 and the routed model', async () => {
    const fake = fakeQuery([RESULT]);
    const adversary = buildAdversary(fake.query, 'claude-adversary-model');

    await adversary('challenge this transcript');

    expect(fake.captured).toHaveLength(1);
    expect(fake.captured[0]?.prompt).toBe('challenge this transcript');
    expect(fake.captured[0]?.options?.model).toBe('claude-adversary-model');
    expect(fake.captured[0]?.options?.maxTurns).toBe(1);
  });

  it("passes the judge's five isolation keys beside the deny-all hook (#140, ADR-0040 D4)", async () => {
    const fake = fakeQuery([RESULT]);
    await buildAdversary(fake.query, 'claude-adversary-model')('p');
    expect(fake.captured[0]?.options).toMatchObject({
      settingSources: [],
      strictMcpConfig: true,
      tools: [],
      skills: [],
      persistSession: false,
    });
  });

  it('registers a PreToolUse hook that denies any tool call the adversary attempts', async () => {
    const fake = fakeQuery([RESULT]);
    const adversary = buildAdversary(fake.query, 'claude-adversary-model');

    await adversary('challenge this transcript');

    const preToolUse = fake.captured[0]?.options?.hooks?.PreToolUse;
    expect(preToolUse).toBeDefined();
    const hooks = (preToolUse ?? []).flatMap((matcher) => matcher.hooks) as SdkHookCallback[];
    expect(hooks.length).toBeGreaterThan(0);

    const signal = new AbortController().signal;
    for (const hook of hooks) {
      const out = await hook(
        { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } },
        'toolu_1',
        { signal },
      );
      expect('hookSpecificOutput' in out && out.hookSpecificOutput?.permissionDecision).toBe(
        'deny',
      );
    }
  });
});

describe('R5: eval stays heuristic (pin 23)', () => {
  it('a configured user judge never reaches an eval session: no judge key, no judge query, no matcher timeout', async () => {
    const seen: SessionDeps[] = [];
    const fake = fakeQuery([RESULT]);
    const query: QueryFn = fake.query;
    const db = openTelemetryDatabase({ path: ':memory:' });
    try {
      const factory = makeEvalSessionFactory({
        query,
        security: { permissions: { rules: [] }, grantPolicy: { ungrantableTools: new Set(['Bash']) }, sandbox: {}, judge: { mode: 'always', maxCallsPerRun: 5, withhold: 'off' }, sdk: { settingSources: [] }, warnings: [] },
        telemetry: createTelemetryStore(db),
        memory: createMemoryStore(db),
        create: (deps, config) => {
          seen.push(deps);
          return createSession(deps, config);
        },
      });
      await factory({ skillsDir: null, maxTurns: 1 }).run('task');
      expect(seen).toHaveLength(1);
      expect('judge' in (seen[0] ?? {})).toBe(false);
      // No `judgeCalls` assertion: `fakeQuery([RESULT])` fires no tool hook, so it could not fail (plan review P-13).
      expect(fake.captured[0]?.options?.hooks?.PostToolUse?.[0]).not.toHaveProperty('timeout');
    } finally {
      db.close();
    }
  });
});

// Issue #140 I-1: the behavioural guard for the eval path's security-hook
// registration (test/policy-corpus.test.ts keeps only a text pin on the call).
describe('the eval session registers the security hooks (#140, I-1)', () => {
  it('a user-layer Bash deny rule denies the PreToolUse callback the SDK drives', async () => {
    const outputs: unknown[] = [];
    const query: QueryFn = (args) =>
      (async function* () {
        for (const matcher of args.options?.hooks?.PreToolUse ?? []) {
          for (const cb of matcher.hooks as unknown as SdkHookCallback[]) {
            outputs.push(
              await cb(
                { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, tool_use_id: 'toolu_1' },
                'toolu_1',
                { signal: new AbortController().signal },
              ),
            );
          }
        }
        yield RESULT;
      })();
    const db = openTelemetryDatabase({ path: ':memory:' });
    try {
      const factory = makeEvalSessionFactory({
        query,
        security: {
          permissions: mergeLayers(
            parsePermissionSettings({ permissions: { rules: [{ tool: 'Bash', decision: 'deny' }] } }),
            parsePermissionSettings({}),
          ),
          grantPolicy: { ungrantableTools: new Set(['Bash']) },
          sandbox: {},
          judge: null,
          sdk: { settingSources: [] },
          warnings: [],
        },
        telemetry: createTelemetryStore(db),
        memory: createMemoryStore(db),
      });
      await factory({ skillsDir: null, maxTurns: 1 }).run('task');
      expect(outputs).toEqual([
        {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'permission: deny Bash [rule 0, user]',
          },
        },
      ]);
    } finally {
      db.close();
    }
  });
});

// Issue #140, ADR-0040 D2: eval passes the composed list to the primary query.
describe('the eval session carries the composed sdk.settingSources (#140, D2)', () => {
  const run = async (settingSources: SettingSource[]) => {
    const fake = fakeQuery([RESULT]);
    const db = openTelemetryDatabase({ path: ':memory:' });
    try {
      const factory = makeEvalSessionFactory({
        query: fake.query,
        security: {
          permissions: { rules: [] },
          grantPolicy: { ungrantableTools: new Set(['Bash']) },
          sandbox: {},
          judge: null,
          sdk: { settingSources },
          warnings: [],
        },
        telemetry: createTelemetryStore(db),
        memory: createMemoryStore(db),
      });
      await factory({ skillsDir: null, maxTurns: 1 }).run('task');
      return fake.captured[0]?.options;
    } finally {
      db.close();
    }
  };

  it('an opted-in list reaches the query and lifts strictMcpConfig', async () => {
    expect(await run(['project'])).toMatchObject({ settingSources: ['project'], strictMcpConfig: false });
  });

  it('the composed default is isolated', async () => {
    expect(await run([])).toMatchObject({ settingSources: [], strictMcpConfig: true });
  });
});
