import { afterEach, describe, expect, it, vi } from 'vitest';

import { JUDGE_ERROR_KINDS, JUDGE_TIMEOUT_MS } from '../security/index.js';
import type { JudgeCall, JudgeCallResult, ScanResult, Verdict } from '../security/index.js';
import { JUDGE_CALL_ERROR_KINDS, JUDGE_CALL_STATES, JUDGE_CALL_VERDICTS } from '../telemetry/index.js';
import type { JudgeCallPayload } from '../telemetry/index.js';
import {
  asFloor,
  createJudgeRun,
  foldJudgeSummary,
  JUDGE_ABORT_GRACE_MS,
  JUDGE_DRAIN_MS,
  JUDGE_EARLY_STOP_AFTER,
  JUDGE_HOOK_TIMEOUT_S,
  JUDGE_MAX_CONCURRENT,
  JUDGE_SESSION_STATES,
  judgeCapWarning,
  judgeEarlyStopWarning,
  judgeFirstFailureWarning,
  judgeRefusedWarning,
  JudgeSlots,
  judgeSlotsHeldWarning,
  normaliseCallResult,
  validateSessionJudge,
} from './judged-scan.js';
import type { InternalSessionJudge, JudgeDecision, JudgedScanOutcome, JudgeSummaryEntry } from './judged-scan.js';
import type { SessionDeps } from './types.js';

// Issue #96 PR-B1 spec D3 (steps 0-7), R4, R6, decisions 12 and 14-17. The
// per-run machinery is driven directly through createJudgeRun with a fake
// JudgeCall (D8a: no SDK). Session-level wiring is session-judge.test.ts.
// Decision 14's queue-timed-out neutrality is pinned by the E-3 run-level leg
// (plan review R3-1: isR6Class has no production caller and was deleted).

const PASS_FLOOR: ScanResult = { verdict: 'pass', rule_ids: [], excerpts: [], suspicious: false };
const ASK_FLOOR: ScanResult = { verdict: 'ask', rule_ids: ['r-ask'], excerpts: [], suspicious: true };
const OK = (verdict: Verdict, costUsd: number | null = 0.001): JudgeCallResult => ({ ok: true, verdict, costUsd });
const CALL_FAILED: JudgeCallResult = { ok: false, errorKind: 'call-failed', costUsd: null };
const UNPARSEABLE: JudgeCallResult = { ok: false, errorKind: 'unparseable', costUsd: 0.0005 };
/** Issue #152: the live refusal's shape (the charged cost of the 07/10/2026 eb-01 refusal). */
const REFUSED: JudgeCallResult = { ok: false, errorKind: 'refused', costUsd: 0.002283 };

interface FakeJudge {
  call: JudgeCall;
  texts: string[];
  live: number;
  peak: number;
}

