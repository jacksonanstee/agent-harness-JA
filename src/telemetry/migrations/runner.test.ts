import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { runMigrations, type Migration } from './runner.js';
import { MIGRATIONS } from './index.js';

function openDb(): Database.Database {
  return new Database(':memory:');
}

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;`)
      .all() as { name: string }[]
  ).map((r) => r.name);
}

let dbs: Database.Database[] = [];
function track(db: Database.Database): Database.Database {
  dbs.push(db);
  return db;
}
afterEach(() => {
  for (const db of dbs) db.close();
  dbs = [];
});

describe('runMigrations', () => {
  it('applies the real registry to a fresh DB and records rows', () => {
    const db = track(openDb());
    const result = runMigrations(db, MIGRATIONS);
    expect(result.applied).toEqual(MIGRATIONS.map((m) => m.id));
    expect(tableNames(db)).toEqual(
      expect.arrayContaining(['memory_entries', 'schema_migrations', 'telemetry_events']),
    );
    const rows = db
      .prepare('SELECT id, name FROM schema_migrations ORDER BY id;')
      .all() as { id: number; name: string }[];
    expect(rows).toEqual(MIGRATIONS.map((m) => ({ id: m.id, name: m.name })));
  });

  it('is idempotent — second run applies nothing', () => {
    const db = track(openDb());
    runMigrations(db, MIGRATIONS);
    const second = runMigrations(db, MIGRATIONS);
    expect(second.applied).toEqual([]);
  });

  it('adopts an existing memory-only DB: 001 no-ops but is recorded', () => {
    const db = track(openDb());
    // Simulate a DB created by memory's construction-time ensureSchema.
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        id          TEXT PRIMARY KEY NOT NULL,
        type        TEXT NOT NULL CHECK (type IN ('user','feedback','project','reference')),
        key         TEXT,
        content     TEXT NOT NULL,
        tags        TEXT NOT NULL DEFAULT '[]',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        stale_after INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_memory_entries_type ON memory_entries(type);
    `);
    db.prepare(
      `INSERT INTO memory_entries (id, type, content, created_at, updated_at)
       VALUES ('e1', 'project', 'keep me', 1, 1);`,
    ).run();
    const result = runMigrations(db, MIGRATIONS);
    expect(result.applied).toEqual(MIGRATIONS.map((m) => m.id));
    const kept = db.prepare(`SELECT content FROM memory_entries WHERE id = 'e1';`).get() as {
      content: string;
    };
    expect(kept.content).toBe('keep me');
  });

  it('applies migrations in ascending id order regardless of registry order', () => {
    const db = track(openDb());
    const order: number[] = [];
    const migrations: Migration[] = [
      { id: 2, name: 'two', up: () => order.push(2) },
      { id: 1, name: 'one', up: () => order.push(1) },
    ];
    runMigrations(db, migrations);
    expect(order).toEqual([1, 2]);
  });

  it('rolls back a failing migration atomically (no partial DDL, no bookkeeping row)', () => {
    const db = track(openDb());
    const bad: Migration[] = [
      {
        id: 1,
        name: 'bad',
        up: (d) => {
          d.exec('CREATE TABLE half_done (id TEXT);');
          throw new Error('boom');
        },
      },
    ];
    expect(() => runMigrations(db, bad)).toThrow('boom');
    expect(tableNames(db)).not.toContain('half_done');
    const rows = db.prepare('SELECT id FROM schema_migrations;').all();
    expect(rows).toEqual([]);
  });

  it('stops at the failing migration but keeps earlier applied ones', () => {
    const db = track(openDb());
    const migrations: Migration[] = [
      { id: 1, name: 'ok', up: (d) => d.exec('CREATE TABLE ok_table (id TEXT);') },
      {
        id: 2,
        name: 'bad',
        up: () => {
          throw new Error('boom');
        },
      },
    ];
    expect(() => runMigrations(db, migrations)).toThrow('boom');
    expect(tableNames(db)).toContain('ok_table');
    const rows = db.prepare('SELECT id FROM schema_migrations;').all() as { id: number }[];
    expect(rows).toEqual([{ id: 1 }]);
  });

  it('rejects duplicate migration ids', () => {
    const db = track(openDb());
    const migrations: Migration[] = [
      { id: 1, name: 'a', up: () => undefined },
      { id: 1, name: 'b', up: () => undefined },
    ];
    expect(() => runMigrations(db, migrations)).toThrow(/duplicate/i);
  });

  it('rejects gaps in migration ids', () => {
    const db = track(openDb());
    const migrations: Migration[] = [
      { id: 1, name: 'a', up: () => undefined },
      { id: 3, name: 'c', up: () => undefined },
    ];
    expect(() => runMigrations(db, migrations)).toThrow(/gap|contiguous/i);
  });

  it('rejects non-positive-integer ids', () => {
    const db = track(openDb());
    expect(() => runMigrations(db, [{ id: 0, name: 'z', up: () => undefined }])).toThrow(
      /positive integer/i,
    );
  });

  it('throws when a recorded migration is missing from the registry', () => {
    const db = track(openDb());
    runMigrations(db, [{ id: 1, name: 'one', up: () => undefined }]);
    expect(() => runMigrations(db, [])).toThrow(/recorded .* not in the registry/i);
  });

  it('throws when a recorded migration name mismatches the registry', () => {
    const db = track(openDb());
    runMigrations(db, [{ id: 1, name: 'one', up: () => undefined }]);
    expect(() =>
      runMigrations(db, [{ id: 1, name: 'renamed', up: () => undefined }]),
    ).toThrow(/name mismatch/i);
  });

  it('the real registry ids are contiguous from 1', () => {
    expect(MIGRATIONS.map((m) => m.id)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });
});
