import type {
  FireResult,
  HookEvent,
  HookHandler,
  HookHandlerError,
  HookPayloadMap,
  HookRuntime,
  HookRuntimeOptions,
  HookSink,
  PreToolPayload,
  Unsubscribe,
} from './types.js';

export const HOOK_EVENTS = [
  'pre-tool',
  'post-tool',
  'session-start',
  'stop',
] as const satisfies readonly HookEvent[];

const HOOK_EVENT_SET: ReadonlySet<string> = new Set(HOOK_EVENTS);

/**
 * Thrown by a pre-tool handler to deny the pending tool call. Any throw denies
 * (per ADR-0008 / architecture.md); this class is the typed, reason-carrying
 * way to do it.
 */
export class HookDenial extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'HookDenial';
    this.reason = reason;
  }
}

// Keep in lockstep with CONTROL_CHARS in src/router/route.ts and
// src/skills/load.ts. Handler messages reach the (log/terminal-adjacent) sink,
// so strip control + Unicode line/paragraph separators to prevent log
// injection. Copied rather than imported: hooks depends on nothing (ADR-0008).
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F\u2028\u2029]/g;

function sanitize(text: string): string {
  return text.replace(CONTROL_CHARS, ' ');
}

function reasonOf(thrown: unknown): string {
  return sanitize(thrown instanceof Error ? thrown.message : String(thrown));
}

function assertValidEvent(event: HookEvent): void {
  if (!HOOK_EVENT_SET.has(event)) {
    throw new TypeError(
      `event must be one of ${HOOK_EVENTS.join('|')}, got ${String(event)}`,
    );
  }
}

function assertHandler(handler: unknown): void {
  if (typeof handler !== 'function') {
    throw new TypeError(`handler must be a function, got ${String(handler)}`);
  }
}

export function createHookRuntime(opts: HookRuntimeOptions = {}): HookRuntime {
  const registry = new Map<HookEvent, HookHandler[]>();
  const emit: HookSink = opts.onEvent ?? (() => {});

  function register<E extends HookEvent>(event: E, handler: HookHandler<E>): Unsubscribe {
    assertValidEvent(event);
    assertHandler(handler);
    const handlers = registry.get(event) ?? [];
    handlers.push(handler as HookHandler);
    registry.set(event, handlers);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const current = registry.get(event);
      if (!current) return;
      const index = current.indexOf(handler as HookHandler);
      if (index !== -1) current.splice(index, 1);
    };
  }

  async function fire<E extends HookEvent>(
    event: E,
    payload: HookPayloadMap[E],
  ): Promise<FireResult> {
    assertValidEvent(event);
    // Snapshot so unregister-during-fire cannot corrupt the in-flight sequence.
    const snapshot = [...(registry.get(event) ?? [])];
    const errors: HookHandlerError[] = [];
    let handlersFired = 0;

    for (const [index, handler] of snapshot.entries()) {
      handlersFired++;
      try {
        await handler(payload);
      } catch (thrown: unknown) {
        const reason = reasonOf(thrown);
        if (event === 'pre-tool') {
          emit({
            kind: 'denied-by-hook',
            event: 'pre-tool',
            handlerIndex: index,
            tool: (payload as PreToolPayload).tool,
            reason,
          });
          return { event, handlersFired, errors, denied: true, deniedBy: index, reason, error: thrown };
        }
        errors.push({ handlerIndex: index, reason, error: thrown });
        emit({ kind: 'hook-error', event, handlerIndex: index, reason });
      }
    }

    emit({ kind: 'hook-fired', event, handlersFired });
    return { event, handlersFired, errors, denied: false };
  }

  return { register, fire };
}

const defaultRuntime = createHookRuntime();

export function register<E extends HookEvent>(event: E, handler: HookHandler<E>): Unsubscribe {
  return defaultRuntime.register(event, handler);
}

export function fire<E extends HookEvent>(
  event: E,
  payload: HookPayloadMap[E],
): Promise<FireResult> {
  return defaultRuntime.fire(event, payload);
}
