import { describe, expect, it } from 'vitest';

import type { QueryFn, QueryOptions, SdkHookCallback, SdkMessage } from '../session/index.js';
import { buildAdversary, parseEvalArgs } from './eval-command.js';

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
