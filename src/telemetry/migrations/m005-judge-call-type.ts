import type { Migration } from './runner.js';

/**
 * Widens telemetry_events.type to admit 'judge-call' (issue #96 PR-B1, spec
 * D6; ADR-0011 amendment, ADR-0037). The m004 rebuild byte-for-byte with one
 * more literal in the CHECK: SQLite cannot ALTER a CHECK constraint. Runs in
 * the runner's per-migration transaction (runner.ts); SQLite DDL is
 * transactional, so a failure mid-rebuild rolls back.
 *
 * rowid is copied EXPLICITLY (m003's comment explains why); the three indexes
 * are recreated because DROP TABLE takes them with it. Drift guards:
 * ddl-drift.test.ts pins this rebuild against m004 (only the CHECK may
 * differ); m005.test.ts pins row and rowid preservation with a seeded gap.
 */
export const M005_DDL = `
CREATE TABLE telemetry_events_new (
  id         TEXT PRIMARY KEY NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('turn-cost','tool-trace','hook-event','skill-drop','tool-rewrite','judge-call')),
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

export const m005JudgeCallType: Migration = {
  id: 5,
  name: 'judge-call-type',
  up(db) {
    db.exec(M005_DDL);
  },
};
