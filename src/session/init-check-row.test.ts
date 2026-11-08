import Database from 'better-sqlite3';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';

import { createHookRuntime } from '../hooks/index.js';
import { createMemoryStore, openMemoryDatabase } from '../memory/index.js';
import { route } from '../router/index.js';
import { AgentDefinitionRefused, INIT_CHECK_LIST_MAX, INIT_CHECK_NAME_MAX } from '../security/index.js';
import type { AgentScanResult, InitCheckState } from '../security/index.js';
import { createTelemetryStore, INIT_CHECK_ROW_LIST_MAX, INIT_CHECK_ROW_NAME_MAX, INIT_CHECK_ROW_STATES } from '../telemetry/index.js';
import type { InitCheckPayload, InitCheckRowState } from '../telemetry/index.js';
import { createSession } from './session.js';
import type { QueryFn, SdkMessage, SessionDeps } from './types.js';

// Issue #232 (ADR-0046 D4): the session records its init check as one telemetry
// row per run. The rows go into a REAL store, so a payload the store's
// validator refuses fails here instead of degrading to one stderr warning.

describe('the telemetry mirrors equal their security origin (#232)', () => {
  it('the row states are the check states', () => {
    const origin: Record<InitCheckState, true> = { 'not-run': true, clean: true, found: true };
    expect([...INIT_CHECK_ROW_STATES].sort()).toEqual(Object.keys(origin).sort());
    // And at the type level, both directions (`npm run typecheck` checks test files).
    expectTypeOf<InitCheckRowState>().toEqualTypeOf<InitCheckState>();
  });

  it('the caps are the check caps', () => {
    expect(INIT_CHECK_ROW_LIST_MAX).toBe(INIT_CHECK_LIST_MAX);
    expect(INIT_CHECK_ROW_NAME_MAX).toBe(INIT_CHECK_NAME_MAX);
  });
});

const RESULT: SdkMessage = {
  type: 'result',
  subtype: 'success',
  result: 'ok',
  session_id: 'sdk-1',
  num_turns: 1,
  total_cost_usd: 0.01,
  usage: { input_tokens: 1, output_tokens: 1 },
};

const init = (tools: unknown[], agents: unknown[]): SdkMessage => ({ type: 'system', subtype: 'init', session_id: 'sdk-1', tools, agents }) as SdkMessage;
const clean = (): AgentScanResult => ({ admittedNames: new Set(['helper']), refusals: [], filesScanned: 1 });

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

/** A session whose SDK stream yields `messages`, then the result, or throws `streamThrows` in its place. */
function setup(messages: SdkMessage[], options: { streamThrows?: Error; scan?: () => AgentScanResult } = {}) {
  const db = new Database(':memory:');
  dbs.push(db);
  const telemetry = createTelemetryStore(db);
  const warnings: string[] = [];
  const query: QueryFn = () =>
    (async function* () {
      for (const message of messages) yield message;
      if (options.streamThrows !== undefined) throw options.streamThrows;
      yield RESULT;
    })();
  const deps: SessionDeps = {
    query,
    hooks: createHookRuntime(),
    memory: createMemoryStore(openMemoryDatabase({ path: ':memory:' })),
    loadSkills: () => ({ skills: [], errors: [], root: '/skills' }),
    route,
    telemetry,
    scanAgents: options.scan ?? clean,
  };
  const session = createSession(deps, { skillsDir: null, onWarning: (w) => warnings.push(w) });
  const initRows = () => telemetry.query({ type: 'init-check' });
  return { session, initRows, telemetry, warnings };
}

describe('the session records its init check (#232)', () => {
  it.each([
    ['clean', [init(['Read', 'Agent'], ['general-purpose', 'helper'])]],
    ['found', [init(['Read', 'FutureTool'], ['plugin:spy'])]],
    ['not-run (no init message)', []],
    ['not-run (an init message without lists)', [{ type: 'system', subtype: 'init', session_id: 'sdk-1' } as SdkMessage]],
  ])('%s: exactly one row, equal to the result\'s initCheck, keyed like the turn-cost row', async (_label, messages) => {
    const { session, initRows, telemetry, warnings } = setup(messages);
    const result = await session.run('hi');
    const rows = initRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual(result.initCheck);
    const [turnCost] = telemetry.query({ type: 'turn-cost' });
    expect(rows[0]?.sessionId).toBe(turnCost?.sessionId);
    expect(rows[0]?.turnId).toBe(turnCost?.turnId);
    expect(warnings.filter((w) => w.startsWith('telemetry'))).toEqual([]);
  });

  it('the row lands after the stream and before the turn-cost row (the ADR-0011 order)', async () => {
    const { session, telemetry } = setup([init(['FutureTool'], [])]);
    await session.run('hi');
    const types = telemetry.query().map((row) => row.type);
    expect(types.indexOf('init-check')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('init-check')).toBe(types.indexOf('turn-cost') - 1);
  });

  it('only the first init message is recorded, as only the first is checked', async () => {
    const { session, initRows } = setup([init(['FutureTool'], []), init(['Read'], [])]);
    await session.run('hi');
    expect(initRows().map((r) => (r.payload as InitCheckPayload).unruledTools)).toEqual([['FutureTool']]);
  });

  it('a check at both caps (17 long names, a non-string) is stored, not refused by the store', async () => {
    const long = Array.from({ length: INIT_CHECK_LIST_MAX + 1 }, (_, i) => `Future${i}${'x'.repeat(INIT_CHECK_NAME_MAX * 2)}`);
    const { session, initRows } = setup([init([...long, 42], ['a‮b'])]);
    const result = await session.run('hi');
    expect(result.initCheck.unruledToolCount).toBe(INIT_CHECK_LIST_MAX + 2);
    expect(initRows().map((r) => r.payload)).toEqual([result.initCheck]);
  });

  it('a stream that throws after the init message still leaves the row', async () => {
    const { session, initRows } = setup([init(['FutureTool'], [])], { streamThrows: new Error('stream broke') });
    await expect(session.run('hi')).rejects.toThrow('stream broke');
    expect(initRows().map((r) => (r.payload as InitCheckPayload).state)).toEqual(['found']);
  });

  it('a stream that throws before any init message records not-run', async () => {
    const { session, initRows } = setup([], { streamThrows: new Error('stream broke') });
    await expect(session.run('hi')).rejects.toThrow('stream broke');
    expect(initRows().map((r) => (r.payload as InitCheckPayload).state)).toEqual(['not-run']);
  });

  it('a run refused before the SDK is called (a refused agent file) writes no row, as it writes no turn-cost row', async () => {
    const refused = (): AgentScanResult => ({ admittedNames: new Set(), refusals: [{ source: 'project', path: 'evil.md', reason: 'isolation' }], filesScanned: 1 });
    const { session, initRows, telemetry } = setup([], { scan: refused });
    await expect(session.run('hi')).rejects.toThrow(AgentDefinitionRefused);
    expect(initRows()).toEqual([]);
    expect(telemetry.query({ type: 'turn-cost' })).toEqual([]);
  });
});
