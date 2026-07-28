import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

import { MIGRATIONS, runMigrations } from './migrations/index.js';
import type {
  HookEventPayload,
  RecordResult,
  SkillDropPayload,
  SkillDropReason,
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
import {
  SKILL_DROP_CHANNEL_MAX,
  SKILL_DROP_CHANNELS_MAX,
  SKILL_DROP_NAME_MAX,
  SKILL_DROP_PATH_MAX,
  SKILL_DROP_RULE_ID_MAX,
  SKILL_DROP_RULE_IDS_MAX,
} from './types.js';
import {
  sanitizeControlChars as sanitizeText,
  truncateTailWellFormed,
  truncateWellFormed,
} from '../internal/sanitize.js';

/**
 * Exhaustive BY CONSTRUCTION. The previous
 * `as const satisfies readonly TelemetryEventType[]` checked MEMBERSHIP only:
 * widening TelemetryEventType and forgetting this array compiled clean, and
 * then EVENT_TYPE_SET rejected every write of the new type at
 * assertValidInput — which recordTelemetry downgrades to a warning, so the
 * feature would be silently dead. A missing key here is now a compile error.
 */
const EVENT_TYPE_PRESENCE: Record<TelemetryEventType, true> = {
  'turn-cost': true,
  'tool-trace': true,
  'hook-event': true,
  'skill-drop': true,
};

export const TELEMETRY_EVENT_TYPES = Object.keys(EVENT_TYPE_PRESENCE) as readonly TelemetryEventType[];
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

/** Absent is allowed (older rows); present-but-wrong-typed is not. */
function isOptionalStringOrNull(value: unknown): value is string | null | undefined {
  return value === undefined || isStringOrNull(value);
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isTurnUsage(value: unknown): value is TurnUsage {
  return (
    isObject(value) &&
    typeof value.inputTokens === 'number' &&
    Number.isFinite(value.inputTokens) &&
    typeof value.outputTokens === 'number' &&
    Number.isFinite(value.outputTokens) &&
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
    isStringOrNull(value.resultSubtype) &&
    // Optional so rows written before ADR-0025 still validate on read; a
    // PRESENT field of the wrong type is still a hard failure.
    isOptionalStringOrNull(value.stopReason) &&
    isOptionalStringOrNull(value.refusalSource) &&
    isOptionalStringOrNull(value.refusalCategory) &&
    isOptionalStringOrNull(value.refusalFallbackModel)
  );
}

function isToolTracePayload(value: unknown): value is ToolTracePayload {
  return (
    isObject(value) &&
    typeof value.tool === 'string' &&
    value.phase === 'post-tool' &&
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

/**
 * Exhaustive BY CONSTRUCTION, same shape as EVENT_TYPE_PRESENCE above and for
 * the same reason: a hand-copied `Set(['injection-block', 'prompt-budget'])`
 * is a MEMBERSHIP check, not a completeness check. This is the exact bug this
 * task fixed for TELEMETRY_EVENT_TYPES, one file down — a set built from a
 * literal list compiles clean when SkillDropReason grows a third member and
 * nobody updates the literal, and the new reason is silently dead-lettered by
 * assertValidInput. A missing key here is now a compile error.
 */
const SKILL_DROP_REASON_PRESENCE: Record<SkillDropReason, true> = {
  'injection-block': true,
  'prompt-budget': true,
};

const SKILL_DROP_REASONS: ReadonlySet<string> = new Set(Object.keys(SKILL_DROP_REASON_PRESENCE));

/**
 * First array-bearing payload in this store: elements are validated, not just
 * the container, because a direct writer need not have gone through session.ts.
 *
 * Indexed loop, NOT `.every`: `Array.prototype.every` (and `.map`, in
 * sanitizePayload's skill-drop branch) SKIP holes — they walk HasProperty, not
 * indices — so a sparse array (e.g. `ruleIds[2] = 'x'` with no index 0 or 1
 * set) passes this check and passes the `.map` in sanitizePayload unchanged.
 * `JSON.stringify` does NOT skip holes: it materialises each one as `null`.
 * That row then INSERTs successfully, and only fails re-validation on the
 * read-back inside record() (rowToEvent's structural check), by which point
 * the write already happened — see the transaction wrapping the insert and
 * read-back in createTelemetryStore. Reading `value[i]` on a hole returns
 * `undefined`, which fails `typeof item !== 'string'` here, so this indexed
 * loop rejects the sparse array BEFORE either the write or the `.map`.
 */
function isBoundedStringArray(value: unknown, maxItems: number, maxLen: number): value is string[] {
  if (!Array.isArray(value) || value.length > maxItems) return false;
  for (let i = 0; i < value.length; i += 1) {
    const item: unknown = value[i];
    if (typeof item !== 'string' || item.length > maxLen) return false;
  }
  return true;
}

/**
 * Bakes the CAP-1 truncator arithmetic (see types.ts's SKILL_DROP_*_MAX doc
 * comment) into one place so no caller re-derives it. Task 5's capture site
 * needs this arithmetic in two independent spots — the truncation call and
 * the separate `pathTruncated` derivation, since neither truncator reports
 * whether it fired — and a hand-copied `CAP - 1` in each is a silent-inversion
 * risk: get the sign wrong and every oversized attacker-controlled path (the
 * rows most worth having) fails isSkillDropPayload and vanishes as a warning.
 */
export function boundSkillDropPath(path: string): { value: string; truncated: boolean } {
  const truncated = path.length > SKILL_DROP_PATH_MAX - 1;
  return { value: truncateTailWellFormed(path, SKILL_DROP_PATH_MAX - 1), truncated };
}

/**
 * `name` has no truncated-flag counterpart (see SkillDropPayload.pathTruncated's
 * doc comment for why `path` needs one and `name` deliberately doesn't).
 */
export function boundSkillDropName(name: string): string {
  return truncateWellFormed(name, SKILL_DROP_NAME_MAX - 1);
}

function isSkillDropPayload(value: unknown): value is SkillDropPayload {
  return (
    isObject(value) &&
    typeof value.name === 'string' &&
    value.name.length <= SKILL_DROP_NAME_MAX &&
    typeof value.path === 'string' &&
    value.path.length <= SKILL_DROP_PATH_MAX &&
    typeof value.pathTruncated === 'boolean' &&
    typeof value.reason === 'string' &&
    SKILL_DROP_REASONS.has(value.reason) &&
    isBoundedStringArray(value.channels, SKILL_DROP_CHANNELS_MAX, SKILL_DROP_CHANNEL_MAX) &&
    isBoundedStringArray(value.ruleIds, SKILL_DROP_RULE_IDS_MAX, SKILL_DROP_RULE_ID_MAX)
  );
}

function isPayloadForType(type: TelemetryEventType, payload: unknown): boolean {
  switch (type) {
    case 'turn-cost':
      return isTurnCostPayload(payload);
    case 'tool-trace':
      return isToolTracePayload(payload);
    case 'hook-event':
      return isHookEventPayload(payload);
    case 'skill-drop':
      return isSkillDropPayload(payload);
    default: {
      // `payload` is unknown here, so the old unguarded fall-through gave NO
      // compile-time protection: a fifth type would have been validated
      // against the hook-event shape. Exhaustiveness is on the DISCRIMINANT,
      // which does type-check — a new type without a case fails to compile.
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

/**
 * Preserves absence: an omitted optional field stays omitted once serialized
 * (JSON.stringify drops undefined), so an old-shape write stays old-shape.
 */
function sanitizeOptional(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  return sanitizeText(value);
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
      // Sanitized again here rather than trusting the caller: this store is a
      // public factory, so a direct writer need not have gone through session.ts.
      stopReason: sanitizeOptional(p.stopReason),
      refusalSource: sanitizeOptional(p.refusalSource),
      refusalCategory: sanitizeOptional(p.refusalCategory),
      refusalFallbackModel: sanitizeOptional(p.refusalFallbackModel),
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
  if (event.type === 'skill-drop') {
    const p = event.payload;
    // sanitizeText is a 1:1 space substitution, so lengths are preserved and
    // the caps validated above still hold after sanitization.
    return {
      ...p,
      name: sanitizeText(p.name),
      path: sanitizeText(p.path),
      channels: p.channels.map(sanitizeText),
      ruleIds: p.ruleIds.map(sanitizeText),
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

  /**
   * Insert and read-back as ONE transaction, defined once and reused (per
   * better-sqlite3's guidance) rather than wrapped fresh on every call.
   *
   * rowToEvent's read-back re-validation can throw on a row that passed
   * isPayloadForType in memory but serializes differently — the sparse-array
   * case above is the one this task found and closed pre-write, but that fix
   * is per-field; this closes the CLASS for every field, present and future.
   * Before this wrapped the two statements, that throw happened AFTER
   * insert.run had already committed (better-sqlite3 auto-commits a bare
   * statement outside an explicit transaction), so record() returned
   * `ok: false` while the bad row stayed in the table — and recordTelemetry
   * downgrades `ok: false` to one stderr warning, so the corrupted row (and,
   * via store.query()'s unconditional rowToEvent map, every OTHER row too,
   * since one throwing row fails the whole query) went undetected until an
   * operator ran `telemetry export` weeks later. Wrapping means `ok: false`
   * now always means "nothing was written."
   */
  const insertAndReadBack = db.transaction(
    (row: {
      id: string;
      type: TelemetryEventInput['type'];
      sessionId: string;
      turnId: string;
      ts: number;
      payload: string;
    }): TelemetryEvent => {
      insert.run(row);
      const stored = selectById.get({ id: row.id });
      return rowToEvent(stored);
    },
  );

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
      const value = insertAndReadBack(row);
      return { ok: true, value };
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
