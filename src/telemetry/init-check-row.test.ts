import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createTelemetryStore, INIT_CHECK_ROW_LIST_MAX, INIT_CHECK_ROW_NAME_MAX, INIT_CHECK_ROW_STATES } from './index.js';
import type { InitCheckPayload, TelemetryEventInput } from './index.js';

// Issue #232 (ADR-0046 D4): one init-check row per run. The row is CLOSED and
// mirrors the check's own invariants, so a writer cannot put text, an
// uncapped list or a self-contradicting state on it.

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function store() {
  const db = new Database(':memory:');
  dbs.push(db);
  return createTelemetryStore(db);
}

const CLEAN: InitCheckPayload = { state: 'clean', unruledTools: [], unknownAgents: [], unruledToolCount: 0, unknownAgentCount: 0 };
const NOT_RUN: InitCheckPayload = { ...CLEAN, state: 'not-run' };
const FOUND: InitCheckPayload = {
  state: 'found',
  unruledTools: ['PowerShell', '(non-string)'],
  unknownAgents: ['plugin-agent'],
  unruledToolCount: 2,
  unknownAgentCount: 1,
};

const names = (n: number, prefix = 'T'): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

function write(payload: unknown) {
  const s = store();
  const result = s.record({ type: 'init-check', sessionId: 's', turnId: 't', payload } as TelemetryEventInput);
  return { result, rows: s.query({ type: 'init-check' }) };
}

/** `record()` THROWS on an invalid payload; the message pins the payload validator, not the type check. */
function expectRejected(payload: unknown): void {
  const s = store();
  expect(() => s.record({ type: 'init-check', sessionId: 's', turnId: 't', payload } as TelemetryEventInput)).toThrow(
    /^event\.payload is not a valid init-check payload$/,
  );
  expect(s.query({ type: 'init-check' })).toHaveLength(0);
}

describe('init-check rows (#232)', () => {
  it.each([
    ['clean', CLEAN],
    ['not-run', NOT_RUN],
    ['found', FOUND],
    ['found, tools only', { ...FOUND, unknownAgents: [], unknownAgentCount: 0 }],
    ['found, agents only', { ...FOUND, unruledTools: [], unruledToolCount: 0 }],
    ['found, a list at the cap with more beyond it', { ...FOUND, unruledTools: names(INIT_CHECK_ROW_LIST_MAX), unruledToolCount: 40 }],
    ['found, a name at the length cap', { ...FOUND, unruledTools: [`${'x'.repeat(INIT_CHECK_ROW_NAME_MAX - 1)}…`], unruledToolCount: 1 }],
  ])('a valid %s row round-trips unchanged', (_label, payload) => {
    const { result, rows } = write(payload);
    expect(result.ok).toBe(true);
    expect(rows.map((r) => r.payload)).toEqual([payload]);
  });

  it('the states are exactly the three the check produces', () => {
    expect([...INIT_CHECK_ROW_STATES].sort()).toEqual(['clean', 'found', 'not-run']);
  });

  it('rejects a key outside the closed set (no text can ride on the row)', () => {
    expectRejected({ ...FOUND, detail: 'free text' });
    expectRejected({ ...CLEAN, message: '' });
  });

  it.each(['state', 'unruledTools', 'unknownAgents', 'unruledToolCount', 'unknownAgentCount'])('rejects a row missing %s', (key) => {
    expectRejected(Object.fromEntries(Object.entries(FOUND).filter(([k]) => k !== key)));
  });

  it('rejects a state outside the mirror', () => {
    for (const state of ['ran', 'CLEAN', '', null, 1]) expectRejected({ ...CLEAN, state });
  });

  it('rejects a non-array list or a list holding a non-string', () => {
    expectRejected({ ...FOUND, unruledTools: 'PowerShell' });
    expectRejected({ ...FOUND, unruledTools: { 0: 'PowerShell', length: 1 } });
    expectRejected({ ...FOUND, unruledTools: ['PowerShell', 3], unruledToolCount: 2 });
    expectRejected({ ...FOUND, unknownAgents: [null] });
  });

  it('rejects a sparse list (JSON.stringify writes the hole as null, which the read-back would refuse)', () => {
    // eslint-disable-next-line no-sparse-arrays
    expectRejected({ ...FOUND, unruledTools: ['a', , 'c'], unruledToolCount: 3 });
  });

  it('rejects a list longer than the cap, and a name longer than the cap', () => {
    expectRejected({ ...FOUND, unruledTools: names(INIT_CHECK_ROW_LIST_MAX + 1), unruledToolCount: INIT_CHECK_ROW_LIST_MAX + 1 });
    expectRejected({ ...FOUND, unknownAgents: ['x'.repeat(INIT_CHECK_ROW_NAME_MAX + 1)], unknownAgentCount: 1 });
  });

  it('rejects a count that is not a non-negative safe integer', () => {
    for (const count of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '1', null]) {
      expectRejected({ ...FOUND, unknownAgentCount: count });
    }
    // At the cap the list length no longer pins the count, so only the integer check refuses these.
    for (const count of [INIT_CHECK_ROW_LIST_MAX + 0.5, 2 ** 53, Number.POSITIVE_INFINITY, Number.MAX_VALUE]) {
      expectRejected({ ...FOUND, unruledTools: names(INIT_CHECK_ROW_LIST_MAX), unruledToolCount: count });
    }
  });

  it('rejects a list whose length is not min(count, cap)', () => {
    expectRejected({ ...FOUND, unruledToolCount: 1 }); // two names, count one
    expectRejected({ ...FOUND, unruledToolCount: 3 }); // two names, count three, under the cap
    expectRejected({ ...FOUND, unruledTools: names(INIT_CHECK_ROW_LIST_MAX - 1), unruledToolCount: 40 }); // short of the cap
  });

  it('rejects a state its lists contradict', () => {
    expectRejected({ ...FOUND, state: 'clean' });
    expectRejected({ ...FOUND, state: 'not-run' });
    expectRejected({ ...CLEAN, state: 'found' });
  });

  it('sanitises the names on write, keeping their length', () => {
    const { result, rows } = write({ ...FOUND, unruledTools: ['a\u0007b', 'c\u202Ed'], unruledToolCount: 2 });
    expect(result.ok).toBe(true);
    const payload = rows[0]?.payload as InitCheckPayload;
    for (const name of payload.unruledTools) expect(name).not.toMatch(/[\u0000-\u001f\u007f\u202A-\u202E\u2066-\u2069]/);
    expect(payload.unruledTools.map((n) => n.length)).toEqual([3, 3]);
    expect(payload.state).toBe('found');
    expect(payload.unruledToolCount).toBe(2);
  });

  it('does not keep a reference to the caller\'s arrays', () => {
    const tools = ['PowerShell'];
    const s = store();
    s.record({ type: 'init-check', sessionId: 's', turnId: 't', payload: { ...FOUND, unruledTools: tools, unruledToolCount: 1 } });
    tools.push('LSP');
    expect((s.query({ type: 'init-check' })[0]?.payload as InitCheckPayload).unruledTools).toEqual(['PowerShell']);
  });
});
