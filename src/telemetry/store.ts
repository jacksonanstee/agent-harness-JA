import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

import { MIGRATIONS, runMigrations } from './migrations/index.js';
import type {
  HookEventPayload,
  RecordResult,
  TelemetryError,
  TelemetryEvent,
  TelemetryEventInput,
  TelemetryEventType,
  TelemetryFilter,
  TelemetryStore,
  ToolTracePayload,
  TurnCostPayload,
  TurnUsage,
} from './types.js';
import { sanitizeControlChars as sanitizeText } from '../internal/sanitize.js';

export const TELEMETRY_EVENT_TYPES = ['turn-cost', 'tool-trace', 'hook-event'] as const satisfies readonly TelemetryEventType[];
export const DEFAULT_DB_PATH = './.harness/telemetry.db';

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(TELEMETRY_EVENT_TYPES);
const HOOK_EVENT_KINDS: ReadonlySet<string> = new Set(['denied-by-hook', 'hook-error', 'hook-fired']);


const INSERT_SQL = `
INSERT INTO telemetry_events (id, type, session_id, turn_id, ts, payload)
VALUES (@id, @type, @sessionId, @turnId, @ts, @payload);
`;

interface OpenTelemetryDatabaseOptions {
  path?: string;
}

/**
 * Opens (creating if needed) the shared harness DB and brings its schema up to
 * date via the migration runner. Caller owns the connection lifecycle.
 */
export function openTelemetryDatabase(opts: OpenTelemetryDatabaseOptions = {}): Database.Database {
  const path = opts.path ?? DEFAULT_DB_PATH;
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db, MIGRATIONS);
  return db;
}

