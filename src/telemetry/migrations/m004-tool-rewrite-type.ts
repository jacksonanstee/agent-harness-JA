import type { Migration } from './runner.js';

/**
 * Widens telemetry_events.type to admit 'tool-rewrite' (issue #84; ADR-0011
 * amendment, ADR-0035). SQLite cannot ALTER a CHECK constraint, so this is the
 * standard table rebuild, byte-for-byte the m003 shape with one more literal in
 * the CHECK. It runs inside the runner's per-migration transaction (runner.ts),
 * and SQLite DDL is transactional, so a failure mid-rebuild rolls back rather
 * than leaving a half-renamed table.
 *
 * The three indexes are recreated because DROP TABLE takes its indexes with it.
 * rowid is copied EXPLICITLY for the reason m003 documents at length: a plain
 * INSERT…SELECT assigns fresh rowids and silently renumbers retained rows
 * across a ship-once migration, breaking buildQuery's `ts, rowid` tiebreak.
 *
 * Drift guards: ddl-drift.test.ts pins this rebuild against m003 (byte-diff,
 * only the widened CHECK may differ) and m004.test.ts pins row/rowid
 * preservation with a seeded rowid gap, mirroring m003.test.ts.
 */
export const M004_DDL = `
CREATE TABLE telemetry_events_new (
  id         TEXT PRIMARY KEY NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('turn-cost','tool-trace','hook-event','skill-drop','tool-rewrite')),
  session_id TEXT NOT NULL,
  turn_id    TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}'
);
-- rowid copied EXPLICITLY (see m003's comment): each row keeps its original
-- rowid regardless of scan order, so the ts,rowid tiebreak stays stable across
-- this irreversible migration of retained operator data.
INSERT INTO telemetry_events_new (rowid, id, type, session_id, turn_id, ts, payload)
  SELECT rowid, id, type, session_id, turn_id, ts, payload FROM telemetry_events ORDER BY rowid;
DROP TABLE telemetry_events;
ALTER TABLE telemetry_events_new RENAME TO telemetry_events;
CREATE INDEX IF NOT EXISTS idx_telemetry_events_session ON telemetry_events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_turn    ON telemetry_events(turn_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_type    ON telemetry_events(type, ts);
`;

export const m004ToolRewriteType: Migration = {
  id: 4,
  name: 'tool-rewrite-type',
  up(db) {
    db.exec(M004_DDL);
  },
};
