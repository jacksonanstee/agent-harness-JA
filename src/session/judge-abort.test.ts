import { getEventListeners } from 'node:events';

import { describe, expect, it } from 'vitest';

import { DEFAULT_ROUTING_TABLE } from '../router/index.js';
import { buildJudge, JUDGE_MODEL } from './judge.js';
import type { QueryFn, QueryOptions, SdkMessage } from './types.js';

// Issue #96 PR-B1, spec D4 (K-2, Gm2#5) and D1 (A-9). Fake query only (D8a).

const RESULT_PASS = {
  type: 'result',
  subtype: 'success',
  result: '{"verdict":"pass"}',
  session_id: 'sdk-judge',
  total_cost_usd: 0.001,
} as SdkMessage;

function capturing(messages: SdkMessage[]): { query: QueryFn; options: QueryOptions[] } {
  const options: QueryOptions[] = [];
  const query: QueryFn = (args) => {
    if (args.options !== undefined) options.push(args.options);
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
  return { query, options };
}

/** A transport that honours abortController the way the SDK does: the iteration rejects on abort. */
function abortable(): { query: QueryFn; started: Promise<void> } {
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const query: QueryFn = (args) =>
    (async function* () {
      markStarted();
      const controller = args.options?.abortController;
      await new Promise<void>((_resolve, reject) => {
        controller?.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      yield RESULT_PASS;
    })();
  return { query, started };
}

describe('buildJudge carries its own AbortController (spec D4, K-2, pin 10)', () => {
  it('passes an un-aborted AbortController when no signal is given', async () => {
    const fake = capturing([RESULT_PASS]);
    await expect(buildJudge(fake.query, JUDGE_MODEL)('text')).resolves.toMatchObject({ ok: true, verdict: 'pass' });
    expect(fake.options[0]?.abortController).toBeInstanceOf(AbortController);
    expect(fake.options[0]?.abortController?.signal.aborted).toBe(false);
  });

  it('follows an incoming signal: aborting it rejects the iteration, which resolves call-failed', async () => {
    const fake = abortable();
    const incoming = new AbortController();
    const pending = buildJudge(fake.query, JUDGE_MODEL)('text', incoming.signal);
    await fake.started;
    incoming.abort();
    await expect(pending).resolves.toEqual({ ok: false, errorKind: 'call-failed', costUsd: null });
  });

  it('an incoming signal already aborted aborts the controller before the query runs', async () => {
    const fake = capturing([RESULT_PASS]);
    await buildJudge(fake.query, JUDGE_MODEL)('text', AbortSignal.abort());
    expect(fake.options[0]?.abortController?.signal.aborted).toBe(true);
  });

  it('removes its listener from the incoming signal on the success and the failure path', async () => {
    const incoming = new AbortController();
    // An iterator object, not a generator with no `yield` (eslint require-yield, plan review P-8).
    const throwing: QueryFn = () => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('transport')) }),
    });
    await buildJudge(capturing([RESULT_PASS]).query, JUDGE_MODEL)('a', incoming.signal);
    await buildJudge(throwing, JUDGE_MODEL)('b', incoming.signal);
    expect(getEventListeners(incoming.signal, 'abort')).toHaveLength(0);
  });

  it('the judge query carries only the deny-all PreToolUse hook and no tools (recursion, Gm2#5)', async () => {
    const fake = capturing([RESULT_PASS]);
    await buildJudge(fake.query, JUDGE_MODEL)('text', new AbortController().signal);
    expect(Object.keys(fake.options[0]?.hooks ?? {})).toEqual(['PreToolUse']);
    expect(fake.options[0]?.tools).toEqual([]);
  });
});

describe('JUDGE_MODEL lives beside buildJudge (spec D1, A-9; the S-18 pin moved from redteam-command.test.ts)', () => {
  it('is the sonnet literal (issue #148) and a model id present in the router table', () => {
    expect(JUDGE_MODEL).toBe('claude-sonnet-5');
    expect(DEFAULT_ROUTING_TABLE.map((rule) => rule.model)).toContain(JUDGE_MODEL);
  });
});
