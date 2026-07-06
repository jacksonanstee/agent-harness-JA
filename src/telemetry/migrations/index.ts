import type { Migration } from './runner.js';
import { m001MemoryBaseline } from './m001-memory-baseline.js';
import { m002TelemetryEvents } from './m002-telemetry-events.js';

export { runMigrations, type Migration } from './runner.js';

/** Static registry — append new migrations here; ids contiguous from 1. */
export const MIGRATIONS: readonly Migration[] = [m001MemoryBaseline, m002TelemetryEvents];
