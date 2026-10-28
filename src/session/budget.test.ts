import { describe, expect, it } from 'vitest';

import { createHookRuntime } from '../hooks/index.js';
import { DEFAULT_MAX_BUDGET_USD } from '../internal/limits.js';
import { createMemoryStore, openMemoryDatabase } from '../memory/index.js';
import { route } from '../router/index.js';
import type { TelemetryEvent, TelemetryEventInput } from '../telemetry/index.js';
import { createSession } from './session.js';
import type { QueryFn, QueryOptions, SdkMessage, SessionConfig, SessionDeps } from './types.js';

// Issue #187 (ADR-0041): the default-on per-run dollar ceiling, the
// cancellation channel, and D7 (the SDK's throw after an error result).
// Probe 29/10/2026 (SDK 0.3.201): on `error_max_budget_usd` the SDK yields
// the result WITH total_cost_usd and then its iterator throws "Claude Code
// returned an error result: ..."; an abort yields no result and throws.

const INIT: SdkMessage = { type: 'system', subtype: 'init', session_id: 'sdk-187' };
const BUDGET_RESULT: SdkMessage = {
  type: 'result',
  subtype: 'error_max_budget_usd',
  session_id: 'sdk-187',
  num_turns: 1,
  total_cost_usd: 1.12,
  usage: { input_tokens: 10, output_tokens: 5 },
};
const SDK_ERROR_RESULT_THROW = 'Claude Code returned an error result: Reached maximum budget ($1)';

function telemetry() {
  const events: TelemetryEventInput[] = [];
  return {
    events,
    record: (event: TelemetryEventInput) => {
      events.push(event);
      return { ok: true as const, value: { ...event, id: 'evt-1', ts: 1 } as TelemetryEvent };
    },
  };
}

/** Yields `messages`, then throws `throwAfter` when given (the SDK's post-error-result throw). */
function scripted(messages: SdkMessage[], throwAfter?: Error) {
  const captured: QueryOptions[] = [];
  const query: QueryFn = (args) => {
    if (args.options !== undefined) captured.push(args.options);
    return (async function* () {
      for (const m of messages) yield m;
      if (throwAfter !== undefined) throw throwAfter;
    })();
  };
  return { query, captured };
}

/** Honours `abortController` like the real SDK: yields INIT, then blocks until aborted and rejects. */
function abortable() {
  const captured: QueryOptions[] = [];
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const query: QueryFn = (args) => {
    if (args.options !== undefined) captured.push(args.options);
    const signal = args.options?.abortController?.signal;
    return (async function* () {
      yield INIT;
      started();
      await new Promise<never>((_, reject) => {
        if (signal === undefined) return; // never settles: the test times out, red
        const fail = () => reject(new Error('Claude Code process aborted by user'));
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      });
    })();
  };
  return { query, captured, running };
}

function deps(query: QueryFn, extra: Partial<SessionDeps> = {}): SessionDeps {
  return {
    query,
    hooks: createHookRuntime(),
    memory: createMemoryStore(openMemoryDatabase({ path: ':memory:' })),
    loadSkills: () => ({ skills: [], errors: [], root: '/skills' }),
    route,
    ...extra,
  };
}

const config = (extra: Partial<SessionConfig> = {}): SessionConfig => ({ skillsDir: null, ...extra });

function turnCost(events: TelemetryEventInput[]) {
  const row = events.find((e) => e.type === 'turn-cost');
  if (row?.type !== 'turn-cost') throw new Error('no turn-cost row');
  return row.payload;
}

describe('default-on budget (issue #187, D1-D2)', () => {
  it('pins the default at USD 1.00', () => {
    expect(DEFAULT_MAX_BUDGET_USD).toBe(1);
  });

  it('passes the default cap and an AbortController to the primary query when the config names no cap', async () => {
    const fake = scripted([INIT, { ...BUDGET_RESULT, subtype: 'success', result: 'ok' }]);
    await createSession(deps(fake.query), config()).run('hi');
    expect(fake.captured[0]?.maxBudgetUsd).toBe(DEFAULT_MAX_BUDGET_USD);
    expect(fake.captured[0]?.abortController).toBeInstanceOf(AbortController);
  });

  it('passes a configured cap through unchanged', async () => {
    const fake = scripted([INIT, { ...BUDGET_RESULT, subtype: 'success', result: 'ok' }]);
    const result = await createSession(deps(fake.query), config({ maxBudgetUsd: 2.5 })).run('hi');
    expect(fake.captured[0]?.maxBudgetUsd).toBe(2.5);
    expect(result.maxBudgetUsd).toBe(2.5);
  });

  // Lesson :321: only ABSENCE means default; every other value is checked.
  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], [null], ['1']])(
    'refuses maxBudgetUsd %s at construction, before any query',
    (bad) => {
      const fake = scripted([]);
      expect(() => createSession(deps(fake.query), config({ maxBudgetUsd: bad as unknown as number }))).toThrow(
        'SessionConfig.maxBudgetUsd must be a finite number of US dollars greater than 0',
      );
      expect(fake.captured).toHaveLength(0);
    },
  );

  it('refuses a signal that is not an AbortSignal', () => {
    expect(() => createSession(deps(scripted([]).query), config({ signal: {} as AbortSignal }))).toThrow(
      'SessionConfig.signal must be an AbortSignal',
    );
  });
});

