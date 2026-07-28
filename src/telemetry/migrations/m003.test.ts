import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS, runMigrations } from './index.js';

function insertRow(db: Database.Database, id: string, type: string): void {
  db.prepare(
    `INSERT INTO telemetry_events (id, type, session_id, turn_id, ts, payload)
     VALUES (@id, @type, 's1', 't1', 100, '{}');`,
  ).run({ id, type });
}

// Each row below carries a distinct sentinel per column so the row-
// preservation assertion below can't pass by coincidence: a dropped/reset
// `payload` column, or a `session_id`/`turn_id` transposition, changes the
// resulting object and fails toEqual(PRE_ROWS).
const PRE_ROWS = [
  { id: 'pre-turn-cost', type: 'turn-cost', session_id: 's-alpha', turn_id: 't-alpha', ts: 100, payload: '{"n":1}' },
  { id: 'pre-tool-trace', type: 'tool-trace', session_id: 's-beta', turn_id: 't-beta', ts: 200, payload: '{"n":2}' },
  { id: 'pre-hook-event', type: 'hook-event', session_id: 's-gamma', turn_id: 't-gamma', ts: 300, payload: '{"n":3}' },
] as const;

function insertPreRow(db: Database.Database, row: (typeof PRE_ROWS)[number]): void {
  db.prepare(
    `INSERT INTO telemetry_events (id, type, session_id, turn_id, ts, payload)
     VALUES (@id, @type, @session_id, @turn_id, @ts, @payload);`,
  ).run(row);
}

describe('m003 skill-drop-type', () => {
  it('preserves every pre-existing row, its full content, and its rowid order across the rebuild', () => {
    const db = new Database(':memory:');
    try {
      // Simulate a database created before m003 existed.
      runMigrations(db, MIGRATIONS.filter((m) => m.id <= 2));

      // Seed a rowid gap. Without this, three sequential inserts into a fresh
      // table get rowids 1,2,3 — and a BUGGY rebuild (plain INSERT…SELECT,
      // auto-reassigning rowids) also produces 1,2,3, because there is no gap
      // for the renumbering to disturb. The rowid assertion below would then
      // pass whether or not the fix is present. Verified empirically during
      // review.
      //
      // The gap-row must be deleted AFTER PRE_ROWS exist, not before: SQLite
      // resets its rowid high-water mark to 0 whenever a table is fully
      // empty, so deleting gap-row while it is the table's only row (delete
      // then insert) produces no gap at all — the next insert just reuses
      // rowid 1. Deleting it while PRE_ROWS are already present (insert,
      // insert, delete) leaves a genuine, permanent gap. Verified empirically
      // — see task-2-report.md.
      insertRow(db, 'gap-row', 'turn-cost');
      for (const row of PRE_ROWS) insertPreRow(db, row);
      db.prepare("DELETE FROM telemetry_events WHERE id = 'gap-row';").run();

      const preRowids = (
        db.prepare('SELECT rowid FROM telemetry_events ORDER BY rowid;').all() as { rowid: number }[]
      ).map((r) => r.rowid);

      runMigrations(db, MIGRATIONS);

      const postRows = db
        .prepare(
          'SELECT rowid, id, type, session_id, turn_id, ts, payload FROM telemetry_events ORDER BY rowid;',
        )
        .all() as {
        rowid: number;
        id: string;
        type: string;
        session_id: string;
        turn_id: string;
        ts: number;
        payload: string;
      }[];

      // Rowid isn't carried by plain INSERT…SELECT and SQLite doesn't
      // guarantee SELECT order without ORDER BY — this pins both.
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
      // Whitespace is normalized: this pins the index definitions (columns
      // and order), not the DDL's cosmetic column-alignment spacing.
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

  // DRIFT GUARD. m003 hand-copies m002's column definitions, and nothing
  // re-derives them — the failure class ddl-drift.test.ts exists for, and what
  // DEC-0017 ("pinned derived constants re-derive") requires. Without this,
  // a rebuild that silently dropped NOT NULL from session_id, changed the
  // payload DEFAULT, or lost a column would pass every other test here.
  // m003 is also the FIRST table rebuild, so m004 will copy its shape: the
  // guard has to exist now, not after the pattern has propagated.
  it('rebuilds telemetry_events identically to m002 except for the widened CHECK', () => {
    const beforeDb = new Database(':memory:');
    const afterDb = new Database(':memory:');
    try {
      runMigrations(beforeDb, MIGRATIONS.filter((m) => m.id <= 2));
      runMigrations(afterDb, MIGRATIONS);

      const tableSql = (db: Database.Database): string =>
        (
          db
            .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_events';")
            .get() as { sql: string }
        ).sql.replace(/\s+/g, ' ');

      // Normalise ONLY the two things that are allowed to differ: the CHECK
      // list, and the table-name quoting that ALTER TABLE … RENAME introduces
      // (verified empirically: SQLite stores CREATE TABLE "telemetry_events"
      // after a rename, vs unquoted CREATE TABLE telemetry_events for the
      // native m002 CREATE TABLE). Everything else must match byte-for-byte.
      const normalise = (sql: string): string =>
        sql
          .replace(/CHECK \(type IN \([^)]*\)\)/, 'CHECK(<TYPES>)')
          .replace(/CREATE TABLE "?telemetry_events"?/, 'CREATE TABLE telemetry_events');

      expect(normalise(tableSql(afterDb))).toBe(normalise(tableSql(beforeDb)));

      // And pin that the widened list is exactly the old one plus one literal.
      expect(tableSql(afterDb)).toContain(
        "CHECK (type IN ('turn-cost','tool-trace','hook-event','skill-drop'))",
      );
    } finally {
      beforeDb.close();
      afterDb.close();
    }
  });

  it('accepts skill-drop and still rejects an unknown type', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, MIGRATIONS);
      expect(() => insertRow(db, 'ok', 'skill-drop')).not.toThrow();
      expect(() => insertRow(db, 'bad', 'not-a-type')).toThrow(/CHECK|constraint/i);
    } finally {
      db.close();
    }
  });

  it('is idempotent across repeated opens', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, MIGRATIONS);
      insertRow(db, 'kept', 'skill-drop');
      const second = runMigrations(db, MIGRATIONS);
      expect(second.applied).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM telemetry_events;').get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});
