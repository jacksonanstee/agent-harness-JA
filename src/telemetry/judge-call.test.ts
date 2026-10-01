import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createTelemetryStore, JUDGE_CALL_ERROR_KINDS, JUDGE_CALL_STATES, JUDGE_CALL_VERDICTS } from './index.js';
import type { JudgeCallPayload, TelemetryEventInput } from './index.js';

// Issue #96 PR-B1, spec D6 (pins 15 and 26). The no-text rule is ENFORCED:
// the validator rejects any key outside the closed set first (G-4), each
// enum field outside its mirror (A-5), and a non-boolean `redacted` (N-1).

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function store() {
  const db = new Database(':memory:');
  dbs.push(db);
  return createTelemetryStore(db);
}

const VALID: JudgeCallPayload = {
  tool: 'Read',
  tool_use_id: 'toolu_1',
  phase: 'post-tool',
  state: 'judged',
  heuristic: 'pass',
  judge: 'ask',
  composed: 'ask',
  errorKind: null,
  redacted: false,
  costUsd: 0.0021,
  durationMs: 1500,
};

function write(payload: unknown) {
  const s = store();
  const result = s.record({ type: 'judge-call', sessionId: 's', turnId: 't', payload } as TelemetryEventInput);
  return { result, rows: s.query({ type: 'judge-call' }) };
}

/**
 * `record()` THROWS on an invalid payload (`assertValidInput`, src/telemetry/store.ts:849-850 and :683-685);
 * `ok: false` is only a database failure (plan review P-2). The message pins the payload validator, not the
 * type check, so a leg cannot go green because the TYPE was refused instead.
 */
function expectRejected(payload: unknown): void {
  const s = store();
  expect(() => s.record({ type: 'judge-call', sessionId: 's', turnId: 't', payload } as TelemetryEventInput)).toThrow(
    /^event\.payload is not a valid judge-call payload$/,
  );
  expect(s.query({ type: 'judge-call' })).toHaveLength(0);
}

describe('judge-call rows (spec D6)', () => {
  it('a valid row round-trips', () => {
    const { result, rows } = write(VALID);
    expect(result.ok).toBe(true);
    expect(rows.map((r) => r.payload)).toEqual([VALID]);
  });

  it('nulls are accepted where the type allows them', () => {
    const { result } = write({ ...VALID, tool_use_id: null, judge: null, errorKind: null, costUsd: null, state: 'cap-reached', composed: 'pass' });
    expect(result.ok).toBe(true);
  });

  it.each(['reply', 'excerpt', 'text', 'resultSummary', 'notice'])('rejects an extra %s key at write (closed set, G-4)', (key) => {
    expectRejected({ ...VALID, [key]: 'MARKER tool text' });
  });

  it.each([
    ['state', 'off'],
    ['state', 'judged '],
    ['heuristic', 'deny'],
    ['judge', 'maybe'],
    ['composed', ''],
    ['errorKind', 'transport-down'],
    ['phase', 'pre-tool'],
  ])('rejects %s = %j outside its mirror (A-5)', (field, value) => {
    expectRejected({ ...VALID, [field]: value });
  });

  it.each([['true'], [null], [1], [undefined]])('rejects redacted = %j (must be a boolean, N-1)', (value) => {
    const payload: Record<string, unknown> = { ...VALID, redacted: value };
    if (value === undefined) delete payload.redacted;
    expectRejected(payload);
  });

  it.each([[-0.01], [Number.NaN], [Number.POSITIVE_INFINITY], ['0.1']])('rejects costUsd = %j', (value) => {
    expectRejected({ ...VALID, costUsd: value });
  });

  it.each([[-1], [1.5], [Number.NaN], [null]])('rejects durationMs = %j', (value) => {
    expectRejected({ ...VALID, durationMs: value });
  });

  it('a failed row from an unparseable reply carries its errorKind (A-5)', () => {
    const { result, rows } = write({ ...VALID, state: 'failed', judge: null, composed: 'pass', errorKind: 'unparseable' });
    expect(result.ok).toBe(true);
    expect((rows[0]?.payload as JudgeCallPayload).errorKind).toBe('unparseable');
  });

  it('sanitizes control characters in tool and tool_use_id', () => {
    const bell = String.fromCharCode(7);
    const { rows } = write({ ...VALID, tool: `Re${bell}ad`, tool_use_id: `id${bell}1` });
    expect(rows[0]?.payload).toMatchObject({ tool: 'Re ad', tool_use_id: 'id 1' });
  });

  it('the mirrors carry exactly their members', () => {
    expect([...JUDGE_CALL_STATES].sort()).toEqual(
      ['cap-reached', 'failed', 'hook-cancelled', 'judged', 'not-escalated', 'oversized', 'queue-timed-out', 'stopped', 'timed-out'],
    );
    expect([...JUDGE_CALL_VERDICTS].sort()).toEqual(['ask', 'block', 'pass']);
    expect([...JUDGE_CALL_ERROR_KINDS].sort()).toEqual(['call-failed', 'unknown-enum', 'unparseable']);
  });
});
