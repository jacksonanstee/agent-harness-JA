import type { Migration } from './runner.js';

/**
 * Memory's DDL adopted verbatim as the baseline migration (ADR-0009 §5
 * Revisit-if). Byte-identical to MEMORY_BASELINE_DDL in src/memory/store.ts —
 * enforced by the drift test in ddl-drift.test.ts. Both paths are
 * IF NOT EXISTS-idempotent, so a DB created by memory's construction-time
 * ensureSchema adopts cleanly: this no-ops, then records.
 */
export const M001_DDL = `
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
`;

export const m001MemoryBaseline: Migration = {
  id: 1,
  name: 'memory-baseline',
  up(db) {
    db.exec(M001_DDL);
  },
};
