import type { Migration } from './runner.js';

/**
 * Widens telemetry_events.type to admit 'skill-drop' (issue #46; ADR-0011
 * amendment). SQLite cannot ALTER a CHECK constraint, so this is the standard
 * table rebuild. It runs inside the runner's per-migration transaction
 * (runner.ts), and SQLite DDL is transactional, so a failure mid-rebuild rolls
 * back rather than leaving a half-renamed table.
 *
 * The three indexes are recreated because DROP TABLE takes its indexes with it.
 */
export const M003_DDL = `
CREATE TABLE telemetry_events_new (
  id         TEXT PRIMARY KEY NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('turn-cost','tool-trace','hook-event','skill-drop')),
  session_id TEXT NOT NULL,
  turn_id    TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}'
);
-- rowid is copied EXPLICITLY. telemetry_events is a rowid table (its TEXT PK
-- is a separate index), and buildQuery orders by \`ts, rowid\` so
-- same-millisecond events have a stable total order. A plain INSERT…SELECT
-- assigns FRESH rowids, which silently renumbers rows across an irreversible,
-- ship-once migration of retained operator data. Naming rowid in both lists is
-- the whole fix: each row then carries its own original rowid regardless of
-- scan order.
--
-- The ORDER BY is deliberately NOT load-bearing — it is belt-and-braces for
-- deterministic insert order, and it is a no-op cost here because rowid order
-- IS the table's natural scan order. Do not copy this into a future migration
-- believing the two mechanisms are jointly required; the explicit rowid copy
-- alone is what preserves the values.
INSERT INTO telemetry_events_new (rowid, id, type, session_id, turn_id, ts, payload)
  SELECT rowid, id, type, session_id, turn_id, ts, payload FROM telemetry_events ORDER BY rowid;
DROP TABLE telemetry_events;
ALTER TABLE telemetry_events_new RENAME TO telemetry_events;
CREATE INDEX IF NOT EXISTS idx_telemetry_events_session ON telemetry_events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_turn    ON telemetry_events(turn_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_type    ON telemetry_events(type, ts);
`;

export const m003SkillDropType: Migration = {
  id: 3,
  name: 'skill-drop-type',
  up(db) {
    db.exec(M003_DDL);
  },
};
