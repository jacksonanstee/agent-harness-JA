import { describe, expect, it } from 'vitest';

import {
  hasJudgeKey,
  JUDGE_BYTES_PER_TOKEN_FLOOR,
  JUDGE_INPUT_USD_PER_MTOK,
  JUDGE_OUTPUT_USD_PER_MTOK,
  JUDGE_PRICE_READ_ON,
  JUDGE_PROMPT_OVERHEAD_TOKENS,
  JUDGE_REPLY_ALLOWANCE_TOKENS,
  JUDGE_WORST_CASE_USD_PER_CALL,
  JudgeSettingsError,
  MAX_JUDGE_CALLS_PER_RUN,
  parseJudgeSettings,
} from './judge-settings.js';
import { MAX_JUDGE_INPUT_BYTES } from './judge.js';

const REQUIRED =
  'judge.maxCallsPerRun is required when judge.mode is "always" (an integer from 1 to 1000; see README Settings)';
const SUSPICIOUS =
  'judge.mode "suspicious" is not available in a session: it measured no added detection (ADR-0036 D7); use "always" or "off"';
const RANGE = 'judge.maxCallsPerRun must be an integer from 1 to 1000';

function messageOf(doc: unknown): string {
  try {
    parseJudgeSettings(doc);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(JudgeSettingsError);
    return (error as Error).message;
  }
  throw new Error('expected parseJudgeSettings to throw');
}

describe('parseJudgeSettings (spec D1, pin 1)', () => {
  it('judge absent, mode off, and off with a valid cap are all "judge off"', () => {
    expect(parseJudgeSettings({})).toBeNull();
    expect(parseJudgeSettings({ permissions: { rules: [] } })).toBeNull();
    expect(parseJudgeSettings({ judge: { mode: 'off' } })).toBeNull();
    expect(parseJudgeSettings({ judge: { mode: 'off', maxCallsPerRun: 50 } })).toBeNull();
  });

  it('always with a cap in range parses to the typed setting, both ends of the range', () => {
    expect(parseJudgeSettings({ judge: { mode: 'always', maxCallsPerRun: 200 } })).toEqual({ mode: 'always', maxCallsPerRun: 200 });
    expect(parseJudgeSettings({ judge: { mode: 'always', maxCallsPerRun: 1 } })).toEqual({ mode: 'always', maxCallsPerRun: 1 });
    expect(parseJudgeSettings({ judge: { mode: 'always', maxCallsPerRun: MAX_JUDGE_CALLS_PER_RUN } })).toEqual({
      mode: 'always',
      maxCallsPerRun: 1000,
    });
  });

  it('always with no cap says the cap is REQUIRED, verbatim (U-7, pin 29)', () => {
    expect(messageOf({ judge: { mode: 'always' } })).toBe(REQUIRED);
  });

  it('suspicious is refused with the D7 reason, verbatim', () => {
    expect(messageOf({ judge: { mode: 'suspicious', maxCallsPerRun: 5 } })).toBe(SUSPICIOUS);
  });

  it.each([
    ['cap 0', { mode: 'always', maxCallsPerRun: 0 }],
    ['cap 1001', { mode: 'always', maxCallsPerRun: 1001 }],
    ['a non-integer cap', { mode: 'always', maxCallsPerRun: 1.5 }],
    ['a string cap', { mode: 'always', maxCallsPerRun: '5' }],
    ['a null cap', { mode: 'always', maxCallsPerRun: null }],
    ['off with a malformed cap (K-7: one grammar whatever the mode)', { mode: 'off', maxCallsPerRun: -3 }],
  ])('%s says the range and never echoes the value', (_name, judge) => {
    const message = messageOf({ judge });
    expect(message).toBe(RANGE);
  });

  it('an unknown key inside judge fails loud, naming the key through boundEcho, in either mode (K-7)', () => {
    expect(messageOf({ judge: { mode: 'always', maxCallsPerRun: 5, modle: 'x' } })).toBe(
      "judge has an unknown key 'modle' (known keys: mode, maxCallsPerRun)",
    );
    expect(messageOf({ judge: { mode: 'off', extra: true } })).toMatch(/^judge has an unknown key 'extra'/);
    const hostile = `k${String.fromCharCode(0x1b)}[31m${'x'.repeat(200)}`;
    const message = messageOf({ judge: { mode: 'off', [hostile]: 1 } });
    expect(message).not.toContain(String.fromCharCode(0x1b));
    expect(message.length).toBeLessThan(200);
  });

  it.each([
    ['a non-object judge', { judge: 'always' }, 'judge must be an object'],
    ['an array judge', { judge: [] }, 'judge must be an object'],
    ['a null judge', { judge: null }, 'judge must be an object'],
    ['an unknown mode', { judge: { mode: 'sometimes', maxCallsPerRun: 5 } }, 'judge.mode must be "always" or "off"'],
    ['a missing mode', { judge: { maxCallsPerRun: 5 } }, 'judge.mode must be "always" or "off"'],
    ['a non-object root', 'nope', 'settings root must be a JSON object'],
  ])('%s fails loud with a value-free message', (_name, doc, expected) => {
    expect(messageOf(doc)).toBe(expected);
  });

  it('never echoes a bad scalar (G-3): a marker in the mode does not reach the message', () => {
    expect(messageOf({ judge: { mode: 'MARKER-31x', maxCallsPerRun: 5 } })).not.toContain('MARKER-31x');
  });

  it('hasJudgeKey sees an own `judge` key whatever its value, and nothing else', () => {
    expect(hasJudgeKey({ judge: { mode: 'always' } })).toBe(true);
    expect(hasJudgeKey({ judge: 'garbage' })).toBe(true);
    expect(hasJudgeKey({})).toBe(false);
    expect(hasJudgeKey(Object.create({ judge: { mode: 'always' } }))).toBe(false);
    expect(hasJudgeKey('nope')).toBe(false);
  });
});

describe('the money ceiling (T-4, N-4; pin 33)', () => {
  it('JUDGE_WORST_CASE_USD_PER_CALL equals its re-derivation from its named inputs', () => {
    const inputUnits = MAX_JUDGE_INPUT_BYTES / JUDGE_BYTES_PER_TOKEN_FLOOR + JUDGE_PROMPT_OVERHEAD_TOKENS;
    const microUsd = inputUnits * JUDGE_INPUT_USD_PER_MTOK + JUDGE_REPLY_ALLOWANCE_TOKENS * JUDGE_OUTPUT_USD_PER_MTOK;
    expect(Number.isInteger(microUsd)).toBe(true);
    expect(JUDGE_WORST_CASE_USD_PER_CALL).toBe(microUsd / 1_000_000);
    expect(JUDGE_PRICE_READ_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
