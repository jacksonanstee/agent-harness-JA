import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MEMORY_BASELINE_DDL } from '../../memory/store.js';
import { TELEMETRY_EVENT_TYPES } from '../store.js';
import { M001_DDL } from './m001-memory-baseline.js';
import { MIGRATIONS, runMigrations } from './index.js';

// Dual-ownership drift guards (ADR-0011 §3, review finding F3/F5): these
// constants are hand-copied pairs; each test re-derives the invariant so
// divergence fails loudly instead of silently forking the effective schema.

describe('dual-owned schema constants', () => {
  it('migration 001 is byte-identical to memory ensureSchema DDL', () => {
    expect(M001_DDL).toBe(MEMORY_BASELINE_DDL);
  });

  it('the telemetry_events CHECK constraint accepts exactly TELEMETRY_EVENT_TYPES', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, MIGRATIONS);
      const insert = db.prepare(
        `INSERT INTO telemetry_events (id, type, session_id, turn_id, ts, payload)
         VALUES (@id, @type, 's', 't', 1, '{}');`,
      );
      for (const type of TELEMETRY_EVENT_TYPES) {
        expect(() => insert.run({ id: `ok-${type}`, type })).not.toThrow();
      }
      expect(() => insert.run({ id: 'bad', type: 'not-a-type' })).toThrow(/CHECK|constraint/i);
    } finally {
      db.close();
    }
  });

  // DRIFT GUARD. m003 hand-copies m002's column definitions, and nothing
  // re-derives them — the failure class this file exists for, and what
  // DEC-0017 ("pinned derived constants re-derive") requires. Without this,
  // a rebuild that silently dropped NOT NULL from session_id, changed the
  // payload DEFAULT, or lost a column would pass every other test here.
  // m003 is also the FIRST table rebuild, so m004 will copy its shape: the
  // guard has to exist now, not after the pattern has propagated.
  it('rebuilds telemetry_events identically to m002 except for the widened CHECK', () => {
    const beforeDb = new Database(':memory:');
    const afterDb = new Database(':memory:');
    try {
      // Both bounds are deliberate and must stay pinned: this test is a
      // permanent historical record of the m002→m003 delta specifically, not
      // a general "current schema" check. Once m004 exists,
      // MIGRATIONS.filter((m) => m.id <= 3) still isolates exactly the m003
      // rebuild — using the unfiltered MIGRATIONS export here would make this
      // test start reflecting m004's output too, so an m004 change would go
      // red inside a test named and commented for the m002→m003 delta,
      // misdirecting whoever debugs it toward a migration that ships once
      // and cannot be edited.
      runMigrations(beforeDb, MIGRATIONS.filter((m) => m.id <= 2));
      runMigrations(afterDb, MIGRATIONS.filter((m) => m.id <= 3));

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
});
