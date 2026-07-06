import type { Migration } from './runner.js';

/**
 * Single-table event log (ADR-0011): discriminator + promoted indexed columns
 * + JSON payload. Append-heavy, single-writer (ADR-0004).
 */
export const m002TelemetryEvents: Migration = {
  id: 2,
  name: 'telemetry-events',
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS telemetry_events (
  id         TEXT PRIMARY KEY NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('turn-cost','tool-trace','hook-event')),
  session_id TEXT NOT NULL,
  turn_id    TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_session ON telemetry_events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_turn    ON telemetry_events(turn_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_type    ON telemetry_events(type, ts);
`);
  },
};