describe('budget stop is a distinct, recorded outcome (D4, D7)', () => {
  it('returns the result instead of rethrowing the SDK throw that follows an error result', async () => {
    const t = telemetry();
    const fake = scripted([INIT, BUDGET_RESULT], new Error(SDK_ERROR_RESULT_THROW));
    const result = await createSession(deps(fake.query, { telemetry: t }), config()).run('hi');

    expect(result.resultSubtype).toBe('error_max_budget_usd');
    expect(result.costUsd).toBe(1.12);
    expect(result.maxBudgetUsd).toBe(DEFAULT_MAX_BUDGET_USD);
    const payload = turnCost(t.events);
    expect(payload.resultSubtype).toBe('error_max_budget_usd');
    expect(payload.costUsd).toBe(1.12);
    expect(payload.maxBudgetUsd).toBe(DEFAULT_MAX_BUDGET_USD);
    expect(payload.interrupted).toBe(false);
  });

  it('applies D7 to every error result, not only the budget one', async () => {
    const fake = scripted([INIT, { ...BUDGET_RESULT, subtype: 'error_max_turns' }], new Error('Claude Code returned an error result: x'));
    const result = await createSession(deps(fake.query), config()).run('hi');
    expect(result.resultSubtype).toBe('error_max_turns');
  });

  it('still rethrows a throw that follows a SUCCESS result', async () => {
    const fake = scripted([INIT, { ...BUDGET_RESULT, subtype: 'success', result: 'ok' }], new Error('exit after success'));
    await expect(createSession(deps(fake.query), config()).run('hi')).rejects.toThrow('exit after success');
  });

  it('still rethrows a throw with no result before it', async () => {
    const fake = scripted([INIT], new Error('stream died'));
    await expect(createSession(deps(fake.query), config()).run('hi')).rejects.toThrow('stream died');
  });

  it('records the error result in memory as not failed: the run completed with a non-success subtype', async () => {
    const memory = createMemoryStore(openMemoryDatabase({ path: ':memory:' }));
    const fake = scripted([INIT, BUDGET_RESULT], new Error(SDK_ERROR_RESULT_THROW));
    await createSession(deps(fake.query, { memory }), config()).run('hi');
    const content = JSON.parse(memory.read({})[0]?.content ?? '{}') as Record<string, unknown>;
    expect(content.resultSubtype).toBe('error_max_budget_usd');
    expect(content.failed).toBe(false);
  });
});

describe('cancellation through the caller signal (D5)', () => {
  it('aborts the SDK query, records the turn-cost row as interrupted, fires stop, then rethrows', async () => {
    const t = telemetry();
    const fake = abortable();
    const hooks = createHookRuntime();
    const stops: string[] = [];
    hooks.register('stop', (event) => {
      stops.push(event.sessionId);
    });
    const caller = new AbortController();
    const run = createSession(deps(fake.query, { telemetry: t, hooks }), config({ signal: caller.signal })).run('hi');
    await fake.running;
    caller.abort();

    await expect(run).rejects.toThrow('aborted by user');
    expect(fake.captured[0]?.abortController?.signal.aborted).toBe(true);
    const payload = turnCost(t.events);
    expect(payload.interrupted).toBe(true);
    expect(payload.costUsd).toBeNull();
    expect(payload.maxBudgetUsd).toBe(DEFAULT_MAX_BUDGET_USD);
    expect(stops).toHaveLength(1);
  });

  it('rethrows an abort even when an error result arrived first (interrupt beats D7)', async () => {
    const caller = new AbortController();
    const query: QueryFn = () =>
      (async function* () {
        yield INIT;
        yield BUDGET_RESULT;
        caller.abort();
        throw new Error('Claude Code process aborted by user');
      })();
    await expect(createSession(deps(query), config({ signal: caller.signal })).run('hi')).rejects.toThrow('aborted by user');
  });

  it('removes its listener from the caller signal when the run ends', async () => {
    const caller = new AbortController();
    const fake = scripted([INIT, { ...BUDGET_RESULT, subtype: 'success', result: 'ok' }]);
    await createSession(deps(fake.query), config({ signal: caller.signal })).run('hi');
    caller.abort();
    expect(fake.captured[0]?.abortController?.signal.aborted).toBe(false);
  });

  it('aborts at once when the caller signal is already aborted', async () => {
    const caller = new AbortController();
    caller.abort();
    const fake = abortable();
    const run = createSession(deps(fake.query), config({ signal: caller.signal })).run('hi');
    await expect(run).rejects.toThrow('aborted by user');
  });
});

