import { describe, expect, it, vi } from 'vitest';
import { HOOK_EVENTS, HookDenial, createHookRuntime, fire, register } from './index.js';
import type {
  HookEvent,
  HookEventRecord,
  HookPayload,
  PostToolPayload,
  PreToolPayload,
  SessionStartPayload,
  StopPayload,
} from './index.js';

const preTool: PreToolPayload = { event: 'pre-tool', tool: 'Read', args: { path: '/x' }, redactions: null };
const postTool: PostToolPayload = {
  event: 'post-tool',
  tool: 'Read',
  result: 'ok',
  scan: null,
  redactions: null,
};
const sessionStart: SessionStartPayload = {
  event: 'session-start',
  sessionId: 's1',
  startedAt: 1,
};
const stop: StopPayload = { event: 'stop', sessionId: 's1', stoppedAt: 2 };

function withSink(): { runtime: ReturnType<typeof createHookRuntime>; records: HookEventRecord[] } {
  const records: HookEventRecord[] = [];
  const runtime = createHookRuntime({ onEvent: (r) => records.push(r) });
  return { runtime, records };
}

describe('hooks: register / unregister', () => {
  it('register returns an unsubscribe that removes the handler', async () => {
    const runtime = createHookRuntime();
    const handler = vi.fn();
    const off = runtime.register('post-tool', handler);
    await runtime.fire('post-tool', postTool);
    expect(handler).toHaveBeenCalledTimes(1);
    off();
    await runtime.fire('post-tool', postTool);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe is idempotent', () => {
    const runtime = createHookRuntime();
    const off = runtime.register('stop', vi.fn());
    expect(() => {
      off();
      off();
    }).not.toThrow();
  });

  it('registrations on separate runtimes are isolated', async () => {
    const a = createHookRuntime();
    const b = createHookRuntime();
    const handler = vi.fn();
    a.register('stop', handler);
    await b.fire('stop', stop);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('hooks: programmer errors throw TypeError', () => {
  const runtime = createHookRuntime();

  it('register rejects unknown event names', () => {
    expect(() => runtime.register('pre_tool' as unknown as HookEvent, vi.fn())).toThrow(TypeError);
    expect(() => runtime.register('' as unknown as HookEvent, vi.fn())).toThrow(TypeError);
  });

  it('register rejects non-function handlers', () => {
    expect(() => runtime.register('stop', undefined as never)).toThrow(TypeError);
    expect(() => runtime.register('stop', {} as never)).toThrow(TypeError);
  });

  it('fire rejects unknown event names', async () => {
    await expect(runtime.fire('nope' as unknown as HookEvent, stop)).rejects.toThrow(TypeError);
  });

  it('fire rejects a payload whose event does not match the fired event', async () => {
    // Reproduces the widened-dispatch hole: TS binds E from `event` and won't
    // correlate a separately-typed payload variable. Runtime must catch it.
    const fireDynamic = (event: HookEvent, payload: HookPayload): Promise<unknown> =>
      runtime.fire(event, payload);
    await expect(fireDynamic('pre-tool', stop)).rejects.toThrow(TypeError);
  });
});

describe('hooks: empty registry', () => {
  it('resolves not-denied with zero handlers and emits only hook-fired', async () => {
    const { runtime, records } = withSink();
    const result = await runtime.fire('pre-tool', preTool);
    expect(result).toMatchObject({ event: 'pre-tool', denied: false, handlersFired: 0, errors: [] });
    expect(records).toEqual([{ kind: 'hook-fired', event: 'pre-tool', handlersFired: 0 }]);
  });
});

describe('hooks: HookDenial', () => {
  it('is an Error carrying a reason', () => {
    const denial = new HookDenial('blocked path');
    expect(denial).toBeInstanceOf(Error);
    expect(denial.name).toBe('HookDenial');
    expect(denial.reason).toBe('blocked path');
  });
});

describe('hooks: HOOK_EVENTS', () => {
  it('lists exactly the four locked events', () => {
    expect([...HOOK_EVENTS]).toEqual(['pre-tool', 'post-tool', 'session-start', 'stop']);
  });
});

describe('hooks: integration — payload shape + ordering per event', () => {
  it('runs handlers sequentially in registration order (not completion order)', async () => {
    const runtime = createHookRuntime();
    const order: number[] = [];
    // Descending delays: if dispatch were Promise.all, completion order would
    // be [3,2,1]. Sequential await must produce registration order [1,2,3].
    for (const [id, delay] of [[1, 30], [2, 20], [3, 0]] as const) {
      runtime.register('post-tool', async (payload) => {
        expect(payload).toEqual(postTool);
        await new Promise((r) => setTimeout(r, delay));
        order.push(id);
      });
    }
    await runtime.fire('post-tool', postTool);
    expect(order).toEqual([1, 2, 3]);
  });

  it('pre-tool handler receives the locked payload shape', async () => {
    const runtime = createHookRuntime();
    runtime.register('pre-tool', (p) => {
      expect(p).toEqual({ event: 'pre-tool', tool: 'Read', args: { path: '/x' }, redactions: null });
    });
    expect((await runtime.fire('pre-tool', preTool)).denied).toBe(false);
  });

  it('session-start handler receives the locked payload shape', async () => {
    const runtime = createHookRuntime();
    runtime.register('session-start', (p) => {
      expect(p).toEqual({ event: 'session-start', sessionId: 's1', startedAt: 1 });
    });
    expect((await runtime.fire('session-start', sessionStart)).denied).toBe(false);
  });

  it('stop handler receives the locked payload shape', async () => {
    const runtime = createHookRuntime();
    runtime.register('stop', (p) => {
      expect(p).toEqual({ event: 'stop', sessionId: 's1', stoppedAt: 2 });
    });
    expect((await runtime.fire('stop', stop)).denied).toBe(false);
  });
});

describe('hooks: pre-tool deny', () => {
  it('short-circuits remaining handlers and reports the denier (HookDenial)', async () => {
    const { runtime, records } = withSink();
    const first = vi.fn();
    const third = vi.fn();
    runtime.register('pre-tool', first);
    runtime.register('pre-tool', () => {
      throw new HookDenial('nope');
    });
    runtime.register('pre-tool', third);

    const result = await runtime.fire('pre-tool', preTool);
    expect(first).toHaveBeenCalledTimes(1);
    expect(third).not.toHaveBeenCalled();
    expect(result.denied).toBe(true);
    if (!result.denied) throw new Error('unreachable');
    expect(result.deniedBy).toBe(1);
    expect(result.reason).toBe('nope');
    expect(result.error).toBeInstanceOf(HookDenial);
    expect(result.handlersFired).toBe(2);
    expect(records).toEqual([
      { kind: 'denied-by-hook', event: 'pre-tool', handlerIndex: 1, tool: 'Read', reason: 'nope' },
    ]);
  });

  it('any throw denies — a plain Error also denies', async () => {
    const runtime = createHookRuntime();
    runtime.register('pre-tool', () => {
      throw new Error('boom');
    });
    const result = await runtime.fire('pre-tool', preTool);
    expect(result.denied).toBe(true);
    if (!result.denied) throw new Error('unreachable');
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error).not.toBeInstanceOf(HookDenial);
    expect(result.reason).toBe('boom');
  });

  it('rejected promise from an async handler also denies', async () => {
    const runtime = createHookRuntime();
    runtime.register('pre-tool', async () => Promise.reject(new HookDenial('async-nope')));
    const result = await runtime.fire('pre-tool', preTool);
    expect(result.denied).toBe(true);
  });

  it('a thrown non-Error value denies with its stringified reason', async () => {
    const runtime = createHookRuntime();
    runtime.register('pre-tool', () => {
      throw 'string denial';
    });
    const result = await runtime.fire('pre-tool', preTool);
    expect(result.denied).toBe(true);
    if (!result.denied) throw new Error('unreachable');
    expect(result.reason).toBe('string denial');
    expect(result.error).toBe('string denial');
  });
});

describe('hooks: non-deny throw isolation', () => {
  for (const [event, payload] of [
    ['post-tool', postTool],
    ['session-start', sessionStart],
    ['stop', stop],
  ] as const) {
    it(`${event}: a throwing handler is isolated; later handlers still run`, async () => {
      const { runtime, records } = withSink();
      const second = vi.fn();
      runtime.register(event, () => {
        throw new Error('observer failed');
      });
      runtime.register(event, second);

      const result = await runtime.fire(event, payload);
      expect(second).toHaveBeenCalledTimes(1);
      expect(result.denied).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ handlerIndex: 0, reason: 'observer failed' });
      expect(records).toContainEqual({
        kind: 'hook-error',
        event,
        handlerIndex: 0,
        reason: 'observer failed',
      });
      expect(records).toContainEqual({ kind: 'hook-fired', event, handlersFired: 2 });
    });
  }
});

describe('hooks: sanitization', () => {
  it('strips control characters from denial reasons in result and record', async () => {
    const { runtime, records } = withSink();
    runtime.register('pre-tool', () => {
      throw new HookDenial('a\x00b\nc');
    });
    const result = await runtime.fire('pre-tool', preTool);
    if (!result.denied) throw new Error('unreachable');
    expect(result.reason).not.toMatch(/[\x00-\x1F]/);
    expect(result.reason).toBe('a b c');
    const denied = records.find((r) => r.kind === 'denied-by-hook');
    expect(denied?.reason).toBe('a b c');
  });

  it('strips control characters from isolated error reasons', async () => {
    const runtime = createHookRuntime();
    runtime.register('stop', () => {
      throw new Error('bad\u2028line');
    });
    const result = await runtime.fire('stop', stop);
    expect(result.errors[0]?.reason).toBe('bad line');
  });
});

describe('hooks: default sink is a safe no-op', () => {
  it('a denying handler on a sink-less runtime does not throw', async () => {
    const runtime = createHookRuntime();
    runtime.register('pre-tool', () => {
      throw new HookDenial('x');
    });
    const result = await runtime.fire('pre-tool', preTool);
    expect(result.denied).toBe(true);
  });
});

describe('hooks: snapshot semantics under registry mutation during fire', () => {
  it('unregistering a later handler does not corrupt the in-flight sequence', async () => {
    const runtime = createHookRuntime();
    const later = vi.fn();
    let off: () => void = () => {};
    runtime.register('post-tool', () => {
      off();
    });
    off = runtime.register('post-tool', later);
    await runtime.fire('post-tool', postTool);
    // Snapshot semantics: `later` was registered when fire started, so it runs
    // this time even though it was unregistered mid-fire.
    expect(later).toHaveBeenCalledTimes(1);
    // But it is gone from the next fire.
    await runtime.fire('post-tool', postTool);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('registering a new handler mid-fire does not inject it into the in-flight sequence', async () => {
    const runtime = createHookRuntime();
    const added = vi.fn();
    runtime.register('post-tool', () => {
      runtime.register('post-tool', added);
    });
    await runtime.fire('post-tool', postTool);
    expect(added).not.toHaveBeenCalled(); // not in the entry snapshot
    await runtime.fire('post-tool', postTool);
    expect(added).toHaveBeenCalledTimes(1); // present on the next fire
  });

  it('concurrent fires each use their own entry snapshot', async () => {
    const runtime = createHookRuntime();
    runtime.register('post-tool', async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const firstFire = runtime.fire('post-tool', postTool); // snapshots 1 handler
    runtime.register('post-tool', vi.fn()); // registered after firstFire started
    const secondFire = runtime.fire('post-tool', postTool); // snapshots 2 handlers
    const [a, b] = await Promise.all([firstFire, secondFire]);
    expect(a.handlersFired).toBe(1);
    expect(b.handlersFired).toBe(2);
  });

  it('a handler that re-enters fire does not corrupt the outer result', async () => {
    const runtime = createHookRuntime();
    let inner: Awaited<ReturnType<typeof runtime.fire>> | undefined;
    runtime.register('post-tool', async () => {
      inner = await runtime.fire('stop', stop);
    });
    const outer = await runtime.fire('post-tool', postTool);
    expect(outer.denied).toBe(false);
    expect(outer.handlersFired).toBe(1);
    expect(inner?.denied).toBe(false);
  });
});

describe('hooks: security hardening (3-agent review)', () => {
  it('sanitizes the tool field in the denied-by-hook record', async () => {
    const { runtime, records } = withSink();
    runtime.register('pre-tool', () => {
      throw new HookDenial('nope');
    });
    await runtime.fire('pre-tool', {
      event: 'pre-tool',
      tool: 'evil\x1b[31m\ntool',
      args: null,
      redactions: null,
    });
    const denied = records.find((r) => r.kind === 'denied-by-hook');
    expect(denied?.kind).toBe('denied-by-hook');
    if (denied?.kind !== 'denied-by-hook') throw new Error('unreachable');
    expect(denied.tool).not.toMatch(/[\x00-\x1F]/);
    expect(denied.tool).toBe('evil [31m tool');
  });

  it('a non-string tool on the deny path is coerced, not thrown (fail-closed symmetry)', async () => {
    const { runtime, records } = withSink();
    runtime.register('pre-tool', () => {
      throw new HookDenial('nope');
    });
    // This boundary distrusts payload typing; a non-string tool must still
    // resolve to a deny result, not make fire() reject with a TypeError.
    const result = await runtime.fire('pre-tool', {
      event: 'pre-tool',
      tool: 42 as unknown as string,
      args: null,
      redactions: null,
    });
    expect(result.denied).toBe(true);
    const denied = records.find((r) => r.kind === 'denied-by-hook');
    if (denied?.kind !== 'denied-by-hook') throw new Error('unreachable');
    expect(denied.tool).toBe('42');
  });

  it('a throwing telemetry sink cannot break fire control flow', async () => {
    const runtime = createHookRuntime({
      onEvent: () => {
        throw new Error('sink exploded');
      },
    });
    const handler = vi.fn();
    runtime.register('post-tool', handler);
    const result = await runtime.fire('post-tool', postTool);
    expect(result.denied).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('freezes the payload so a handler cannot swap a top-level field', async () => {
    const runtime = createHookRuntime();
    const payload: PreToolPayload = { event: 'pre-tool', tool: 'Read', args: { path: '/x' }, redactions: null };
    runtime.register('pre-tool', (p) => {
      // Handlers receive a frozen payload; a top-level reassignment is a no-op
      // (silent in sloppy mode, throws in strict). Either way `tool` is intact.
      try {
        (p as { tool: string }).tool = 'Write';
      } catch {
        /* strict-mode TypeError on frozen object — also acceptable */
      }
    });
    await runtime.fire('pre-tool', payload);
    expect(payload.tool).toBe('Read');
    expect(Object.isFrozen(payload)).toBe(true);
  });
});

describe('hooks: bare default-instance API', () => {
  it('bare register + fire operate on the shared default runtime', async () => {
    const handler = vi.fn();
    const off = register('session-start', handler);
    const result = await fire('session-start', sessionStart);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.denied).toBe(false);
    off();
    await fire('session-start', sessionStart);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
