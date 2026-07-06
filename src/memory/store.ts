import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type {
  DeleteResult,
  MemoryEntry,
  MemoryError,
  MemoryFilter,
  MemoryInput,
  MemoryStore,
  MemoryType,
  WriteResult,
} from './types.js';

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const satisfies readonly MemoryType[];
export const DEFAULT_DB_PATH = './.harness/telemetry.db';

const MEMORY_TYPE_SET: ReadonlySet<string> = new Set(MEMORY_TYPES);

const CREATE_TABLE = `
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

const UPSERT_SQL = `
INSERT INTO memory_entries (id, type, key, content, tags, created_at, updated_at, stale_after)
VALUES (@id, @type, @key, @content, @tags, @createdAt, @updatedAt, @staleAfter)
ON CONFLICT(id) DO UPDATE SET
  type = excluded.type,
  key = excluded.key,
  content = excluded.content,
  tags = excluded.tags,
  updated_at = excluded.updated_at,
  stale_after = excluded.stale_after;
`;

const SELECT_BY_ID = `SELECT * FROM memory_entries WHERE id = @id;`;

interface OpenMemoryDatabaseOptions {
  path?: string;
}

export function ensureSchema(db: Database.Database): void {
  db.exec(CREATE_TABLE);
}

export function openMemoryDatabase(opts: OpenMemoryDatabaseOptions = {}): Database.Database {
  const path = opts.path ?? DEFAULT_DB_PATH;
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  return db;
}

interface EntryRow {
  id: string;
  type: string;
  key: string | null;
  content: string;
  tags: string;
  created_at: number;
  updated_at: number;
  stale_after: number | null;
}

function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((t) => typeof t === 'string')) {
      return parsed;
    }
    return [];
  } catch {
    return [];
  }
}

function rowToEntry(row: unknown): MemoryEntry {
  const r = row as EntryRow;
  // Total structural validation (ADR-0009 §7 — never trust the DB blindly). The
  // schema's NOT NULL/CHECK constraints make most of this unreachable today, but
  // a shared DB file (telemetry, later) or a relaxed migration could produce a
  // malformed row; fail loud rather than emit a mistyped MemoryEntry.
  if (
    typeof r.id !== 'string' ||
    typeof r.content !== 'string' ||
    !MEMORY_TYPE_SET.has(r.type) ||
    (r.key !== null && typeof r.key !== 'string') ||
    typeof r.created_at !== 'number' ||
    typeof r.updated_at !== 'number' ||
    (r.stale_after !== null && typeof r.stale_after !== 'number')
  ) {
    throw new Error('memory_entries row failed structural validation');
  }
  return {
    id: r.id,
    type: r.type as MemoryType,
    key: r.key,
    content: r.content,
    tags: parseTags(r.tags),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    staleAfter: r.stale_after,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertValidInput(entry: MemoryInput): void {
  if (typeof entry !== 'object' || entry === null) {
    throw new TypeError(`entry must be an object, got ${String(entry)}`);
  }
  if (!MEMORY_TYPE_SET.has(entry.type)) {
    throw new TypeError(`entry.type must be one of ${MEMORY_TYPES.join('|')}, got ${String(entry.type)}`);
  }
  if (typeof entry.content !== 'string') {
    throw new TypeError(`entry.content must be a string, got ${String(entry.content)}`);
  }
  if (entry.id !== undefined && typeof entry.id !== 'string') {
    throw new TypeError(`entry.id must be a string when provided, got ${String(entry.id)}`);
  }
  if (entry.key !== undefined && entry.key !== null && typeof entry.key !== 'string') {
    throw new TypeError(`entry.key must be a string or null when provided, got ${String(entry.key)}`);
  }
  if (entry.tags !== undefined && (!Array.isArray(entry.tags) || !entry.tags.every((t) => typeof t === 'string'))) {
    throw new TypeError('entry.tags must be a string[] when provided');
  }
  if (
    entry.staleAfter !== undefined &&
    entry.staleAfter !== null &&
    (!Number.isFinite(entry.staleAfter) || entry.staleAfter < 0)
  ) {
    throw new TypeError(`entry.staleAfter must be a non-negative finite number or null, got ${String(entry.staleAfter)}`);
  }
}

function assertValidFilter(filter: MemoryFilter, requireNonEmpty: boolean): void {
  if (typeof filter !== 'object' || filter === null) {
    throw new TypeError(`filter must be an object, got ${String(filter)}`);
  }
  if (filter.type !== undefined && !MEMORY_TYPE_SET.has(filter.type)) {
    throw new TypeError(`filter.type must be one of ${MEMORY_TYPES.join('|')}, got ${String(filter.type)}`);
  }
  if (filter.key !== undefined && typeof filter.key !== 'string') {
    throw new TypeError(`filter.key must be a string when provided, got ${String(filter.key)}`);
  }
  if (filter.tag !== undefined && typeof filter.tag !== 'string') {
    throw new TypeError(`filter.tag must be a string when provided, got ${String(filter.tag)}`);
  }
  if (filter.limit !== undefined && (!Number.isInteger(filter.limit) || filter.limit < 0)) {
    throw new TypeError(`filter.limit must be a non-negative integer, got ${String(filter.limit)}`);
  }
  if (filter.order !== undefined && filter.order !== 'asc' && filter.order !== 'desc') {
    throw new TypeError(`filter.order must be 'asc' or 'desc', got ${String(filter.order)}`);
  }
  if (requireNonEmpty && filter.type === undefined && filter.key === undefined && filter.tag === undefined) {
    throw new TypeError('delete requires a non-empty filter (type, key, or tag) to avoid wiping the table');
  }
}

function memoryError(cause: unknown): MemoryError {
  const code = isObject(cause) && typeof cause.code === 'string' ? cause.code : '';
  const kind: MemoryError['kind'] = code.startsWith('SQLITE_CONSTRAINT') ? 'constraint' : 'db';
  const message = cause instanceof Error ? cause.message : String(cause);
  return { kind, message };
}

interface ReadQuery {
  sql: string;
  params: Record<string, unknown>;
  postFilterTag?: string;
  /** Applied in JS after the tag post-filter; undefined when SQL already limited. */
  postFilterLimit?: number;
}

function buildReadQuery(filter: MemoryFilter): ReadQuery {
  const clauses: string[] = ['1 = 1'];
  const params: Record<string, unknown> = {};
  if (filter.type !== undefined) {
    clauses.push('type = @type');
    params.type = filter.type;
  }
  if (filter.key !== undefined) {
    clauses.push('key = @key');
    params.key = filter.key;
  }
  if (filter.includeStale === false) {
    clauses.push('(stale_after IS NULL OR stale_after > @now)');
    params.now = Date.now();
  }
  const direction = filter.order === 'asc' ? 'ASC' : 'DESC';
  // rowid (insertion order) is the tiebreaker so same-ms writes get a total,
  // deterministic order and asc is the exact reverse of desc.
  let sql = `SELECT * FROM memory_entries WHERE ${clauses.join(' AND ')} ORDER BY created_at ${direction}, rowid ${direction}`;
  // When a tag post-filter runs in JS, LIMIT must be applied AFTER it — pushing
  // LIMIT into SQL here would cap the rows before the tag filter and under-return.
  const tagPostFilter = filter.tag !== undefined;
  if (filter.limit !== undefined && !tagPostFilter) {
    sql += ' LIMIT @limit';
    params.limit = filter.limit;
  }
  return {
    sql: `${sql};`,
    params,
    postFilterTag: filter.tag,
    postFilterLimit: tagPostFilter ? filter.limit : undefined,
  };
}

export function createMemoryStore(db: Database.Database): MemoryStore {
  ensureSchema(db);
  const upsert = db.prepare(UPSERT_SQL);
  const selectById = db.prepare(SELECT_BY_ID);

  function write(entry: MemoryInput): WriteResult {
    assertValidInput(entry);
    const now = Date.now();
    const id = entry.id ?? crypto.randomUUID();
    const existing = entry.id !== undefined ? (selectById.get({ id }) as EntryRow | undefined) : undefined;
    const createdAt = existing ? existing.created_at : now;
    const row = {
      id,
      type: entry.type,
      key: entry.key ?? null,
      content: entry.content,
      tags: JSON.stringify(entry.tags ?? []),
      createdAt,
      updatedAt: now,
      staleAfter: entry.staleAfter ?? null,
    };
    try {
      upsert.run(row);
      const stored = selectById.get({ id });
      return { ok: true, value: rowToEntry(stored) };
    } catch (cause: unknown) {
      return { ok: false, error: memoryError(cause) };
    }
  }

  function read(filter: MemoryFilter = {}): MemoryEntry[] {
    assertValidFilter(filter, false);
    const query = buildReadQuery(filter);
    const rows = db.prepare(query.sql).all(query.params);
    let entries = rows.map(rowToEntry);
    if (query.postFilterTag !== undefined) {
      const tag = query.postFilterTag;
      entries = entries.filter((e) => e.tags.includes(tag));
      if (query.postFilterLimit !== undefined) {
        entries = entries.slice(0, query.postFilterLimit);
      }
    }
    return entries;
  }

  function del(filter: MemoryFilter): DeleteResult {
    assertValidFilter(filter, true);
    const clauses: string[] = ['1 = 1'];
    const params: Record<string, unknown> = {};
    if (filter.type !== undefined) {
      clauses.push('type = @type');
      params.type = filter.type;
    }
    if (filter.key !== undefined) {
      clauses.push('key = @key');
      params.key = filter.key;
    }
    try {
      const info = db.prepare(`DELETE FROM memory_entries WHERE ${clauses.join(' AND ')};`).run(params);
      return { ok: true, value: { deleted: info.changes } };
    } catch (cause: unknown) {
      return { ok: false, error: memoryError(cause) };
    }
  }

  return { write, read, delete: del };
}