describe('review fold (#187): D7 keys on a cleaned error subtype; interrupted is the caller signal at stream end', () => {
  it('rethrows the follow-up throw when the result has no subtype', async () => {
    const noSubtype = { type: 'result', session_id: 'sdk-187', total_cost_usd: 0.1 } as SdkMessage;
    const fake = scripted([INIT, noSubtype], new Error(SDK_ERROR_RESULT_THROW));
    await expect(createSession(deps(fake.query), config()).run('hi')).rejects.toThrow(SDK_ERROR_RESULT_THROW);
  });

  it('rethrows when the subtype cleans to nothing', async () => {
    const blank = { ...BUDGET_RESULT, subtype: '\u200b' } as SdkMessage;
    const fake = scripted([INIT, blank], new Error(SDK_ERROR_RESULT_THROW));
    await expect(createSession(deps(fake.query), config()).run('hi')).rejects.toThrow(SDK_ERROR_RESULT_THROW);
  });

  it('rethrows after error-then-success results: the last result wins', async () => {
    const fake = scripted([INIT, BUDGET_RESULT, { ...BUDGET_RESULT, subtype: 'success', result: 'ok' }], new Error('late crash'));
    await expect(createSession(deps(fake.query), config()).run('hi')).rejects.toThrow('late crash');
  });

  it('a caller abort that races the end of the stream returns interrupted: true on the result and the row', async () => {
    const t = telemetry();
    const caller = new AbortController();
    const query: QueryFn = () =>
      (async function* () {
        yield INIT;
        yield { ...BUDGET_RESULT, subtype: 'success', result: 'ok' };
        caller.abort(); // the stream then ends with no throw
      })();
    const result = await createSession(deps(query, { telemetry: t }), config({ signal: caller.signal })).run('hi');
    expect(result.interrupted).toBe(true);
    expect(turnCost(t.events).interrupted).toBe(true);
  });

  it('a caller abort during the stop hook (after the stream ended) is NOT an interrupt', async () => {
    const t = telemetry();
    const caller = new AbortController();
    const hooks = createHookRuntime();
    hooks.register('stop', () => {
      caller.abort();
    });
    const fake = scripted([INIT, { ...BUDGET_RESULT, subtype: 'success', result: 'ok' }]);
    const result = await createSession(deps(fake.query, { telemetry: t, hooks }), config({ signal: caller.signal })).run('hi');
    expect(result.interrupted).toBe(false);
    expect(turnCost(t.events).interrupted).toBe(false);
  });

  // An aborter other than the caller (the SDK's WebSocket transport aborts the
  // controller it is handed; a future wall-clock ceiling would too) is not an
  // interrupt: only the caller's signal is the operator's intent (architecture M2).
  it('a query that aborts its own controller is not recorded as interrupted', async () => {
    const t = telemetry();
    const caller = new AbortController();
    const query: QueryFn = (args) =>
      (async function* () {
        yield INIT;
        args.options?.abortController?.abort();
        throw new Error('transport closed');
      })();
    await expect(
      createSession(deps(query, { telemetry: t }), config({ signal: caller.signal })).run('hi'),
    ).rejects.toThrow('transport closed');
    expect(turnCost(t.events).interrupted).toBe(false);
  });

  it('a normal run returns interrupted: false', async () => {
    const fake = scripted([INIT, { ...BUDGET_RESULT, subtype: 'success', result: 'ok' }]);
    expect((await createSession(deps(fake.query), config()).run('hi')).interrupted).toBe(false);
  });

  it('the default and the predicate are on the public barrel', async () => {
    const barrel = await import('../index.js');
    expect(barrel.DEFAULT_MAX_BUDGET_USD).toBe(1);
    expect(typeof barrel.parseBudgetSettings).toBe('function');
    expect(typeof barrel.BudgetSettingsError).toBe('function');
  });
});
