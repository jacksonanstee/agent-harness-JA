import type Database from 'better-sqlite3';

/**
 * One numbered schema migration. Migrations live as .ts modules statically
 * registered in `migrations/index.ts` (ADR-0011) — no filesystem discovery,
 * so the runner behaves identically under vitest and from compiled dist/.
 */
export interface Migration {
  /** Positive integer; registry ids must be contiguous from 1. */
  id: number;
  name: string;
  up(db: Database.Database): void;
}

/** Bookkeeping table owned by the runner itself, not by any migration. */
const ENSURE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         INTEGER PRIMARY KEY NOT NULL,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`;

interface AppliedRow {
  id: number;
  name: string;
}

function validateRegistry(migrations: readonly Migration[]): Migration[] {
  const sorted = [...migrations].sort((a, b) => a.id - b.id);
  let expected = 1;
  for (const migration of sorted) {
    if (!Number.isInteger(migration.id) || migration.id < 1) {
      throw new Error(`migration id must be a positive integer, got ${String(migration.id)}`);
    }
    if (migration.id < expected) {
      throw new Error(`duplicate migration id ${migration.id}`);
    }
    if (migration.id > expected) {
      throw new Error(
        `gap in migration ids: expected ${expected}, got ${migration.id} (ids must be contiguous from 1)`,
      );
    }
    expected += 1;
  }
  return sorted;
}

/**
 * Applies pending migrations in ascending id order. Each migration and its
 * `schema_migrations` row commit in one transaction, so a throwing migration
 * leaves no partial DDL/DML behind. Idempotent: applied ids are skipped after
 * verifying the recorded name still matches the registry.
 */
export function runMigrations(
  db: Database.Database,
  migrations: readonly Migration[],
): { applied: number[] } {
  const sorted = validateRegistry(migrations);
  db.exec(ENSURE_MIGRATIONS_TABLE);

  const recorded = new Map<number, string>();
  const rows = db.prepare('SELECT id, name FROM schema_migrations ORDER BY id;').all() as AppliedRow[];
  for (const row of rows) {
    recorded.set(row.id, row.name);
  }

  const registryIds = new Set(sorted.map((m) => m.id));
  for (const [id] of recorded) {
    if (!registryIds.has(id)) {
      throw new Error(`recorded migration ${id} is not in the registry; refusing to run`);
    }
  }

  const insert = db.prepare(
    'INSERT INTO schema_migrations (id, name, applied_at) VALUES (@id, @name, @appliedAt);',
  );
  const applied: number[] = [];
  for (const migration of sorted) {
    const recordedName = recorded.get(migration.id);
    if (recordedName !== undefined) {
      if (recordedName !== migration.name) {
        throw new Error(
          `migration ${migration.id} name mismatch: recorded '${recordedName}', registry '${migration.name}'`,
        );
      }
      continue;
    }
    db.transaction(() => {
      migration.up(db);
      insert.run({ id: migration.id, name: migration.name, appliedAt: Date.now() });
    })();
    applied.push(migration.id);
  }
  return { applied };
}
