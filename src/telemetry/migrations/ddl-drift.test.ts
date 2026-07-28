import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MEMORY_BASELINE_DDL } from '../../memory/store.js';
import { TELEMETRY_EVENT_TYPES } from '../store.js';
import { M001_DDL } from './m001-memory-baseline.js';
import { MIGRATIONS, runMigrations } from './index.js';

// Dual-ownership drift guards (ADR-0011 §3, review finding F3/F5). This
// file's mandate is hand-copied DDL parity — cross-module (this table's DDL
// vs another module's constant) or intra-module (one migration's DDL vs the
// migration immediately before it, e.g. m002 vs m003).
//
// Coverage here is per-pinned-pair, not automatic: nothing in the runner,
// CI, or lint ties "a migration rebuilds a table" to "a byte-diff test
// exists". Each new hand-copied pair needs its own test added to this file,
// or that pair drifts silently — this file only catches divergence for
// pairs someone has actually pinned.
//
// Three different mechanisms are in use below, matched to what each pair
// actually offers — they are not interchangeable, and skimming the wrong one
// as a template for a new pair produces a weaker guard than intended:
//   - Byte-identical re-derivation, when both sides are directly comparable
//     exported text (M001_DDL vs MEMORY_BASELINE_DDL): the test asserts
//     equality on the two constants directly.
//   - Inclusion-only checking, when one side is a list of values and the
//     other is a CHECK clause with no separately exported member list
//     (TELEMETRY_EVENT_TYPES vs telemetry_events' CHECK): the test confirms
//     every listed value is accepted and one bogus value is rejected. That
//     establishes TELEMETRY_EVENT_TYPES ⊆ what the CHECK accepts, but not
//     the converse — it cannot detect the CHECK accepting a value the list
//     doesn't have. (See the caveat on that test, below — this is exactly
//     how 'skill-drop' entered the CHECK undetected.)
//   - Live schema-snapshot diffing, when neither side is a single
//     text-comparable DDL constant. For the m002↔m003 pair this is not
//     because no constant is exported — M003_DDL is a named export — but
//     because a table-rebuild migration's DDL is a multi-statement script
//     (CREATE, INSERT/SELECT, DROP, ALTER, indexes), not text-comparable to
//     a plain CREATE TABLE, and the migration compared against it (m002)
//     exports no DDL constant at all. Here the test runs both migrations
//     against a live database and diffs the resulting sqlite_master.sql
//     instead.

describe('dual-owned schema constants', () => {
  it('migration 001 is byte-identical to memory ensureSchema DDL', () => {
    expect(M001_DDL).toBe(MEMORY_BASELINE_DDL);
  });

  // The gap this comment used to describe closed in the type-level change
  // (issue #46): TELEMETRY_EVENT_TYPES now includes 'skill-drop' (derived from
  // EVENT_TYPE_PRESENCE in store.ts), so the loop below inserts one and this
  // test now probes all four CHECK-admitted values, not just the original
  // three. Per the file-level comment above, this remains INCLUSION-only —
  // TELEMETRY_EVENT_TYPES ⊆ what the CHECK accepts — so it still cannot by
  // itself catch the CHECK admitting a fifth value TELEMETRY_EVENT_TYPES
  // doesn't list; that direction is what the m002↔m003 rebuild-diff test below
  // pins instead, by asserting the CHECK's literal text.
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
  //
  // This guard compares schema TEXT (sqlite_master.sql), so it cannot catch
  // a future rebuild that forgets to copy rowid: a fresh-rowid rebuild
  // produces a byte-identical CREATE TABLE statement — the CREATE TABLE
  // syntax has no rowid clause to differ on. That property is covered
  // separately, by m003.test.ts's row-preservation test (the one with the
  // seeded rowid gap). This test and that one are not redundant; each covers
  // something the other can't see.
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
