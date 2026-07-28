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
INSERT INTO telemetry_events_new (id, type, session_id, turn_id, ts, payload)
  SELECT id, type, session_id, turn_id, ts, payload FROM telemetry_events;
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
