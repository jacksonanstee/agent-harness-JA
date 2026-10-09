import { getEventListeners } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createJudgedScanner,
  JUDGE_OVERSIZED_RULE_ID,
  JUDGE_REDACTED_RULE_ID,
  JUDGE_REFUSED_RULE_ID,
  JUDGE_RULE_IDS,
  JUDGE_TIMEOUT_MS,
  toInjectionJudge,
} from './judge.js';
import type { JudgeCall, JudgeCallResult } from './judge.js';
import type { InjectionJudge, ScanResult, Verdict } from './types.js';

// Issue #96 PR-B1, spec D4 and R3 (pins 9, 11, 22 at the scanner). The
// scanner's timer stays the only clock (ADR-0036 D1); the signal only lets
// the judge's transport stop a call the timer has already given up on.

const PASS: ScanResult = { verdict: 'pass', rule_ids: [], excerpts: [], suspicious: false };
const floor = { scan: (): ScanResult => PASS };
const never = (): Promise<never> => new Promise<never>(() => undefined);

afterEach(() => {
  vi.useRealTimers();
});

describe('R3: the optional signal is additive (pin 11)', () => {
  it('a two-parameter InjectionJudge and a one-parameter JudgeCall still type-check; the parameter list is now 2 or 3 long', () => {
    // Type-level, so no unused named parameters (eslint no-unused-vars, plan review P-8).
    type TwoParamJudge = (text: string, heuristic: ScanResult) => Promise<Verdict>;
    type OneParamCall = (text: string) => Promise<JudgeCallResult>;
    const twoParam: TwoParamJudge extends InjectionJudge ? true : false = true;
    const oneParam: OneParamCall extends JudgeCall ? true : false = true;
    type Arity = Parameters<InjectionJudge>['length'];
    const arity: Arity extends 2 | 3 ? (2 | 3 extends Arity ? true : false) : false = true;
    expect([twoParam, oneParam, arity]).toEqual([true, true, true]);
  });

  it('toInjectionJudge forwards the signal to the call unchanged, and undefined when none is given', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const judge = toInjectionJudge(async (_text, signal) => {
      seen.push(signal);
      return { ok: true, verdict: 'ask', costUsd: null };
    });
    const controller = new AbortController();
    await expect(judge('t', PASS, controller.signal)).resolves.toBe('ask');
    await judge('t', PASS);
    expect(seen).toEqual([controller.signal, undefined]);
  });
});

describe('callUnderTimer owns one AbortController per call (spec D4, pins 9 and 22)', () => {
  it('the timer firing aborts the signal handed to the judge, and the scan is timed-out on the floor', async () => {
    vi.useFakeTimers();
    let handed: AbortSignal | undefined;
    const scanner = createJudgedScanner({
      mode: 'always',
      scanner: floor,
      judge: (_t, _h, signal) => {
        handed = signal;
        return never();
      },
    });
    const result = scanner.scanWithJudge('text');
    await vi.advanceTimersByTimeAsync(JUDGE_TIMEOUT_MS - 1);
    expect(handed?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ judge: 'timed-out', verdict: 'pass' });
    expect(handed?.aborted).toBe(true);
  });

  it('a judged call never aborts its signal', async () => {
    let handed: AbortSignal | undefined;
    const scanner = createJudgedScanner({
      mode: 'always',
      scanner: floor,
      judge: async (_t, _h, signal) => {
        handed = signal;
        return 'ask';
      },
    });
    await expect(scanner.scanWithJudge('text')).resolves.toMatchObject({ judge: 'judged', verdict: 'ask' });
    expect(handed).toBeInstanceOf(AbortSignal);
    expect(handed?.aborted).toBe(false);
  });

  it('an external signal aborting mid-call aborts the judge signal and settles failed at once', async () => {
    const external = new AbortController();
    let handed: AbortSignal | undefined;
    const scanner = createJudgedScanner({
      mode: 'always',
      scanner: floor,
      judge: (_t, _h, signal) => {
        handed = signal;
        return never();
      },
    });
    const result = scanner.scanWithJudge('text', external.signal);
    await Promise.resolve();
    external.abort();
    await expect(result).resolves.toMatchObject({ judge: 'failed', verdict: 'pass' });
    expect(handed?.aborted).toBe(true);
  });

  it('an external signal already aborted settles failed and never calls the judge', async () => {
    const judge = vi.fn(async () => 'block' as const);
    const scanner = createJudgedScanner({ mode: 'always', scanner: floor, judge });
    await expect(scanner.scanWithJudge('text', AbortSignal.abort())).resolves.toMatchObject({ judge: 'failed', verdict: 'pass' });
    expect(judge).not.toHaveBeenCalled();
  });

  it('N sequential judged and timed-out calls leave the external signal listener count unchanged (Gm1#2, pin 22)', async () => {
    const external = new AbortController();
    const before = getEventListeners(external.signal, 'abort').length;
    const fast = createJudgedScanner({ mode: 'always', scanner: floor, judge: async () => 'pass' });
    for (let i = 0; i < 5; i += 1) await fast.scanWithJudge(`text ${i}`, external.signal);
    const slow = createJudgedScanner({ mode: 'always', scanner: floor, timeoutMs: 1, judge: () => never() });
    for (let i = 0; i < 3; i += 1) await slow.scanWithJudge(`slow ${i}`, external.signal);
    expect(before).toBe(0);
    expect(getEventListeners(external.signal, 'abort').length).toBe(before);
  });
});

describe('the session rule ids sit beside JUDGE_RULE_IDS, not inside it (spec D3 steps 3a and 3b; #152 D3)', () => {
  it('names the three ids and leaves the measured tuple untouched', () => {
    expect(JUDGE_OVERSIZED_RULE_ID).toBe('judge-oversized');
    expect(JUDGE_REDACTED_RULE_ID).toBe('judge-redacted');
    expect(JUDGE_REFUSED_RULE_ID).toBe('judge-refused');
    expect(JUDGE_RULE_IDS).toEqual({ block: 'judge-block', ask: 'judge-ask' });
  });

  it('a branded refusal arriving AFTER the timer fired leaves the result timed-out and fires no unhandledRejection (#152, T1f)', async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      let refuseLate!: (result: JudgeCallResult) => void;
      const pending = new Promise<JudgeCallResult>((resolve) => {
        refuseLate = resolve;
      });
      // The refusal crosses the seam through the shipped adapter, so the late
      // rejection IS the module's branded signal, not a plain Error.
      const judge = toInjectionJudge(() => pending);
      const scanner = createJudgedScanner({ mode: 'always', scanner: floor, judge, timeoutMs: 1_000 });
      const call = scanner.scanWithJudge('text');
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await call;
      expect(result).toEqual({ ...PASS, judge: 'timed-out' });

      vi.useRealTimers();
      refuseLate({ ok: false, errorKind: 'refused', costUsd: 0.002 });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(result).toEqual({ ...PASS, judge: 'timed-out' });
    } finally {
      process.off('unhandledRejection', onUnhandled);
      vi.useRealTimers();
    }
  });
});