interface EventRow {
  id: string;
  type: string;
  session_id: string;
  turn_id: string;
  ts: number;
  payload: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isTurnUsage(value: unknown): value is TurnUsage {
  return (
    isObject(value) &&
    typeof value.inputTokens === 'number' &&
    typeof value.outputTokens === 'number' &&
    isFiniteOrNull(value.cacheCreationInputTokens) &&
    isFiniteOrNull(value.cacheReadInputTokens)
  );
}

function isTurnCostPayload(value: unknown): value is TurnCostPayload {
  return (
    isObject(value) &&
    typeof value.model === 'string' &&
    typeof value.ruleId === 'string' &&
    isFiniteOrNull(value.costUsd) &&
    isFiniteOrNull(value.numTurns) &&
    (value.usage === null || isTurnUsage(value.usage)) &&
    isStringOrNull(value.sdkSessionId) &&
    isStringOrNull(value.resultSubtype)
  );
}

function isToolTracePayload(value: unknown): value is ToolTracePayload {
  return (
    isObject(value) &&
    typeof value.tool === 'string' &&
    value.phase === 'post-tool' &&
    typeof value.ok === 'boolean' &&
    isStringOrNull(value.resultSummary)
  );
}

function isHookEventPayload(value: unknown): value is HookEventPayload {
  return (
    isObject(value) &&
    typeof value.kind === 'string' &&
    HOOK_EVENT_KINDS.has(value.kind) &&
    typeof value.event === 'string' &&
    (value.tool === undefined || typeof value.tool === 'string') &&
    (value.reason === undefined || typeof value.reason === 'string') &&
    (value.handlerIndex === undefined || typeof value.handlerIndex === 'number') &&
    (value.handlersFired === undefined || typeof value.handlersFired === 'number')
  );
}

function isPayloadForType(type: TelemetryEventType, payload: unknown): boolean {
  if (type === 'turn-cost') return isTurnCostPayload(payload);
  if (type === 'tool-trace') return isToolTracePayload(payload);
  return isHookEventPayload(payload);
}

/**
 * Sanitizes the attacker-influenceable string fields of a validated payload.
 * Returns a new object (immutability: callers' inputs are never mutated).
 */
function sanitizePayload(event: TelemetryEventInput): TelemetryEventInput['payload'] {
  if (event.type === 'turn-cost') {
    const p = event.payload;
    return {
      ...p,
      model: sanitizeText(p.model),
      ruleId: sanitizeText(p.ruleId),
      sdkSessionId: p.sdkSessionId === null ? null : sanitizeText(p.sdkSessionId),
      resultSubtype: p.resultSubtype === null ? null : sanitizeText(p.resultSubtype),
    };
  }
  if (event.type === 'tool-trace') {
    const p = event.payload;
    return {
      ...p,
      tool: sanitizeText(p.tool),
      resultSummary: p.resultSummary === null ? null : sanitizeText(p.resultSummary),
    };
  }
  const p = event.payload;
  return {
    ...p,
    event: sanitizeText(p.event),
    ...(p.tool !== undefined ? { tool: sanitizeText(p.tool) } : {}),
    ...(p.reason !== undefined ? { reason: sanitizeText(p.reason) } : {}),
  };
}

function assertValidInput(event: TelemetryEventInput): void {
  if (typeof event !== 'object' || event === null) {
    throw new TypeError(`event must be an object, got ${String(event)}`);
  }
  if (!EVENT_TYPE_SET.has(event.type)) {
    throw new TypeError(
      `event.type must be one of ${TELEMETRY_EVENT_TYPES.join('|')}, got ${String(event.type)}`,
    );
  }
  if (typeof event.sessionId !== 'string' || event.sessionId === '') {
    throw new TypeError(`event.sessionId must be a non-empty string, got ${String(event.sessionId)}`);
  }
  if (typeof event.turnId !== 'string' || event.turnId === '') {
    throw new TypeError(`event.turnId must be a non-empty string, got ${String(event.turnId)}`);
  }
  if (event.ts !== undefined && (!Number.isFinite(event.ts) || event.ts < 0)) {
    throw new TypeError(`event.ts must be a non-negative finite number when provided, got ${String(event.ts)}`);
  }
  if (!isPayloadForType(event.type, event.payload)) {
    throw new TypeError(`event.payload is not a valid ${event.type} payload`);
  }
}

function assertValidFilter(filter: TelemetryFilter): void {
  if (typeof filter !== 'object' || filter === null) {
    throw new TypeError(`filter must be an object, got ${String(filter)}`);
  }
  if (filter.type !== undefined && !EVENT_TYPE_SET.has(filter.type)) {
    throw new TypeError(
      `filter.type must be one of ${TELEMETRY_EVENT_TYPES.join('|')}, got ${String(filter.type)}`,
    );
  }
  if (filter.sessionId !== undefined && typeof filter.sessionId !== 'string') {
    throw new TypeError(`filter.sessionId must be a string when provided, got ${String(filter.sessionId)}`);
  }
  if (filter.turnId !== undefined && typeof filter.turnId !== 'string') {
    throw new TypeError(`filter.turnId must be a string when provided, got ${String(filter.turnId)}`);
  }
  if (filter.since !== undefined && !Number.isFinite(filter.since)) {
    throw new TypeError(`filter.since must be a finite number when provided, got ${String(filter.since)}`);
  }
  if (filter.until !== undefined && !Number.isFinite(filter.until)) {
    throw new TypeError(`filter.until must be a finite number when provided, got ${String(filter.until)}`);
  }
  if (filter.limit !== undefined && (!Number.isInteger(filter.limit) || filter.limit < 0)) {
    throw new TypeError(`filter.limit must be a non-negative integer, got ${String(filter.limit)}`);
  }
  if (filter.order !== undefined && filter.order !== 'asc' && filter.order !== 'desc') {
    throw new TypeError(`filter.order must be 'asc' or 'desc', got ${String(filter.order)}`);
  }
}

function rowToEvent(row: unknown): TelemetryEvent {
  const r = row as EventRow;
  // Total structural validation (memory rowToEntry precedent — never trust a
  // shared DB file blindly): a relaxed migration or another writer could
  // produce a malformed row; fail loud rather than emit a mistyped event.
  if (
    typeof r.id !== 'string' ||
    !EVENT_TYPE_SET.has(r.type) ||
    typeof r.session_id !== 'string' ||
    typeof r.turn_id !== 'string' ||
    typeof r.ts !== 'number' ||
    typeof r.payload !== 'string'
  ) {
    throw new Error('telemetry_events row failed structural validation');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(r.payload);
  } catch {
    throw new Error('telemetry_events row failed structural validation: payload is not JSON');
  }
  const type = r.type as TelemetryEventType;
  if (!isPayloadForType(type, payload)) {
    throw new Error(`telemetry_events row failed structural validation: payload mismatches type '${type}'`);
  }
  return {
    id: r.id,
    type,
    sessionId: r.session_id,
    turnId: r.turn_id,
    ts: r.ts,
    payload,
  } as TelemetryEvent;
}

function telemetryError(cause: unknown): TelemetryError {
  const code = isObject(cause) && typeof cause.code === 'string' ? cause.code : '';
  const kind: TelemetryError['kind'] = code.startsWith('SQLITE_CONSTRAINT') ? 'constraint' : 'db';
  const message = cause instanceof Error ? cause.message : String(cause);
  return { kind, message };
}

function buildQuery(filter: TelemetryFilter): { sql: string; params: Record<string, unknown> } {
  const clauses: string[] = ['1 = 1'];
  const params: Record<string, unknown> = {};
  if (filter.sessionId !== undefined) {
    clauses.push('session_id = @sessionId');
    params.sessionId = filter.sessionId;
  }
  if (filter.turnId !== undefined) {
    clauses.push('turn_id = @turnId');
    params.turnId = filter.turnId;
  }
  if (filter.type !== undefined) {
    clauses.push('type = @type');
    params.type = filter.type;
  }
  if (filter.since !== undefined) {
    clauses.push('ts >= @since');
    params.since = filter.since;
  }
  if (filter.until !== undefined) {
    clauses.push('ts < @until');
    params.until = filter.until;
  }
  // Default asc: telemetry reads are trace reconstructions, oldest first.
  // rowid tiebreak gives same-ms events a total, deterministic order.
  const direction = filter.order === 'desc' ? 'DESC' : 'ASC';
  let sql = `SELECT * FROM telemetry_events WHERE ${clauses.join(' AND ')} ORDER BY ts ${direction}, rowid ${direction}`;
  if (filter.limit !== undefined) {
    sql += ' LIMIT @limit';
    params.limit = filter.limit;
  }
  return { sql: `${sql};`, params };
}

/**
 * Telemetry store over an injected better-sqlite3 connection (ADR-0011;
 * substrate per ADR-0004). Runs migrations on construction so an arbitrary
 * injected connection is self-sufficient, mirroring memory's ensureSchema
 * contract. Caller owns the connection lifecycle.
 */
export function createTelemetryStore(db: Database.Database): TelemetryStore {
  runMigrations(db, MIGRATIONS);
  const insert = db.prepare(INSERT_SQL);
  const selectById = db.prepare('SELECT * FROM telemetry_events WHERE id = @id;');

  function record(event: TelemetryEventInput): RecordResult {
    assertValidInput(event);
    const row = {
      id: crypto.randomUUID(),
      type: event.type,
      sessionId: event.sessionId,
      turnId: event.turnId,
      ts: event.ts ?? Date.now(),
      payload: JSON.stringify(sanitizePayload(event)),
    };
    try {
      insert.run(row);
      const stored = selectById.get({ id: row.id });
      return { ok: true, value: rowToEvent(stored) };
    } catch (cause: unknown) {
      return { ok: false, error: telemetryError(cause) };
    }
  }

  function query(filter: TelemetryFilter = {}): TelemetryEvent[] {
    assertValidFilter(filter);
    const built = buildQuery(filter);
    return db.prepare(built.sql).all(built.params).map(rowToEvent);
  }

  return { record, query };
}
