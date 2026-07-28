import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS, runMigrations } from './index.js';

const OLD_TYPES = ['turn-cost', 'tool-trace', 'hook-event'] as const;

function insertRow(db: Database.Database, id: string, type: string): void {
  db.prepare(
    `INSERT INTO telemetry_events (id, type, session_id, turn_id, ts, payload)
     VALUES (@id, @type, 's1', 't1', 100, '{}');`,
  ).run({ id, type });
}

describe('m003 skill-drop-type', () => {
  it('preserves every pre-existing row when migrating an operator database', () => {
    const db = new Database(':memory:');
    try {
      // Simulate a database created before m003 existed.
      runMigrations(db, MIGRATIONS.filter((m) => m.id <= 2));
      for (const type of OLD_TYPES) insertRow(db, `pre-${type}`, type);

      runMigrations(db, MIGRATIONS);

      const rows = db
        .prepare('SELECT id, type, session_id, turn_id, ts, payload FROM telemetry_events ORDER BY id;')
        .all() as { id: string; type: string; session_id: string; ts: number }[];
      expect(rows.map((r) => r.type).sort()).toEqual([...OLD_TYPES].sort());
      expect(rows.every((r) => r.session_id === 's1' && r.ts === 100)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('recreates all three indexes the rebuild drops', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, MIGRATIONS);
      const names = (
        db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND tbl_name = 'telemetry_events' AND name NOT LIKE 'sqlite_%'
             ORDER BY name;`,
          )
          .all() as { name: string }[]
      ).map((r) => r.name);
      expect(names).toEqual([
        'idx_telemetry_events_session',
        'idx_telemetry_events_turn',
        'idx_telemetry_events_type',
      ]);
    } finally {
      db.close();
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
