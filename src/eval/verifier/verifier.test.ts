import { describe, expect, it, vi } from 'vitest';
import { createVerifier } from './verifier.js';
import type { AdversaryResult } from './types.js';

const input = { taskId: 'di-01', taskPrompt: 'p', redactedResultText: 'out' };
const ok = (text: string, costUsd: number | null = 0.01): AdversaryResult => ({ text, costUsd });

describe('createVerifier', () => {
  it('maps agree → agreed, cost passed through', async () => {
    const v = createVerifier({ adversary: async () => ok('{"verdict":"agree"}'), adversaryModelId: 'm' });
    await expect(v.challenge(input)).resolves.toEqual({
      finding: { taskId: 'di-01', status: 'agreed', category: null, errorKind: null },
      costUsd: 0.01,
    });
  });

  it('maps challenge → challenged with category', async () => {
    const v = createVerifier({
      adversary: async () => ok('{"verdict":"challenge","category":"incomplete"}'),
      adversaryModelId: 'm',
    });
    const { finding } = await v.challenge(input);
    expect(finding).toEqual({ taskId: 'di-01', status: 'challenged', category: 'incomplete', errorKind: null });
  });

  it('adversary rejection → verifier-error/call-failed, cost null', async () => {
    const v = createVerifier({ adversary: async () => { throw new Error('boom'); }, adversaryModelId: 'm' });
    await expect(v.challenge(input)).resolves.toEqual({
      finding: { taskId: 'di-01', status: 'verifier-error', category: null, errorKind: 'call-failed' },
      costUsd: null,
    });
  });

  it('unparseable / unknown-enum responses keep the call cost (it was billed)', async () => {
    const v = createVerifier({ adversary: async () => ok('nope', 0.02), adversaryModelId: 'm' });
    await expect(v.challenge(input)).resolves.toEqual({
      finding: { taskId: 'di-01', status: 'verifier-error', category: null, errorKind: 'unparseable' },
      costUsd: 0.02,
    });
  });

  it('exactly one adversary call per challenge (no retries)', async () => {
    const adversary = vi.fn(async () => ok('nope'));
    const v = createVerifier({ adversary, adversaryModelId: 'm' });
    await v.challenge(input);
    expect(adversary).toHaveBeenCalledTimes(1);
  });

  it('exposes adversaryModelId', () => {
    const v = createVerifier({ adversary: async () => ok('{"verdict":"agree"}'), adversaryModelId: 'claude-sonnet-4-6' });
    expect(v.adversaryModelId).toBe('claude-sonnet-4-6');
  });

  it('timer expiry → call-failed; orphan settlement discarded (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      let resolveLate: (r: AdversaryResult) => void = () => {};
      const v = createVerifier({
        adversary: () => new Promise((res) => { resolveLate = res; }),
        adversaryModelId: 'm',
        timeoutMs: 60_000,
      });
      const pending = v.challenge(input);
      await vi.advanceTimersByTimeAsync(60_000);
      const out = await pending;
      expect(out.finding.errorKind).toBe('call-failed');
      resolveLate(ok('{"verdict":"agree"}')); // must be inert — no unhandled rejection, no state change
      expect(out.finding.status).toBe('verifier-error');
    } finally {
      vi.useRealTimers();
    }
  });
});
