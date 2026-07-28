import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  boundSkillDropName,
  boundSkillDropPath,
  createTelemetryStore,
  openTelemetryDatabase,
  SKILL_DROP_REASONS,
  TELEMETRY_EVENT_TYPES,
} from './store.js';
import { SKILL_DROP_NAME_MAX, SKILL_DROP_PATH_MAX } from './types.js';
import type { TelemetryEventInput, TelemetryStore } from './types.js';

let dbs: Database.Database[] = [];
let tmpDirs: string[] = [];

function openStore(): { db: Database.Database; store: TelemetryStore } {
  const db = new Database(':memory:');
  dbs.push(db);
  return { db, store: createTelemetryStore(db) };
}

afterEach(() => {
  for (const db of dbs) db.close();
  dbs = [];
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

const TURN_COST: TelemetryEventInput = {
  type: 'turn-cost',
  sessionId: 's1',
  turnId: 't1',
  payload: {
    model: 'claude-sonnet-4-6',
    ruleId: 'shape-build-small',
    costUsd: 0.1068,
    numTurns: 3,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: null,
    },
    sdkSessionId: 'sdk-1',
    resultSubtype: 'success',
  },
};

const TOOL_TRACE: TelemetryEventInput = {
  type: 'tool-trace',
  sessionId: 's1',
  turnId: 't1',
  payload: { tool: 'Read', phase: 'post-tool', resultSummary: 'file contents…' },
};

const HOOK_EVENT: TelemetryEventInput = {
  type: 'hook-event',
  sessionId: 's1',
  turnId: 't1',
  payload: { kind: 'denied-by-hook', event: 'pre-tool', tool: 'Bash', reason: 'nope', handlerIndex: 0 },
};

describe('createTelemetryStore.record', () => {
  it('round-trips each event type and fills id/ts', () => {
    const { store } = openStore();
    for (const input of [TURN_COST, TOOL_TRACE, HOOK_EVENT]) {
      const result = store.record(input);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.value.ts).toBeGreaterThan(0);
      expect(result.value.type).toBe(input.type);
      expect(result.value.sessionId).toBe(input.sessionId);
      expect(result.value.turnId).toBe(input.turnId);
      expect(result.value.payload).toEqual(input.payload);
    }
    expect(store.query()).toHaveLength(3);
  });

  it('honours a caller-supplied ts', () => {
    const { store } = openStore();
    const result = store.record({ ...TOOL_TRACE, ts: 12345 });
    expect(result.ok && result.value.ts === 12345).toBe(true);
  });

  it('sanitizes control characters in payload strings', () => {
    const { store } = openStore();
    const result = store.record({
      ...HOOK_EVENT,
      payload: {
        kind: 'denied-by-hook',
        event: 'pre-tool',
        tool: 'Bash\x1b[31m',
        reason: 'evil\x07bell\u2028line',
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.type === 'hook-event') {
      expect(result.value.payload.tool).toBe('Bash [31m');
      expect(result.value.payload.reason).toBe('evil bell line');
    }
  });

  it('rejects non-object input with a TypeError', () => {
    const { store } = openStore();
    expect(() => store.record(null as unknown as TelemetryEventInput)).toThrow(TypeError);
  });

  it('rejects an unknown event type with a TypeError', () => {
    const { store } = openStore();
    expect(() =>
      store.record({ ...TOOL_TRACE, type: 'bogus' } as unknown as TelemetryEventInput),
    ).toThrow(TypeError);
  });

  it('rejects missing sessionId/turnId with a TypeError', () => {
    const { store } = openStore();
    expect(() =>
      store.record({ ...TOOL_TRACE, sessionId: 7 } as unknown as TelemetryEventInput),
    ).toThrow(TypeError);
    expect(() =>
      store.record({ ...TOOL_TRACE, turnId: undefined } as unknown as TelemetryEventInput),
    ).toThrow(TypeError);
  });

  it('rejects a negative or non-finite ts with a TypeError', () => {
    const { store } = openStore();
    expect(() => store.record({ ...TOOL_TRACE, ts: -1 })).toThrow(TypeError);
    expect(() => store.record({ ...TOOL_TRACE, ts: Number.NaN })).toThrow(TypeError);
  });

  it('rejects a structurally invalid payload with a TypeError', () => {
    const { store } = openStore();
    expect(() =>
      store.record({
        type: 'tool-trace',
        sessionId: 's1',
        turnId: 't1',
        payload: { tool: 7 },
      } as unknown as TelemetryEventInput),
    ).toThrow(TypeError);
    expect(() =>
      store.record({
        type: 'hook-event',
        sessionId: 's1',
        turnId: 't1',
        payload: { kind: 'not-a-kind', event: 'pre-tool' },
      } as unknown as TelemetryEventInput),
    ).toThrow(TypeError);
  });

  // REGRESSION for round-2 review Finding 2 (LOW). `typeof NaN === 'number'`
  // and `typeof Infinity === 'number'`, so the old `typeof === 'number'` check
  // let a NaN handlerIndex pass write-time validation; JSON.stringify then
  // writes NaN as `null`, and the read-back's re-validation (the same
  // function) rejects it — the same write-passes/read-fails asymmetry as the
  // sparse-array bug, one field over. `Number.isInteger` rejects NaN/Infinity
  // pre-write, same gate as the array fix, so this asserts row count zero,
  // not just that record() throws.
  it('rejects a NaN handlerIndex before writing anything (typeof NaN is "number", but JSON.stringify writes NaN as null)', () => {
    const { store } = openStore();
    expect(() =>
      store.record({
        type: 'hook-event',
        sessionId: 's1',
        turnId: 't1',
        payload: { kind: 'hook-fired', event: 'pre-tool', handlerIndex: Number.NaN },
      }),
    ).toThrow(TypeError);
    expect(store.query({ type: 'hook-event' })).toHaveLength(0);
  });

  it('maps SQLITE_CONSTRAINT to a tagged constraint error', () => {
    const { db, store } = openStore();
    // Force a CHECK violation by bypassing input validation via a raw insert
    // path: drop the table's CHECK by replacing type post-validation is not
    // possible through record(), so simulate a duplicate-id constraint instead.
    const first = store.record(TOOL_TRACE);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Re-insert the same primary key directly to prove the mapping path.
    const insertSame = () =>
      db
        .prepare(
          `INSERT INTO telemetry_events (id, type, session_id, turn_id, ts, payload)
           VALUES (@id, 'tool-trace', 's1', 't1', 1, '{}');`,
        )
        .run({ id: first.value.id });
    expect(insertSame).toThrow(/UNIQUE|constraint/i);
  });
});

describe('createTelemetryStore.query', () => {
  function seed(store: TelemetryStore): void {
    store.record({ ...TURN_COST, ts: 100 });
    store.record({ ...TOOL_TRACE, ts: 200 });
    store.record({ ...HOOK_EVENT, ts: 300 });
    store.record({ ...TOOL_TRACE, sessionId: 's2', turnId: 't2', ts: 400 });
  }

  it('returns all events in ascending trace order by default', () => {
    const { store } = openStore();
    seed(store);
    const events = store.query();
    expect(events.map((e) => e.ts)).toEqual([100, 200, 300, 400]);
  });

  it('filters by sessionId, turnId, and type', () => {
    const { store } = openStore();
    seed(store);
    expect(store.query({ sessionId: 's2' })).toHaveLength(1);
    expect(store.query({ turnId: 't1' })).toHaveLength(3);
    expect(store.query({ type: 'tool-trace' })).toHaveLength(2);
    expect(store.query({ type: 'tool-trace', sessionId: 's1' })).toHaveLength(1);
  });

  it('filters by since (inclusive) and until (exclusive)', () => {
    const { store } = openStore();
    seed(store);
    expect(store.query({ since: 200 }).map((e) => e.ts)).toEqual([200, 300, 400]);
    expect(store.query({ until: 300 }).map((e) => e.ts)).toEqual([100, 200]);
    expect(store.query({ since: 200, until: 400 }).map((e) => e.ts)).toEqual([200, 300]);
  });

  it('honours limit and desc order', () => {
    const { store } = openStore();
    seed(store);
    expect(store.query({ limit: 2 }).map((e) => e.ts)).toEqual([100, 200]);
    expect(store.query({ order: 'desc', limit: 2 }).map((e) => e.ts)).toEqual([400, 300]);
  });

  it('breaks same-ts ties by insertion order (rowid)', () => {
    const { store } = openStore();
    const a = store.record({ ...TOOL_TRACE, ts: 500 });
    const b = store.record({ ...HOOK_EVENT, ts: 500 });
    if (!a.ok || !b.ok) throw new Error('seed failed');
    const asc = store.query({ since: 500 });
    expect(asc.map((e) => e.id)).toEqual([a.value.id, b.value.id]);
    const desc = store.query({ since: 500, order: 'desc' });
    expect(desc.map((e) => e.id)).toEqual([b.value.id, a.value.id]);
  });

  it('rejects invalid filters with a TypeError', () => {
    const { store } = openStore();
    expect(() => store.query({ type: 'nope' } as never)).toThrow(TypeError);
    expect(() => store.query({ limit: -1 })).toThrow(TypeError);
    expect(() => store.query({ limit: 1.5 })).toThrow(TypeError);
    expect(() => store.query({ order: 'sideways' } as never)).toThrow(TypeError);
    expect(() => store.query({ since: Number.NaN })).toThrow(TypeError);
    expect(() => store.query(null as never)).toThrow(TypeError);
  });

  it('throws on a malformed row (defensive validation)', () => {
    const { db, store } = openStore();
    db.prepare(
      `INSERT INTO telemetry_events (id, type, session_id, turn_id, ts, payload)
       VALUES ('bad', 'tool-trace', 's1', 't1', 1, 'not json');`,
    ).run();
    expect(() => store.query()).toThrow(/structural validation|payload/i);
  });

  it('throws on a payload that parses but mismatches its type', () => {
    const { db, store } = openStore();
    db.prepare(
      `INSERT INTO telemetry_events (id, type, session_id, turn_id, ts, payload)
       VALUES ('bad2', 'turn-cost', 's1', 't1', 1, '{"tool":"Read"}');`,
    ).run();
    expect(() => store.query()).toThrow(/structural validation|payload/i);
  });

  // ADR-0025: the refusal fields were added to an already-shipped payload, and
  // isTurnCostPayload runs on the READ path (it throws), so they must be
  // OPTIONAL or every row already on disk stops being readable.
  describe('refusal fields (ADR-0025)', () => {
    it('round-trips the refusal fields, sanitized', () => {
      const { store } = openStore();
      const written = store.record({
        type: 'turn-cost',
        sessionId: 's1',
        turnId: 't1',
        payload: {
          model: 'claude-fable-5',
          ruleId: 'custom',
          costUsd: 0.02,
          numTurns: 1,
          usage: null,
          sdkSessionId: 'sdk-1',
          resultSubtype: 'error_during_execution',
          stopReason: 'refusal',
          refusalCategory: 'cy\u001bber',
          refusalFallbackModel: 'claude-sonnet-5',
        },
      });
      expect(written.ok).toBe(true);

      const rows = store.query({ type: 'turn-cost' });
      const payload = rows[0]?.payload as {
        stopReason: string | null;
        refusalCategory: string | null;
        refusalFallbackModel: string | null;
      };
      expect(payload.stopReason).toBe('refusal');
      expect(payload.refusalCategory).not.toContain('\u001b');
      expect(payload.refusalFallbackModel).toBe('claude-sonnet-5');
    });

    it('still reads a turn-cost row written before the refusal fields existed', () => {
      const { db, store } = openStore();
      // Byte-for-byte the pre-ADR-0025 payload shape: no refusal keys at all.
      db.prepare(
        `INSERT INTO telemetry_events (id, type, session_id, turn_id, ts, payload)
         VALUES ('old1', 'turn-cost', 's1', 't1', 1,
           '{"model":"claude-sonnet-5","ruleId":"shape-build-small","costUsd":0.1,` +
          `"numTurns":2,"usage":null,"sdkSessionId":"sdk-1","resultSubtype":"success"}');`,
      ).run();
      expect(() => store.query()).not.toThrow();
      const rows = store.query({ type: 'turn-cost' });
      expect(rows).toHaveLength(1);
    });

    it('rejects a refusal field of the wrong type', () => {
      const { db, store } = openStore();
      db.prepare(
        `INSERT INTO telemetry_events (id, type, session_id, turn_id, ts, payload)
         VALUES ('bad3', 'turn-cost', 's1', 't1', 1,
           '{"model":"m","ruleId":"r","costUsd":null,"numTurns":null,"usage":null,` +
          `"sdkSessionId":null,"resultSubtype":null,"stopReason":42}');`,
      ).run();
      expect(() => store.query()).toThrow(/structural validation|payload/i);
    });
  });
});

describe('skill-drop events', () => {
  const validPayload = {
    name: 'helper',
    path: '/skills/helper.md',
    pathTruncated: false,
    pathHasEscapes: false,
    reason: 'injection-block' as const,
    channels: ['body', 'assembled section'],
    ruleIds: ['markdown-image-exfil'],
  };

  // THE REGRESSION TEST FOR THE CAP-SEMANTICS BUG. An earlier draft of this
  // plan passed CAP (not CAP - 1) to the truncators, so every truncated value
  // came out CAP + 1 units, failed this validator, threw, and was downgraded
  // to a warning — the row vanished while the run stayed green. Asserting
  // "truncation happened" would NOT have caught it; only asserting the row is
  // actually RECORDED does.
  it('records a row whose fields were truncated at the cap (not silently rejects it)', () => {
    const { store } = openStore();
    const result = store.record({
      type: 'skill-drop',
      sessionId: 's',
      turnId: 't',
      payload: {
        ...validPayload,
        name: 'n'.repeat(SKILL_DROP_NAME_MAX - 1) + '…',
        path: '…' + 'p'.repeat(SKILL_DROP_PATH_MAX - 1),
        pathTruncated: true,
      },
    });
    expect(result.ok).toBe(true);
    const rows = store.query({ type: 'skill-drop' });
    expect(rows).toHaveLength(1);
    expect((rows[0]?.payload as { pathTruncated: boolean }).pathTruncated).toBe(true);
  });

  it('records and reads back a skill-drop row', () => {
    const { store } = openStore();
    const result = store.record({ type: 'skill-drop', sessionId: 's', turnId: 't', payload: validPayload });
    expect(result.ok).toBe(true);
    const rows = store.query({ type: 'skill-drop' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual(validPayload);
  });

  it('rejects a payload whose ruleIds contain a non-string', () => {
    const { store } = openStore();
    expect(() =>
      store.record({
        type: 'skill-drop',
        sessionId: 's',
        turnId: 't',
        payload: { ...validPayload, ruleIds: [42] } as never,
      }),
    ).toThrow(/not a valid skill-drop payload/);
  });

  it('rejects a payload with too many ruleIds', () => {
    const { store } = openStore();
    expect(() =>
      store.record({
        type: 'skill-drop',
        sessionId: 's',
        turnId: 't',
        payload: { ...validPayload, ruleIds: Array.from({ length: 33 }, (_, i) => `r${i}`) },
      }),
    ).toThrow(/not a valid skill-drop payload/);
  });

  it('rejects an unknown reason', () => {
    const { store } = openStore();
    expect(() =>
      store.record({
        type: 'skill-drop',
        sessionId: 's',
        turnId: 't',
        payload: { ...validPayload, reason: 'because' as never },
      }),
    ).toThrow(/not a valid skill-drop payload/);
  });

  // Regression for review Finding 2: pathHasEscapes must be validated the
  // same way its sibling pathTruncated already is — present but wrong-typed
  // is a hard failure, not a silently-coerced row.
  it('rejects a pathHasEscapes of the wrong type', () => {
    const { store } = openStore();
    expect(() =>
      store.record({
        type: 'skill-drop',
        sessionId: 's',
        turnId: 't',
        payload: { ...validPayload, pathHasEscapes: 'true' as never },
      }),
    ).toThrow(/not a valid skill-drop payload/);
  });

  // REGRESSION for round-1 review Finding 1 (HIGH). `Array.prototype.every`
  // (and `.map`, in sanitizePayload) SKIP holes — they walk HasProperty, not
  // indices — but `JSON.stringify` does NOT: it materialises each hole as
  // `null`. A sparse array used to pass this validator, get stored as
  // `["r1",null]`, and then fail the SAME validator on the read-back inside
  // record() — by which point, before Finding 1's transaction fix, the row
  // had already been committed. isBoundedStringArray now uses an indexed
  // loop, which reads a hole as `undefined` and rejects it before any write
  // is attempted; asserting only `toThrow` would not distinguish "rejected
  // before writing" from "rejected after writing," so this also asserts zero
  // rows exist — the row count, not just the error, is the actual bug.
  it('rejects a sparse ruleIds array before writing anything (holes survive .every/.map, JSON.stringify turns them into null)', () => {
    const { store } = openStore();
    const sparse: string[] = [];
    sparse[0] = 'a';
    sparse[2] = 'c'; // no index 1: a genuine hole, not an explicit undefined
    expect(sparse.length).toBe(3); // sanity: the hole is real, not optimized away
    expect(() =>
      store.record({
        type: 'skill-drop',
        sessionId: 's',
        turnId: 't',
        payload: { ...validPayload, ruleIds: sparse },
      }),
    ).toThrow(/not a valid skill-drop payload/);
    expect(store.query({ type: 'skill-drop' })).toHaveLength(0);
  });

  // REGRESSION for round-1 review Finding 1 (HIGH), Part B: the insert and
  // the read-back re-validation now run in ONE db.transaction, so a
  // rowToEvent failure AFTER the insert rolls the insert back. The sparse-
  // array case above is now caught before any write happens (Part A), so it
  // can no longer exercise this path — this test forces a post-insert,
  // pre-return failure directly (an AFTER INSERT trigger corrupts the row
  // that was just written) to prove the rollback mechanism itself, not just
  // the one bug it was built to fix. `ok: false` alone would not have caught
  // the original bug — the row stayed committed while `ok` was false — so
  // this asserts the row count instead.
  it('rolls back the insert if the post-write read-back fails validation (ok:false must mean nothing was written)', () => {
    const { db, store } = openStore();
    db.exec(`
      CREATE TRIGGER corrupt_skill_drop
      AFTER INSERT ON telemetry_events
      WHEN NEW.type = 'skill-drop'
      BEGIN
        UPDATE telemetry_events SET payload = 'not json' WHERE id = NEW.id;
      END;
    `);
    const result = store.record({ type: 'skill-drop', sessionId: 's', turnId: 't', payload: validPayload });
    expect(result.ok).toBe(false);
    expect(store.query({ type: 'skill-drop' })).toHaveLength(0);
  });

  it('sanitizes control characters inside the ruleIds array', () => {
    const { store } = openStore();
    store.record({
      type: 'skill-drop',
      sessionId: 's',
      turnId: 't',
      payload: { ...validPayload, ruleIds: ['rule\u0007id'] },
    });
    const rows = store.query({ type: 'skill-drop' });
    expect((rows[0]?.payload as { ruleIds: string[] }).ruleIds).toEqual(['rule id']);
  });

  it('TELEMETRY_EVENT_TYPES covers every member of the union', () => {
    expect([...TELEMETRY_EVENT_TYPES].sort()).toEqual(
      ['hook-event', 'skill-drop', 'tool-trace', 'turn-cost'],
    );
  });

  // Sibling of the TELEMETRY_EVENT_TYPES test above (round-2 review Finding
  // 3): the type system already enforces exactness both directions for
  // SkillDropReason (SKILL_DROP_REASON_PRESENCE's Record<SkillDropReason,
  // true> and SKILL_DROP_REASON_SET.has in isSkillDropPayload), so this is
  // not closing a real gap — it closes the PATTERN gap, so the asymmetry
  // doesn't read as an oversight to a future reader comparing the two ratchets.
  it('SKILL_DROP_REASONS covers every member of the union', () => {
    expect([...SKILL_DROP_REASONS].sort()).toEqual(['injection-block', 'prompt-budget']);
  });
});

// REGRESSION for round-1 review Finding 3 (HIGH). The caps in types.ts are
// documented as TOTAL stored length including the ellipsis, while the
// truncators bound CONTENT and then append one — so a caller must pass
// `CAP - 1`, and getting that arithmetic backwards silently drops exactly the
// oversized, attacker-controlled rows this feature exists to capture. These
// pin the boundary the helpers exist to make impossible to get wrong: a
// maximally-long input comes out at exactly the cap, not cap + 1.
describe('boundSkillDropPath / boundSkillDropName', () => {
  it('boundSkillDropPath returns a short path unchanged with truncated: false', () => {
    expect(boundSkillDropPath('/skills/helper.md')).toEqual({
      value: '/skills/helper.md',
      truncated: false,
    });
  });

  it('boundSkillDropPath bounds a maximally-long path at exactly SKILL_DROP_PATH_MAX units (not MAX + 1)', () => {
    const longPath = 'p'.repeat(SKILL_DROP_PATH_MAX * 2);
    const result = boundSkillDropPath(longPath);
    expect(result.truncated).toBe(true);
    expect(result.value).toHaveLength(SKILL_DROP_PATH_MAX);
    expect(result.value.startsWith('…')).toBe(true);
  });

  // Regression for review Finding 2: the input here has ALREADY been through
  // escapePathUnsafe (session.ts capture site), so it can contain an
  // `\u{HEX}` token. A naive tail-cut (truncateTailWellFormed alone) has no
  // notion of that token grammar and can slice one in half.
  it('boundSkillDropPath does not split an escapePathUnsafe token in half — drops the whole token instead of a fragment', () => {
    const cap = SKILL_DROP_PATH_MAX - 1;
    const escapeSeq = '\\u{200B}'; // 8 chars: exactly what escapePathUnsafe emits for a real U+200B
    // Positioned so the NAIVE tail-cut (path.length - cap) lands strictly
    // inside the escape sequence, 5 characters in — this arithmetic holds
    // for any cap: naiveFrom = path.length - cap = (2*cap + 1) - cap =
    // cap + 1, and the sequence spans [cap - 4, cap + 4), so cap + 1 is
    // always inside it.
    const prefix = 'p'.repeat(cap - 4);
    const suffix = 'q'.repeat(cap - 3);
    const path = prefix + escapeSeq + suffix;
    const naiveFrom = path.length - cap;
    // Sanity: the naive cut really does land inside the token (offset 5 of
    // 8), or this test proves nothing.
    expect(naiveFrom).toBe(prefix.length + 5);

    const result = boundSkillDropPath(path);
    expect(result.truncated).toBe(true);
    expect(result.value.length).toBeLessThanOrEqual(SKILL_DROP_PATH_MAX);
    // The naive (unguarded) cut would keep the fragment '0B}' — the token's
    // last 3 characters — which reads as ordinary text, not as a truncated
    // escape. The guard must not produce it.
    expect(result.value.startsWith('…0B}')).toBe(false);
    // Guarded behaviour: the whole partial token is dropped, so the kept
    // tail starts at the token's END (the 'q' suffix), never mid-token.
    expect(result.value.startsWith('…q')).toBe(true);
  });

  it('boundSkillDropName returns a short name unchanged', () => {
    expect(boundSkillDropName('helper')).toBe('helper');
  });

  it('boundSkillDropName bounds a maximally-long name at exactly SKILL_DROP_NAME_MAX units (not MAX + 1)', () => {
    const longName = 'n'.repeat(SKILL_DROP_NAME_MAX * 2);
    const result = boundSkillDropName(longName);
    expect(result).toHaveLength(SKILL_DROP_NAME_MAX);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('openTelemetryDatabase', () => {
  it('creates the parent directory, runs migrations, and shares with memory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'telemetry-test-'));
    tmpDirs.push(dir);
    const path = join(dir, 'nested', 'telemetry.db');
    const db = openTelemetryDatabase({ path });
    dbs.push(db);
    expect(existsSync(path)).toBe(true);
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table';`).all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(['memory_entries', 'telemetry_events', 'schema_migrations']),
    );
    expect((db.pragma('journal_mode', { simple: true }) as string).toLowerCase()).toBe('wal');
  });

  it('supports :memory:', () => {
    const db = openTelemetryDatabase({ path: ':memory:' });
    dbs.push(db);
    const store = createTelemetryStore(db);
    expect(store.query()).toEqual([]);
  });
});
