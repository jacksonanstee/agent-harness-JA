import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS, runMigrations } from './index.js';

function insertRow(db: Database.Database, id: string, type: string): void {
  db.prepare(
    `INSERT INTO telemetry_events (id, type, session_id, turn_id, ts, payload)
     VALUES (@id, @type, 's1', 't1', 100, '{}');`,
  ).run({ id, type });
}

// Distinct sentinel per column so the preservation assertion cannot pass by
// coincidence. Includes a 'skill-drop' row so this rebuild is shown to preserve
// the type m003 added, not just the m002 originals; the 'tool-rewrite' and
// 'judge-call' rows show m006 preserves the types m004 and m005 added.
const PRE_ROWS = [
  { id: 'pre-turn-cost', type: 'turn-cost', session_id: 's-alpha', turn_id: 't-alpha', ts: 100, payload: '{"n":1}' },
  { id: 'pre-tool-trace', type: 'tool-trace', session_id: 's-beta', turn_id: 't-beta', ts: 200, payload: '{"n":2}' },
  { id: 'pre-skill-drop', type: 'skill-drop', session_id: 's-gamma', turn_id: 't-gamma', ts: 300, payload: '{"n":3}' },
  { id: 'pre-tool-rewrite', type: 'tool-rewrite', session_id: 's-delta', turn_id: 't-delta', ts: 400, payload: '{"n":4}' },
  { id: 'pre-judge-call', type: 'judge-call', session_id: 's-epsilon', turn_id: 't-epsilon', ts: 500, payload: '{"n":5}' },
] as const;

function insertPreRow(db: Database.Database, row: (typeof PRE_ROWS)[number]): void {
  db.prepare(
    `INSERT INTO telemetry_events (id, type, session_id, turn_id, ts, payload)
     VALUES (@id, @type, @session_id, @turn_id, @ts, @payload);`,
  ).run(row);
}

describe('m006 init-check-type (#232)', () => {
  it('preserves every pre-existing row, its full content, and its rowid order across the rebuild', () => {
    const db = new Database(':memory:');
    try {
      // Simulate a database created before m006 existed (already at m005).
      runMigrations(db, MIGRATIONS.filter((m) => m.id <= 5));

      // Seed a rowid gap so a BUGGY rebuild (plain INSERT…SELECT, reassigning
      // rowids) is distinguishable from the explicit-rowid copy; see the m003
      // test's comment for why the gap-row is deleted AFTER PRE_ROWS exist.
      insertRow(db, 'gap-row', 'turn-cost');
      for (const row of PRE_ROWS) insertPreRow(db, row);
      db.prepare("DELETE FROM telemetry_events WHERE id = 'gap-row';").run();

      const preRowids = (
        db.prepare('SELECT rowid FROM telemetry_events ORDER BY rowid;').all() as { rowid: number }[]
      ).map((r) => r.rowid);

      runMigrations(db, MIGRATIONS);

      const postRows = db
        .prepare('SELECT rowid, id, type, session_id, turn_id, ts, payload FROM telemetry_events ORDER BY rowid;')
        .all() as {
        rowid: number;
        id: string;
        type: string;
        session_id: string;
        turn_id: string;
        ts: number;
        payload: string;
      }[];

      expect(postRows.map((r) => r.rowid)).toEqual(preRowids);
      expect(
        postRows.map((r) => ({
          id: r.id,
          type: r.type,
          session_id: r.session_id,
          turn_id: r.turn_id,
          ts: r.ts,
          payload: r.payload,
        })),
      ).toEqual(PRE_ROWS);
    } finally {
      db.close();
    }
  });

  it('recreates all three indexes the rebuild drops, on the correct columns', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, MIGRATIONS);
      const indexes = (
        db
          .prepare(
            `SELECT name, sql FROM sqlite_master
             WHERE type = 'index' AND tbl_name = 'telemetry_events' AND name NOT LIKE 'sqlite_%'
             ORDER BY name;`,
          )
          .all() as { name: string; sql: string }[]
      ).map((r) => ({ name: r.name, sql: r.sql.replace(/\s+/g, ' ') }));
      expect(indexes).toEqual([
        {
          name: 'idx_telemetry_events_session',
          sql: 'CREATE INDEX idx_telemetry_events_session ON telemetry_events(session_id, ts)',
        },
        {
          name: 'idx_telemetry_events_turn',
          sql: 'CREATE INDEX idx_telemetry_events_turn ON telemetry_events(turn_id)',
        },
        {
          name: 'idx_telemetry_events_type',
          sql: 'CREATE INDEX idx_telemetry_events_type ON telemetry_events(type, ts)',
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('accepts init-check (and the earlier types) and still rejects an unknown type', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, MIGRATIONS);
      expect(() => insertRow(db, 'ok', 'init-check')).not.toThrow();
      expect(() => insertRow(db, 'ok-jc', 'judge-call')).not.toThrow();
      expect(() => insertRow(db, 'ok-rw', 'tool-rewrite')).not.toThrow();
      expect(() => insertRow(db, 'bad', 'not-a-type')).toThrow(/CHECK|constraint/i);
    } finally {
      db.close();
    }
  });

  it('is the last migration, id 6, so the registry stays contiguous', () => {
    expect(MIGRATIONS.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(MIGRATIONS.at(-1)?.name).toBe('init-check-type');
  });

  it('is idempotent across repeated opens', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, MIGRATIONS);
      insertRow(db, 'kept', 'init-check');
      const second = runMigrations(db, MIGRATIONS);
      expect(second.applied).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM telemetry_events;').get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});
