import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MEMORY_BASELINE_DDL } from '../../memory/store.js';
import { TELEMETRY_EVENT_TYPES } from '../store.js';
import { M001_DDL } from './m001-memory-baseline.js';
import { MIGRATIONS, runMigrations } from './index.js';

// Dual-ownership drift guards (ADR-0011 §3, review finding F3/F5): these
// constants are hand-copied pairs; each test re-derives the invariant so
// divergence fails loudly instead of silently forking the effective schema.

describe('dual-owned schema constants', () => {
  it('migration 001 is byte-identical to memory ensureSchema DDL', () => {
    expect(M001_DDL).toBe(MEMORY_BASELINE_DDL);
  });

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
});