function fakeJudge(reply: (text: string, signal: AbortSignal | undefined, n: number) => JudgeCallResult | Promise<JudgeCallResult>): FakeJudge {
  const fj: FakeJudge = { call: async () => OK('pass'), texts: [], live: 0, peak: 0 };
  fj.call = async (text, signal) => {
    const n = fj.texts.length;
    fj.texts.push(text);
    fj.live += 1;
    fj.peak = Math.max(fj.peak, fj.live);
    try {
      return await reply(text, signal, n);
    } finally {
      fj.live -= 1;
    }
  };
  return fj;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Options {
  floor?: unknown;
  text?: string;
  phase?: 'post-tool' | 'post-tool-failure';
  redacted?: boolean;
  signal?: AbortSignal;
  id?: string | null;
}

function harness(judge: InternalSessionJudge) {
  const rows: JudgeCallPayload[] = [];
  const warnings: string[] = [];
  const run = createJudgeRun({ judge, now: () => Date.now(), warn: (m) => warnings.push(m), writeRow: (p) => rows.push(p) });
  async function result(o: Options = {}): Promise<JudgeDecision | null> {
    const hook = run.enter(o.signal, o.id === undefined ? 't' : o.id);
    try {
      return await hook.track(
        (async () => {
          const outcome = await hook.scan({
            tool: 'Read',
            phase: o.phase ?? 'post-tool',
            // `in`, not `??`: an explicit `floor: null` or `floor: undefined` must reach the code (plan review P-3).
            floor: 'floor' in o ? o.floor : PASS_FLOOR,
            text: o.text ?? 'tool text',
            redacted: o.redacted ?? false,
          });
          const decision = hook.decide(outcome);
          hook.record(decision);
          return decision;
        })(),
      );
    } finally {
      hook.dispose();
    }
  }
  return { run, rows, warnings, result };
}

const count = (lines: string[], needle: string): number => lines.filter((l) => l.startsWith(needle)).length;

afterEach(() => {
  vi.useRealTimers();
});

describe('constants and states (spec D3, D5; pin 13)', () => {
  it('pins the fixed values and the hook timeout bound', () => {
    expect([JUDGE_HOOK_TIMEOUT_S, JUDGE_MAX_CONCURRENT, JUDGE_EARLY_STOP_AFTER, JUDGE_DRAIN_MS, JUDGE_ABORT_GRACE_MS]).toEqual([
      600, 4, 3, 10_000, 10_000,
    ]);
    expect(JUDGE_HOOK_TIMEOUT_S * 1000).toBeGreaterThan(JUDGE_TIMEOUT_MS);
  });

  it('the telemetry mirrors equal their origins (drift, A-8); ten states and four kinds since #152', () => {
    expect([...JUDGE_CALL_STATES].sort()).toEqual([...JUDGE_SESSION_STATES].sort());
    expect(JUDGE_SESSION_STATES).toHaveLength(10);
    expect(JUDGE_SESSION_STATES).toContain('refused');
    expect([...JUDGE_CALL_ERROR_KINDS].sort()).toEqual([...JUDGE_ERROR_KINDS].sort());
    expect(JUDGE_ERROR_KINDS).toHaveLength(4);
    const verdicts: Record<Verdict, true> = { pass: true, ask: true, block: true };
    expect([...JUDGE_CALL_VERDICTS].sort()).toEqual(Object.keys(verdicts).sort());
  });
});

describe('validateSessionJudge (spec D3, A-10; pins 4, 20, 29, 32)', () => {
  const base = (judge: unknown, extra: Partial<SessionDeps> = {}): SessionDeps =>
    ({
      scanInjection: () => PASS_FLOOR,
      redactSecrets: (t: string) => ({ redacted: t, findings: [] }),
      judge,
      ...extra,
    }) as unknown as SessionDeps;
  const messageOf = (deps: SessionDeps): string => {
    try {
      validateSessionJudge(deps);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(TypeError);
      return (error as Error).message;
    }
    return 'no throw';
  };
  const call: JudgeCall = async () => OK('pass');
  // A dep set to undefined (the key present); named, because the staged secret
  // scan reads a `<name with secret in it>: <value>` pair as a credential.
  const ABSENT = undefined;

  it('accepts a well-formed judge and an absent one', () => {
    expect(messageOf(base({ call, maxCallsPerRun: 1 }))).toBe('no throw');
    expect(messageOf(base({ call, maxCallsPerRun: 1000 }))).toBe('no throw');
    expect(messageOf(base(undefined))).toBe('no throw');
  });

  it('the four messages, verbatim (U-6)', () => {
    expect(messageOf(base({ call: 'nope', maxCallsPerRun: 5 }))).toBe(
      'createSession: deps.judge.call must be a function (build one with buildJudge(query, JUDGE_MODEL))',
    );
    expect(messageOf(base({ call, maxCallsPerRun: 0 }))).toBe('createSession: deps.judge.maxCallsPerRun must be an integer from 1 to 1000');
    expect(messageOf(base({ call, maxCallsPerRun: 5 }, { scanInjection: ABSENT }))).toBe(
      'createSession: deps.judge needs deps.scanInjection (the judge only tightens the heuristic\'s verdict)',
    );
    expect(messageOf(base({ call, maxCallsPerRun: 5 }, { redactSecrets: ABSENT }))).toBe(
      'createSession: deps.judge needs deps.redactSecrets (the judge gets the redacted copy wherever the harness rewrites a tool result; ADR-0037 T-5)',
    );
  });

  it.each([[null], ['always'], [1001], [1.5], ['5'], [Number.NaN]])('a non-object judge or a cap of %j is refused', (value) => {
    const judge = value === null || value === 'always' ? value : { call, maxCallsPerRun: value };
    expect(messageOf(base(judge))).toMatch(/^createSession: deps\.judge\.(call must be a function|maxCallsPerRun must be an integer)/);
  });

  it.each([
    ['__smokeTimeoutMs', 0],
    ['__smokeTimeoutMs', -1],
    ['__smokeTimeoutMs', 1.5],
    ['__smokeTimeoutMs', null],
    ['__smokeHookTimeoutS', 0],
    ['__smokeHookTimeoutS', '30'],
  ])('a malformed %s (%j) is refused (A-3, pin 32)', (key, value) => {
    expect(messageOf(base({ call, maxCallsPerRun: 5, [key]: value }))).toBe(`createSession: deps.judge.${key} must be a positive integer`);
  });

  it('the effective-value rule: a 30 s hook timeout with the default 60 s timer throws; with a 20 s timer it does not (B-4, BF-5)', () => {
    expect(messageOf(base({ call, maxCallsPerRun: 5, __smokeHookTimeoutS: 30 }))).toBe(
      'createSession: the judge hook timeout (30 s) must exceed the judge timer (60000 ms)',
    );
    expect(messageOf(base({ call, maxCallsPerRun: 5, __smokeHookTimeoutS: 30, __smokeTimeoutMs: 20_000 }))).toBe('no throw');
  });
});

describe('Review Focus 1 and 2: forged results and malformed floors', () => {
  it('normalises a forged JudgeCallResult so the row stays valid', () => {
    expect(normaliseCallResult({ ok: true, verdict: 'pass', costUsd: Number.NaN })).toEqual({ ok: true, verdict: 'pass', costUsd: null });
    expect(normaliseCallResult({ ok: true, verdict: 'pass', costUsd: -1 })).toEqual({ ok: true, verdict: 'pass', costUsd: null });
    expect(normaliseCallResult({ ok: true, verdict: 'pass', costUsd: '0.1' })).toEqual({ ok: true, verdict: 'pass', costUsd: null });
    expect(normaliseCallResult({ ok: false, errorKind: 'transport-down\nGATE_FAILURE=none', costUsd: 0.2 })).toEqual({
      ok: false,
      errorKind: 'call-failed',
      costUsd: 0.2,
    });
    // Clause-level pins (code lens C-5): Infinity is not finite (the row validator rejects it), and a free call costs 0, not unknown.
    expect(normaliseCallResult({ ok: true, verdict: 'pass', costUsd: Number.POSITIVE_INFINITY })).toEqual({ ok: true, verdict: 'pass', costUsd: null });
    expect(normaliseCallResult({ ok: true, verdict: 'pass', costUsd: 0 })).toEqual({ ok: true, verdict: 'pass', costUsd: 0 });
    expect(normaliseCallResult({ ok: true, verdict: 'maybe' })).toEqual(CALL_FAILED);
    expect(normaliseCallResult(null)).toEqual(CALL_FAILED);
    expect(normaliseCallResult('block')).toEqual(CALL_FAILED);
    // Issue #152 (T3f): `refused` is in the closed union, so it normalises to itself, cost kept.
    expect(normaliseCallResult({ ok: false, errorKind: 'refused', costUsd: 0.1 })).toEqual({ ok: false, errorKind: 'refused', costUsd: 0.1 });
  });

  it('a forged result through the run writes a row the telemetry validator would accept', async () => {
    const h = harness({ call: (async () => ({ ok: false, errorKind: 'bogus', costUsd: Number.NaN })) as unknown as JudgeCall, maxCallsPerRun: 5 });
    await h.result();
    expect(h.rows).toEqual([expect.objectContaining({ state: 'failed', errorKind: 'call-failed', costUsd: null })]);
  });

  it('a malformed floor never enters the judge path: no call, no row', async () => {
    expect(asFloor({ verdict: 'weird', rule_ids: [], excerpts: [] })).toBeNull();
    expect(asFloor({ verdict: 'ask', rule_ids: 'x', excerpts: [] })).toBeNull();
    expect(asFloor(null)).toBeNull();
    // The floor's own `suspicious` flag is carried through, and only a literal true counts (code lens C-5).
    expect(asFloor({ verdict: 'ask', rule_ids: [], excerpts: [], suspicious: true })?.suspicious).toBe(true);
    expect(asFloor({ verdict: 'ask', rule_ids: [], excerpts: [], suspicious: 'yes' })?.suspicious).toBe(false);
    const fj = fakeJudge(() => OK('block'));
    const h = harness({ call: fj.call, maxCallsPerRun: 5 });
    expect(await h.result({ floor: { verdict: 'weird', rule_ids: [], excerpts: [] } })).toBeNull();
    expect(await h.result({ floor: null })).toBeNull();
    expect(await h.result({ floor: undefined })).toBeNull();
    expect(fj.texts).toEqual([]);
    expect(h.rows).toEqual([]);
    // Positive twin (plan review P-5): a well-formed floor in the same harness reaches the fake once and writes one row.
    expect(await h.result({ floor: PASS_FLOOR })).toMatchObject({ state: 'judged' });
    expect(fj.texts).toHaveLength(1);
    expect(h.rows).toHaveLength(1);
  });

  it('a scanner rejection (non-string text) lands on the floor as failed AND warns with today\'s scanner-failure prefix (spec D3 step 5, ADR-0026 D7)', async () => {
    const fj = fakeJudge(() => OK('block'));
    const h = harness({ call: fj.call, maxCallsPerRun: 5 });
    const decision = await h.result({ text: 123 as unknown as string });
    expect(decision).toMatchObject({ state: 'failed', composed: { verdict: 'pass' } });
    expect(fj.texts).toEqual([]);
    expect(h.rows).toEqual([expect.objectContaining({ state: 'failed', errorKind: null })]);
    expect(h.warnings.join('\n')).toMatch(/^injection scan failed: /m);
  });
});

describe('the recording wrapper and the cap (spec D3 step 1, R4; pin 7)', () => {
  it('N+k concurrent results against cap N: exactly N calls reach the fake, k rows say cap-reached on the floor', async () => {
    const fj = fakeJudge(() => OK('block'));
    const h = harness({ call: fj.call, maxCallsPerRun: 5 });
    const decisions = await Promise.all(Array.from({ length: 8 }, (_, i) => h.result({ id: `t${i}` })));
    expect(fj.texts).toHaveLength(5);
    expect(h.rows.filter((r) => r.state === 'cap-reached')).toHaveLength(3);
    expect(h.rows.filter((r) => r.state === 'judged')).toHaveLength(5);
    expect(decisions.filter((d) => d?.state === 'cap-reached').every((d) => d?.composed.verdict === 'pass')).toBe(true);
    const summary = await h.run.drain();
    expect(summary.calls).toBe(5);
    expect(summary.byState['cap-reached']).toBe(3);
  });

  it('a heuristic block never reserves a slot (the reservation is for a real call only)', async () => {
    const fj = fakeJudge(() => OK('pass'));
    const h = harness({ call: fj.call, maxCallsPerRun: 1 });
    await h.result({ floor: { verdict: 'block', rule_ids: ['b'], excerpts: [], suspicious: false } });
    await h.result();
    expect(h.rows.map((r) => r.state)).toEqual(['not-escalated', 'judged']);
    expect(fj.texts).toHaveLength(1);
  });
});

describe('exceptions land on the floor (Gm1#5; pin 21)', () => {
  it('a JudgeCall that throws synchronously, one that rejects, and one that never settles', async () => {
    vi.useFakeTimers();
    const throwing = harness({ call: (() => { throw new Error('sync'); }) as unknown as JudgeCall, maxCallsPerRun: 5 });
    const rejecting = harness({ call: async () => { throw new Error('async'); }, maxCallsPerRun: 5 });
    const hanging = harness({ call: () => new Promise<never>(() => undefined), maxCallsPerRun: 5 });
    await expect(throwing.result()).resolves.toMatchObject({ state: 'failed' });
    await expect(rejecting.result()).resolves.toMatchObject({ state: 'failed' });
    const pending = hanging.result();
    await vi.advanceTimersByTimeAsync(JUDGE_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({ state: 'timed-out' });
    for (const h of [throwing, rejecting, hanging]) expect(h.rows[0]?.composed).toBe('pass');
    expect(throwing.rows[0]?.errorKind).toBeNull();
  });
});

describe('concurrency (decisions 12 and 14; pin 25)', () => {
  it('six simultaneous escalations never have more than four calls in flight; all six settle; the wait is in durationMs', async () => {
    vi.useFakeTimers();
    const fj = fakeJudge(() => new Promise<JudgeCallResult>((resolve) => setTimeout(() => resolve(OK('pass')), 5_000)));
    const h = harness({ call: fj.call, maxCallsPerRun: 10 });
    const all = Promise.all(Array.from({ length: 6 }, (_, i) => h.result({ id: `t${i}` })));
    await vi.advanceTimersByTimeAsync(10_000);
    await all;
    expect(fj.peak).toBe(4);
    expect(h.rows).toHaveLength(6);
    expect(h.rows.every((r) => r.state === 'judged')).toBe(true);
    expect(h.rows.filter((r) => r.durationMs >= 10_000)).toHaveLength(2);
  });

  it('queue-timeout leg (N-1, T-3, BF-4): the fifth leaves the queue at its own 60 s, never reaches the fake, never counts', async () => {
    vi.useFakeTimers();
    const fj = fakeJudge((_text, signal, n) => {
      if (n === 0) return OK('ask');
      // Holders honour their signal but settle 3 s after it aborts (the shipped CLI's grace).
      return new Promise<JudgeCallResult>((resolve) => {
        signal?.addEventListener('abort', () => setTimeout(() => resolve(CALL_FAILED), 3_000), { once: true });
      });
    });
    const h = harness({ call: fj.call, maxCallsPerRun: 50 });
    await h.result({ id: 'first' });
    const holders = Promise.all([0, 1, 2, 3].map((i) => h.result({ id: `h${i}` })));
    await vi.advanceTimersByTimeAsync(1_000);
    const fifth = h.result({ id: 'fifth' });
    await vi.advanceTimersByTimeAsync(60_000);
    const d5 = await fifth;
    await holders;
    await vi.advanceTimersByTimeAsync(5_000);
    // `texts` first, so a mutation that lets the fifth spawn (M25a2) fails on the spawn, not on the label (plan review R2-4).
    expect(fj.texts).toHaveLength(5);
    expect(d5?.state).toBe('queue-timed-out');
    expect(h.run.context.reserved).toBe(5);
    expect(h.run.context.stopped).toBe(false);
    const summary = await h.run.drain();
    expect(summary.calls).toBe(5);
    expect(summary.byState['queue-timed-out']).toBe(1);
    expect(summary.costUnknown).toBe(4);
    expect(count(h.warnings, 'a judge call timed out')).toBe(1);
    expect(count(h.warnings, 'the judge failed')).toBe(0);
    expect(count(h.warnings, 'all 4 judge slots')).toBe(0);
  });

  it('hung-permit leg (A-1, B-3): four calls that ignore their signal hold every slot; a fifth at +15 s queue-times-out at 75 s and the slots-held line fires once', async () => {
    vi.useFakeTimers();
    const hung = [deferred<JudgeCallResult>(), deferred<JudgeCallResult>(), deferred<JudgeCallResult>(), deferred<JudgeCallResult>()];
    const fj = fakeJudge((_text, _signal, n) => (n === 0 ? OK('pass') : (hung[n - 1]?.promise ?? OK('pass'))));
    const h = harness({ call: fj.call, maxCallsPerRun: 50 });
    await h.result({ id: 'first' });
    const holders = Promise.all([0, 1, 2, 3].map((i) => h.result({ id: `h${i}` })));
    await vi.advanceTimersByTimeAsync(15_000);
    const fifth = h.result({ id: 'fifth' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await fifth)?.state).toBe('queue-timed-out');
    await holders;
    expect(fj.peak).toBe(4);
    expect(count(h.warnings, 'all 4 judge slots')).toBe(1);
    expect(count(h.warnings, 'a judge call timed out')).toBe(0); // R2-2: the line is emitted at CALL SETTLE; a call that never settles never emits it (Spec issues item 10)
    expect(count(h.warnings, 'the judge failed')).toBe(0);
    for (const d of hung) d.resolve(CALL_FAILED);
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe('JudgeSlots abandon paths and the held-for check (code lens C-1, C-6)', () => {
  const settled = async (p: Promise<boolean>): Promise<boolean | 'pending'> => Promise.race([p, new Promise<'pending'>((r) => setImmediate(() => r('pending')))]);

  it('an aborted queued waiter leaves the queue itself: the next release frees the permit, it is not handed to the dead waiter (A-11)', async () => {
    const slots = new JudgeSlots(1);
    await slots.acquire(undefined, () => undefined);
    const ac = new AbortController();
    let abandoned = 0;
    const queued = slots.acquire(ac.signal, () => {
      abandoned += 1;
    });
    ac.abort();
    expect(await queued).toBe(false);
    expect(abandoned).toBe(1);
    slots.release();
    expect(await settled(slots.acquire(undefined, () => undefined))).toBe(true);
  });

  it('an admitted waiter drops its abort listener: a later abort never calls onAbandon (no double decrement)', async () => {
    const slots = new JudgeSlots(1);
    await slots.acquire(undefined, () => undefined);
    const ac = new AbortController();
    let abandoned = 0;
    const queued = slots.acquire(ac.signal, () => {
      abandoned += 1;
    });
    slots.release();
    expect(await queued).toBe(true);
    ac.abort();
    expect(abandoned).toBe(0);
  });

  it('allHeldFor needs every permit HELD, not merely active, and the boundary is >= (B-3)', async () => {
    const slots = new JudgeSlots(1);
    await slots.acquire(undefined, () => undefined);
    // Admitted but not yet holding: active is full, holders is empty.
    expect(slots.allHeldFor(1_000, 0)).toBe(false);
    slots.hold(0);
    expect(slots.allHeldFor(99, 100)).toBe(false);
    expect(slots.allHeldFor(100, 100)).toBe(true);
    expect(slots.allHeldFor(101, 100)).toBe(true);
  });
});

describe('early stop (R6; pin 28)', () => {
  it('three consecutive call-failed results with nothing judged stop further calls; later results are stopped and never count', async () => {
    const fj = fakeJudge(() => CALL_FAILED);
    const h = harness({ call: fj.call, maxCallsPerRun: 50 });
    for (let i = 0; i < 5; i += 1) await h.result({ id: `t${i}` });
    expect(fj.texts).toHaveLength(3);
    expect(h.rows.map((r) => r.state)).toEqual(['failed', 'failed', 'failed', 'stopped', 'stopped']);
    const summary = await h.run.drain();
    expect(summary.calls).toBe(3);
    expect(summary.costUnknown).toBe(3);
    expect(count(h.warnings, 'the judge failed 3 times in a row')).toBe(1);
    expect(count(h.warnings, 'a judge call failed')).toBe(1);
  });

  it('a THROWN call counts toward the stop and prints the first-failure line (code lens C-2)', async () => {
    let calls = 0;
    const throwing: JudgeCall = async () => {
      calls += 1;
      throw new Error('transport exploded');
    };
    const h = harness({ call: throwing, maxCallsPerRun: 50 });
    for (let i = 0; i < 5; i += 1) await h.result({ id: `t${i}` });
    expect(calls).toBe(JUDGE_EARLY_STOP_AFTER);
    expect(h.rows.map((r) => r.state)).toEqual(['failed', 'failed', 'failed', 'stopped', 'stopped']);
    expect(count(h.warnings, 'a judge call failed')).toBe(1);
    expect(count(h.warnings, 'the judge failed 3 times in a row')).toBe(1);
  });

  it('at the cap edge a stopped run is labelled stopped, not cap-reached (code lens C-4)', async () => {
    const fj = fakeJudge(() => CALL_FAILED);
    const h = harness({ call: fj.call, maxCallsPerRun: JUDGE_EARLY_STOP_AFTER });
    for (let i = 0; i < JUDGE_EARLY_STOP_AFTER + 1; i += 1) await h.result({ id: `t${i}` });
    expect(h.rows.map((r) => r.state)).toEqual(['failed', 'failed', 'failed', 'stopped']);
  });

  it('timed-out counts toward the stop too, at call settle (decision 17)', async () => {
    // The calls honour their signal, so each SETTLES after its timer aborts it; a
    // call that never settles is never counted (decision 17), see the next test.
    const honours: JudgeCall = (_t, signal) =>
      new Promise((resolve) => signal?.addEventListener('abort', () => resolve(CALL_FAILED), { once: true }));
    const h = harness({ call: honours, maxCallsPerRun: 50, __smokeTimeoutMs: 5 });
    for (let i = 0; i < 4; i += 1) {
      await h.result({ id: `t${i}` });
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(h.rows.map((r) => r.state)).toEqual(['timed-out', 'timed-out', 'timed-out', 'stopped']);
  });

  it('a call that never settles is never counted (decision 17): three hung timeouts do not stop the judge', async () => {
    const h = harness({ call: () => new Promise<never>(() => undefined), maxCallsPerRun: 50, __smokeTimeoutMs: 5 });
    for (let i = 0; i < 3; i += 1) await h.result({ id: `t${i}` });
    expect(h.rows.map((r) => r.state)).toEqual(['timed-out', 'timed-out', 'timed-out']);
    expect(h.run.context.stopped).toBe(false);
    expect(count(h.warnings, 'a judge call timed out')).toBe(0); // R2-2: the line is emitted at CALL SETTLE; a call that never settles never emits it (Spec issues item 10)
  });

  it('one judged result before the failures disarms the stop for the run', async () => {
    const fj = fakeJudge((_t, _s, n) => (n === 0 ? OK('pass') : CALL_FAILED));
    const h = harness({ call: fj.call, maxCallsPerRun: 50 });
    for (let i = 0; i < 6; i += 1) await h.result({ id: `t${i}` });
    expect(fj.texts).toHaveLength(6);
    expect(h.rows.some((r) => r.state === 'stopped')).toBe(false);
  });

  it('a refused result is ANSWERED (#152 D6, T3c): fail, fail, refused, fail, fail, fail never stops; six calls reach the fake', async () => {
    const script = [CALL_FAILED, CALL_FAILED, REFUSED, CALL_FAILED, CALL_FAILED, CALL_FAILED];
    const fj = fakeJudge((_t, _s, n) => script[n] ?? CALL_FAILED);
    const h = harness({ call: fj.call, maxCallsPerRun: 50 });
    for (let i = 0; i < 6; i += 1) await h.result({ id: `t${i}` });
    expect(fj.texts).toHaveLength(6);
    expect(h.rows.map((r) => r.state)).toEqual(['failed', 'failed', 'refused', 'failed', 'failed', 'failed']);
    expect(h.run.context.stopped).toBe(false);
    expect(h.run.context.disarmed).toBe(true);
    expect(count(h.warnings, 'the judge failed')).toBe(0);
    // Readability half (binds nothing beyond the first under the named mutation): three
    // refusals are not infrastructure, so no first-failure line, no stop, a fourth call.
    const only = fakeJudge(() => REFUSED);
    const r = harness({ call: only.call, maxCallsPerRun: 50 });
    for (let i = 0; i < 4; i += 1) await r.result({ id: `t${i}` });
    expect(only.texts).toHaveLength(4);
    expect(r.rows.every((row) => row.state === 'refused')).toBe(true);
    expect(r.run.context.stopped).toBe(false);
    expect(count(r.warnings, 'a judge call')).toBe(0);
    expect(count(r.warnings, 'the judge failed')).toBe(0);
  });

  it('three unparseable results do NOT stop the judge, and print no first-failure line (A-6)', async () => {
    const fj = fakeJudge(() => UNPARSEABLE);
    const h = harness({ call: fj.call, maxCallsPerRun: 50 });
    for (let i = 0; i < 4; i += 1) await h.result({ id: `t${i}` });
    expect(fj.texts).toHaveLength(4);
    expect(h.rows.every((r) => r.state === 'failed' && r.errorKind === 'unparseable')).toBe(true);
    expect(h.warnings).toEqual([]);
  });

  it('concurrent leg, serialized completion: queued calls admitted after the stop record stopped and release their slot', async () => {
    const pending: Array<(result: JudgeCallResult) => void> = [];
    const fj = fakeJudge(() => new Promise<JudgeCallResult>((resolve) => pending.push(resolve)));
    const h = harness({ call: fj.call, maxCallsPerRun: 50 });
    const all = Promise.all(Array.from({ length: 12 }, (_, i) => h.result({ id: `t${i}` })));
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 25; i += 1) await Promise.resolve();
    };
    await flush();
    expect(fj.live).toBe(JUDGE_MAX_CONCURRENT);
    // Settle the oldest in-flight call, then let its hook finish, one at a time.
    while (pending.length > 0) {
      pending.shift()?.(CALL_FAILED);
      await flush();
    }
    await all;
    const stopped = h.rows.filter((r) => r.state === 'stopped');
    expect(stopped.length).toBe(12 - fj.texts.length);
    expect(stopped.every((r) => r.costUsd === null)).toBe(true);
    expect(h.run.context.reserved).toBe(fj.texts.length);
    expect(fj.peak).toBeLessThanOrEqual(JUDGE_MAX_CONCURRENT);
    // Spec R6 bound (decision 17: counted at call settle, BEFORE the permit is
    // released, so the third failure stops the judge before its freed permit
    // can admit a seventh call). Serialised completion makes it exact.
    expect(fj.texts).toHaveLength(JUDGE_EARLY_STOP_AFTER + JUDGE_MAX_CONCURRENT - 1);
  });

  it('a second run() is a fresh run (pin 8 at the unit level): a new createJudgeRun starts armed and unstopped', async () => {
    const fj = fakeJudge(() => CALL_FAILED);
    const first = harness({ call: fj.call, maxCallsPerRun: 50 });
    for (let i = 0; i < 3; i += 1) await first.result();
    expect(first.run.context.stopped).toBe(true);
    const second = harness({ call: fj.call, maxCallsPerRun: 50 });
    expect(second.run.context.stopped).toBe(false);
    await second.result();
    expect(second.rows[0]?.state).toBe('failed');
  });
});

describe('live lines (U-1, U-3, A-6, E-3; pin 27)', () => {
  it('each live line prints at most once per run, verbatim', async () => {
    const fj = fakeJudge(() => CALL_FAILED);
    const h = harness({ call: fj.call, maxCallsPerRun: 2 });
    for (let i = 0; i < 4; i += 1) await h.result();
    expect(h.warnings).toEqual([
      judgeFirstFailureWarning('failed'),
      judgeCapWarning(2, 1),
    ]);
    expect(judgeFirstFailureWarning('failed')).toBe(
      'a judge call failed; that result used the heuristic only. If this repeats, check ANTHROPIC_API_KEY and the network (a tool result\'s content can also slow the judge), or set judge.mode to "off" in ~/.harness/settings.json.',
    );
    expect(judgeEarlyStopWarning()).toBe(
      'the judge failed 3 times in a row with nothing answered, so it is off for the rest of this run; results use the heuristic only. Check ANTHROPIC_API_KEY and the network; if they are fine, a tool result\'s content may have slowed the judge.',
    );
    expect(judgeCapWarning(200, 7)).toBe(
      'the judge call cap (200) was reached; 7 tool result(s) ran on the heuristic only. Raise judge.maxCallsPerRun in ~/.harness/settings.json to judge more.',
    );
    expect(judgeSlotsHeldWarning(70)).toBe(
      'all 4 judge slots are held by calls that have not finished 70 s after starting, so later tool results are going unjudged. A custom QueryFn must honour abortController; the shipped CLI\'s does.',
    );
  });

  it('two refused results print the refused line exactly once, verbatim, and no failure line (#152 D10, T3d)', async () => {
    const fj = fakeJudge(() => REFUSED);
    const h = harness({ call: fj.call, maxCallsPerRun: 5 });
    await h.result({ id: 'a' });
    await h.result({ id: 'b' });
    expect(h.rows.map((r) => r.state)).toEqual(['refused', 'refused']);
    expect(h.warnings).toEqual([judgeRefusedWarning()]);
    expect(judgeRefusedWarning()).toBe(
      'the provider refused to judge a tool result (its usage-policy filter), so that result is annotated at least ask (rule id judge-refused where that tightened it) and was not judged. ' +
        'The judge stays on; refusals never count toward its early stop, and the summary line and the judge-call rows count them.',
    );
  });

  it('a run whose only unjudged results are queue-timed-out prints no first-failure line (E-3, run level; plan review P-13)', async () => {
    vi.useFakeTimers();
    const controllers = [0, 1, 2, 3].map(() => new AbortController());
    // Four holders: each cancels its own hook during its call and ignores the
    // signal, so it holds a slot with a hook-cancelled row (not R6's class) and
    // never settles (never counted, decision 17).
    const fj = fakeJudge((_t, _s, n) => {
      controllers[n]?.abort();
      return new Promise<never>(() => undefined);
    });
    const h = harness({ call: fj.call, maxCallsPerRun: 50 });
    const holders = Promise.all(controllers.map((c, i) => h.result({ id: `h${i}`, signal: c.signal })));
    await vi.advanceTimersByTimeAsync(1_000);
    const fifth = h.result({ id: 'fifth' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await fifth)?.state).toBe('queue-timed-out');
    await holders;
    expect(h.rows.map((r) => r.state).sort()).toEqual(['hook-cancelled', 'hook-cancelled', 'hook-cancelled', 'hook-cancelled', 'queue-timed-out']);
    expect(count(h.warnings, 'a judge call')).toBe(0);
    expect(count(h.warnings, 'a tool result reached the model WITHOUT')).toBe(1);
  });
});

describe('the decision (spec D3 steps 3, 3a, 3b, 6)', () => {
  it('oversized: no call, no slot, and G-9 composition by the heuristic', async () => {
    const fj = fakeJudge(() => OK('block'));
    const h = harness({ call: fj.call, maxCallsPerRun: 5 });
    const big = 'a'.repeat(131_073);
    const pass = await h.result({ text: big });
    const ask = await h.result({ text: big, floor: ASK_FLOOR });
    const block = await h.result({ text: big, floor: { verdict: 'block', rule_ids: ['b'], excerpts: [], suspicious: false } });
    expect(fj.texts).toEqual([]);
    expect(h.run.context.reserved).toBe(0);
    expect(pass?.composed).toMatchObject({ verdict: 'ask', rule_ids: ['judge-oversized'] });
    expect(ask?.composed).toMatchObject({ verdict: 'ask', rule_ids: ['r-ask'] });
    expect(block?.state).toBe('not-escalated');
    expect(block?.composed.rule_ids).not.toContain('judge-oversized');
  });

  it('failure hook: a redacted input composes as at least ask with judge-redacted only when that tightened it (decision 15)', async () => {
    const pass = harness({ call: async () => OK('pass'), maxCallsPerRun: 5 });
    const d1 = await pass.result({ phase: 'post-tool-failure', redacted: true });
    expect(d1?.composed).toMatchObject({ verdict: 'ask', rule_ids: ['judge-redacted'] });
    expect(pass.rows[0]).toMatchObject({ state: 'judged', heuristic: 'pass', judge: 'pass', composed: 'ask', redacted: true });
    const already = await pass.result({ phase: 'post-tool-failure', redacted: true, floor: ASK_FLOOR });
    expect(already?.composed.rule_ids).not.toContain('judge-redacted');
    const success = await pass.result({ phase: 'post-tool', redacted: true });
    expect(success?.composed.verdict).toBe('pass');
    const stopped = harness({ call: async () => CALL_FAILED, maxCallsPerRun: 1 });
    await stopped.result();
    const capped = await stopped.result({ phase: 'post-tool-failure', redacted: true });
    expect(capped).toMatchObject({ state: 'cap-reached', composed: { verdict: 'ask', rule_ids: ['judge-redacted'] } });
  });

  it('refused (#152 D3, D7; T3b): on a pass floor the row says refused/null/ask/refused with the cost, the note carries judge-refused; on an ask floor nothing is appended', async () => {
    const fj = fakeJudge(() => REFUSED);
    const h = harness({ call: fj.call, maxCallsPerRun: 5 });
    const onPass = await h.result({ id: 'p' });
    expect(onPass).toMatchObject({ state: 'refused', deliver: true, composed: { verdict: 'ask', rule_ids: ['judge-refused'] } });
    expect(onPass?.scan).toMatchObject({ verdict: 'ask', rule_ids: ['judge-refused'], judge: 'refused' });
    expect(h.rows[0]).toEqual({
      tool: 'Read',
      tool_use_id: 'p',
      phase: 'post-tool',
      state: 'refused',
      heuristic: 'pass',
      judge: null,
      composed: 'ask',
      errorKind: 'refused',
      redacted: false,
      costUsd: 0.002283,
      durationMs: expect.any(Number),
    });
    const onAsk = await h.result({ id: 'a', floor: ASK_FLOOR });
    expect(onAsk).toMatchObject({ state: 'refused', deliver: true, composed: { verdict: 'ask', rule_ids: ['r-ask'] } });
    expect(onAsk?.composed.rule_ids).not.toContain('judge-refused');
    expect(h.rows[1]).toMatchObject({ state: 'refused', heuristic: 'ask', judge: null, composed: 'ask', errorKind: 'refused', costUsd: 0.002283 });
    expect(fj.texts).toHaveLength(2);
    const summary = await h.run.drain();
    expect(summary).toMatchObject({ calls: 2, annotated: 2, tightened: 1, costUnknown: 0 });
    expect(summary.byState.refused).toBe(2);
    expect(summary.costUsd).toBeCloseTo(0.004566, 10);
  });

  it('a FAILED scan whose record carries a refused result (the abort-after-refusal race) writes errorKind null, never refused; the failure kinds still ride on failed (#152 review SL2)', () => {
    const h = harness({ call: async () => REFUSED, maxCallsPerRun: 5 });
    const rowFor = (scanJudge: 'failed' | 'refused', result: JudgeCallResult): JudgeCallPayload | undefined => {
      const hook = h.run.enter(undefined, `t-${scanJudge}-${result.ok ? 'ok' : result.errorKind}`);
      const outcome: JudgedScanOutcome = {
        input: { tool: 'Read', phase: 'post-tool', floor: PASS_FLOOR, text: 'tool text', redacted: false },
        floor: PASS_FLOOR,
        scan: { ...PASS_FLOOR, verdict: scanJudge === 'refused' ? 'ask' : 'pass', judge: scanJudge },
        snapshot: { outcome: 'called', result, threw: false },
        durationMs: 1,
      };
      hook.record(hook.decide(outcome));
      hook.dispose();
      return h.rows.at(-1);
    };
    expect(rowFor('failed', REFUSED)).toMatchObject({ state: 'failed', judge: null, composed: 'pass', errorKind: null, costUsd: 0.002283 });
    expect(rowFor('failed', CALL_FAILED)).toMatchObject({ state: 'failed', errorKind: 'call-failed' });
    expect(rowFor('failed', UNPARSEABLE)).toMatchObject({ state: 'failed', errorKind: 'unparseable' });
    expect(rowFor('refused', REFUSED)).toMatchObject({ state: 'refused', errorKind: 'refused', composed: 'ask' });
    // A refused state with a non-refused record cannot arise from the scanner (the brand is the only route to `refused`); the rule still writes nothing misleading.
    expect(rowFor('refused', CALL_FAILED)).toMatchObject({ state: 'refused', errorKind: null });
  });

  it('a pre-aborted hook signal reserves nothing, calls nothing, and is hook-cancelled with no delivery (K-5)', async () => {
    const fj = fakeJudge(() => OK('block'));
    const h = harness({ call: fj.call, maxCallsPerRun: 5 });
    const d = await h.result({ signal: AbortSignal.abort(), phase: 'post-tool-failure', redacted: true });
    expect(fj.texts).toEqual([]);
    expect(h.run.context.reserved).toBe(0);
    expect(d).toMatchObject({ state: 'hook-cancelled', deliver: false });
    expect(d?.composed.rule_ids).not.toContain('judge-redacted');
    expect(h.run.hookWasCancelled('t')).toBe(true);
  });

  it('a null tool_use_id is still cancelled per call and never joins cancelledHooks (B-5, Review Focus 4)', async () => {
    const controller = new AbortController();
    const fj = fakeJudge(() => {
      controller.abort();
      return new Promise<never>(() => undefined);
    });
    const h = harness({ call: fj.call, maxCallsPerRun: 5 });
    const d = await h.result({ signal: controller.signal, id: null });
    expect(d?.state).toBe('hook-cancelled');
    expect(h.run.hookWasCancelled(null)).toBe(false);
  });
});

describe('the summary fold (spec D7, K-6; pin 17)', () => {
  const entry = (state: JudgeSummaryEntry['state'], called: boolean, costUsd: number | null, delivered = false, tightened = false): JudgeSummaryEntry =>
    ({ state, called, costUsd, delivered, tightened });

  it('costUnknown counts reserved slots with no known cost only; unreserved states never count; refused entries fold like oversized (#152, T3e)', () => {
    // Two refused entries (#152): a pass-floor one, tightened to ask with its charged
    // cost, and an ask-floor one, delivered but not tightened. Both were CALLED with a
    // known cost, so costUnknown is unchanged by them.
    const s = foldJudgeSummary(10, 6, [
      entry('judged', true, 0.002, true, true),
      entry('timed-out', true, null),
      entry('failed', true, 0.001),
      entry('cap-reached', false, null),
      entry('oversized', false, null, true, true),
      entry('not-escalated', false, null, true),
      entry('stopped', false, null),
      entry('queue-timed-out', false, null),
      entry('refused', true, 0.002283, true, true),
      entry('refused', true, 0.001, true, false),
    ], 1);
    expect(s).toEqual({
      cap: 10,
      calls: 6,
      byState: {
        'not-escalated': 1, oversized: 1, judged: 1, 'timed-out': 1, failed: 1, refused: 2,
        'cap-reached': 1, 'hook-cancelled': 0, stopped: 1, 'queue-timed-out': 1,
      },
      annotated: 5,
      tightened: 3,
      costUsd: expect.closeTo(0.006283, 10),
      costUnknown: 2,
      pendingAtEnd: 1,
    });
  });

  it('the drain awaits a running path up to JUDGE_DRAIN_MS and counts one past it in pendingAtEnd (D3 step 7)', async () => {
    vi.useFakeTimers();
    const h = harness({ call: async () => OK('pass'), maxCallsPerRun: 5 });
    const hook = h.run.enter(undefined, 'slow');
    void hook.track(new Promise<void>((resolve) => setTimeout(resolve, JUDGE_DRAIN_MS + 5_000)));
    const quick = h.run.enter(undefined, 'quick');
    void quick.track(new Promise<void>((resolve) => setTimeout(resolve, 2_000)));
    const summary = h.run.drain();
    await vi.advanceTimersByTimeAsync(JUDGE_DRAIN_MS);
    expect((await summary).pendingAtEnd).toBe(1);
  });

  it('a drain that finishes inside the bound clears its 10 s timer (code lens C-6)', async () => {
    vi.useFakeTimers();
    const h = harness({ call: async () => OK('pass'), maxCallsPerRun: 5 });
    const quick = h.run.enter(undefined, 'quick');
    void quick.track(new Promise<void>((resolve) => setTimeout(resolve, 2_000)));
    const summary = h.run.drain();
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await summary).pendingAtEnd).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
