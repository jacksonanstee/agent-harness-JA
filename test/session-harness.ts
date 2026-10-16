import type Database from 'better-sqlite3';
import { expect } from 'vitest';

import { createHookRuntime } from '../src/hooks/index.js';
import { createMemoryStore } from '../src/memory/index.js';
import { route } from '../src/router/index.js';
import { redact, scan } from '../src/security/index.js';
import type { JudgeCall, JudgeCallResult, ScanResult, Verdict } from '../src/security/index.js';
import { createSession } from '../src/session/session.js';
import type { QueryFn, QueryOptions, SdkHookCallback, SdkMessage, SessionConfig, SessionDeps, SessionJudge } from '../src/session/types.js';
import { createTelemetryStore, openTelemetryDatabase } from '../src/telemetry/index.js';
import type { JudgeCallPayload, TelemetryEvent } from '../src/telemetry/index.js';

// Issue #145 B2a (controller ruling D1): the session-judge test harness, shared
// by session-judge.test.ts and session-withhold.test.ts so neither copies it.
// Lives under test/ (precedent: sdk-guard.setup.ts), never under src/, so it
// does not ship in dist.

export const INIT: SdkMessage = { type: 'system', subtype: 'init', session_id: 'sdk-j' };
export const RESULT = { type: 'result', subtype: 'success', result: 'done', session_id: 'sdk-j', num_turns: 1, total_cost_usd: 0.01 } as SdkMessage;
/** The AWS documentation id, assembled so no literal key sits in the source; the shipped `redact` catches it. */
export const AWS = 'AKIA' + 'IOSFODNN7EXAMPLE';
export const AWS_MARKER = '[REDACTED:aws-access-key-id]';
export const PASS_SCAN: ScanResult = { verdict: 'pass', rule_ids: [], excerpts: [], suspicious: false };
export const ASK_SCAN: ScanResult = { verdict: 'ask', rule_ids: ['r-ask'], excerpts: [], suspicious: true };
export const BLOCK_SCAN: ScanResult = { verdict: 'block', rule_ids: ['r-block'], excerpts: [], suspicious: false };
export const fixed = (r: ScanResult) => (): ScanResult => r;
export const OK = (verdict: Verdict): JudgeCallResult => ({ ok: true, verdict, costUsd: 0.002 });
export const CALL_FAILED: JudgeCallResult = { ok: false, errorKind: 'call-failed', costUsd: null };
/** Issue #152: the live refusal's shape (the charged cost of the 07/10/2026 eb-01 refusal). */
export const REFUSED: JudgeCallResult = { ok: false, errorKind: 'refused', costUsd: 0.002283 };

export interface Call {
  id: string | null;
  tool?: string;
  output?: unknown;
  failError?: string;
  signal?: AbortSignal;
  awaitHook?: boolean;
}

/** Drives the post hooks the way the SDK does: sequential by default, `parallel` for overlapping hooks, `awaitHook: false` for the CLI's fail-open. */
export function drivenQuery(calls: Call[], opts: { parallel?: boolean; userMessages?: SdkMessage[]; beforeMessages?: () => void | Promise<void> } = {}) {
  const outputs = new Map<string | null, unknown>();
  const options: QueryOptions[] = [];
  const query: QueryFn = (args) => {
    if (args.options !== undefined) options.push(args.options);
    return (async function* () {
      const invoke = async (c: Call): Promise<void> => {
        const signal = c.signal ?? new AbortController().signal;
        const hooks = args.options?.hooks;
        const failed = c.failError !== undefined;
        const matchers = (failed ? hooks?.PostToolUseFailure : hooks?.PostToolUse) ?? [];
        const idField = c.id === null ? {} : { tool_use_id: c.id };
        const input = failed
          ? { hook_event_name: 'PostToolUseFailure', tool_name: c.tool ?? 'Bash', tool_input: {}, error: c.failError, ...idField }
          : { hook_event_name: 'PostToolUse', tool_name: c.tool ?? 'Read', tool_input: {}, tool_response: c.output, ...idField };
        for (const matcher of matchers) {
          for (const cb of matcher.hooks as unknown as SdkHookCallback[]) {
            const pending = cb(input as unknown as Parameters<SdkHookCallback>[0], c.id ?? undefined, { signal }).then((out) => {
              outputs.set(c.id, out);
            });
            if (c.awaitHook !== false) await pending;
          }
        }
      };
      if (opts.parallel === true) await Promise.all(calls.map(invoke));
      else for (const c of calls) await invoke(c);
      await opts.beforeMessages?.();
      for (const m of opts.userMessages ?? []) yield m;
      yield INIT;
      yield RESULT;
    })();
  };
  return { query, outputs, options };
}

export interface FakeJudge {
  call: JudgeCall;
  texts: string[];
  signals: (AbortSignal | undefined)[];
  live: number;
  peak: number;
}

export function fakeJudge(reply: (text: string, signal: AbortSignal | undefined, n: number) => JudgeCallResult | Promise<JudgeCallResult>): FakeJudge {
  const fj: FakeJudge = { call: async () => OK('pass'), texts: [], signals: [], live: 0, peak: 0 };
  fj.call = async (text, signal) => {
    const n = fj.texts.length;
    fj.texts.push(text);
    fj.signals.push(signal);
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

const dbs: Database.Database[] = [];
/** Close every in-memory telemetry database `build` opened; each test file calls this from its own afterEach. */
export function closeDbs(): void {
  for (const db of dbs.splice(0)) db.close();
}

export interface Built {
  deps: SessionDeps;
  events: () => TelemetryEvent[];
  judgeRows: () => JudgeCallPayload[];
  warnings: string[];
}

export function build(query: QueryFn, judge: SessionJudge | undefined, overrides: Partial<SessionDeps> = {}): Built {
  const db = openTelemetryDatabase({ path: ':memory:' });
  dbs.push(db);
  const telemetry = createTelemetryStore(db);
  const deps: SessionDeps = {
    query,
    hooks: createHookRuntime(),
    memory: createMemoryStore(db),
    loadSkills: () => ({ skills: [], errors: [], root: '/skills' }),
    route,
    telemetry,
    scanInjection: (text) => scan(text),
    redactSecrets: (text) => redact(text),
    ...(judge === undefined ? {} : { judge }),
    ...overrides,
  };
  return {
    deps,
    events: () => telemetry.query(),
    judgeRows: () => telemetry.query({ type: 'judge-call' }).map((e) => e.payload as JudgeCallPayload),
    warnings: [],
  };
}

export function start(b: Built, config: Partial<SessionConfig> = {}) {
  return createSession(b.deps, { skillsDir: null, onWarning: (w) => b.warnings.push(w), now: () => Date.now(), ...config });
}

export function contextOf(out: unknown): string | undefined {
  return (out as { hookSpecificOutput?: { additionalContext?: string } } | undefined)?.hookSpecificOutput?.additionalContext;
}

/** No row the session wrote was refused by the real validator (it would surface as this warning). */
export function expectNoLostRows(b: Built): void {
  expect(b.warnings.filter((w) => w.startsWith('telemetry record'))).toEqual([]);
}
