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
      value: { command: 'eval', taskDir: './eval/golden', challenge: false },
    });
  });

  it('accepts a positional task directory', () => {
    const result = parseEvalArgs(['./my-tasks']);
    expect(result).toEqual({
      ok: true,
      value: { command: 'eval', taskDir: './my-tasks', challenge: false },
    });
  });

  it('parses --challenge with default taskDir', () => {
    const result = parseEvalArgs(['--challenge']);
    expect(result).toEqual({
      ok: true,
      value: { command: 'eval', taskDir: './eval/golden', challenge: true },
    });
  });

  it('parses --challenge before the positional taskDir', () => {
    const result = parseEvalArgs(['--challenge', './my-tasks']);
    expect(result).toEqual({
      ok: true,
      value: { command: 'eval', taskDir: './my-tasks', challenge: true },
    });
  });

  it('parses --challenge after the positional taskDir', () => {
    const result = parseEvalArgs(['./my-tasks', '--challenge']);
    expect(result).toEqual({
      ok: true,
      value: { command: 'eval', taskDir: './my-tasks', challenge: true },
    });
  });

  it('rejects unknown flags (no --max-tasks in v1)', () => {
    const result = parseEvalArgs(['--max-tasks', '5']);
    expect(result.ok).toBe(false);
  });

  it('rejects extra positional arguments', () => {
    const result = parseEvalArgs(['a', 'b']);
    expect(result.ok).toBe(false);
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
