import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryStore, openMemoryDatabase } from './index.js';
import type { MemoryFilter, MemoryInput, MemoryStore, MemoryType } from './index.js';

let openDbs: BetterSqlite3.Database[] = [];

function freshStore(): { store: MemoryStore; db: BetterSqlite3.Database } {
  const db = openMemoryDatabase({ path: ':memory:' });
  openDbs.push(db);
  return { store: createMemoryStore(db), db };
}

function writeOk(store: MemoryStore, entry: MemoryInput) {
  const result = store.write(entry);
  if (!result.ok) throw new Error(`expected write ok, got ${result.error.message}`);
  return result.value;
}

afterEach(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      /* already closed by a test */
    }
  }
  openDbs = [];
});

describe('memory: write/read round-trip per type', () => {
  const types: MemoryType[] = ['user', 'feedback', 'project', 'reference'];
  for (const type of types) {
    it(`round-trips a ${type} entry`, () => {
      const { store } = freshStore();
      const written = writeOk(store, { type, content: `a ${type} memory` });
      expect(written.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(written.type).toBe(type);
      expect(written.key).toBeNull();
      expect(written.tags).toEqual([]);
      expect(written.staleAfter).toBeNull();
      expect(written.createdAt).toBe(written.updatedAt);

      const read = store.read({ type });
      expect(read).toHaveLength(1);
      expect(read[0]).toEqual(written);
    });
  }
});

describe('memory: retrieval-by-type', () => {
  it('returns only entries of the requested type', () => {
    const { store } = freshStore();
    writeOk(store, { type: 'user', content: 'u1' });
    writeOk(store, { type: 'user', content: 'u2' });
    writeOk(store, { type: 'project', content: 'p1' });

    expect(store.read({ type: 'user' }).map((e) => e.content).sort()).toEqual(['u1', 'u2']);
    expect(store.read({ type: 'project' }).map((e) => e.content)).toEqual(['p1']);
    expect(store.read({ type: 'reference' })).toEqual([]);
  });

  it('empty filter returns all entries, newest first', () => {
    const { store } = freshStore();
    const a = writeOk(store, { type: 'user', content: 'a' });
    const b = writeOk(store, { type: 'feedback', content: 'b' });
    const all = store.read();
    expect(all).toHaveLength(2);
    // createdAt desc; if equal ms, both present regardless of order.
    expect(all.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('read on an empty table returns []', () => {
    const { store } = freshStore();
    expect(store.read()).toEqual([]);
  });
});

describe('memory: filters', () => {
  it('key exact match', () => {
    const { store } = freshStore();
    writeOk(store, { type: 'user', content: 'x', key: 'tone' });
    writeOk(store, { type: 'user', content: 'y', key: 'other' });
    expect(store.read({ key: 'tone' }).map((e) => e.content)).toEqual(['x']);
  });

  it('tag includes-match', () => {
    const { store } = freshStore();
    writeOk(store, { type: 'user', content: 'x', tags: ['a', 'b'] });
    writeOk(store, { type: 'user', content: 'y', tags: ['c'] });
    expect(store.read({ tag: 'b' }).map((e) => e.content)).toEqual(['x']);
  });

  it('limit caps the row count', () => {
    const { store } = freshStore();
    for (let i = 0; i < 5; i++) writeOk(store, { type: 'user', content: `c${i}` });
    expect(store.read({ limit: 2 })).toHaveLength(2);
  });

  it('order asc reverses the default', () => {
    const { store } = freshStore();
    writeOk(store, { type: 'user', content: 'first', staleAfter: null });
    writeOk(store, { type: 'user', content: 'second' });
    const asc = store.read({ order: 'asc' });
    const desc = store.read({ order: 'desc' });
    expect(asc.map((e) => e.id)).toEqual([...desc].reverse().map((e) => e.id));
  });

  it('combined type + key', () => {
    const { store } = freshStore();
    writeOk(store, { type: 'user', content: 'x', key: 'k' });
    writeOk(store, { type: 'project', content: 'y', key: 'k' });
    expect(store.read({ type: 'user', key: 'k' }).map((e) => e.content)).toEqual(['x']);
  });
});

describe('memory: upsert / update', () => {
  it('writing with an existing id updates in place, preserving createdAt', () => {
    const { store } = freshStore();
    const first = writeOk(store, { type: 'user', content: 'v1' });
    const second = writeOk(store, { id: first.id, type: 'user', content: 'v2' });

    expect(second.id).toBe(first.id);
    expect(second.content).toBe('v2');
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.createdAt);
    expect(store.read()).toHaveLength(1);
    expect(store.read()[0]?.content).toBe('v2');
  });
});

describe('memory: staleness', () => {
  it('round-trips staleAfter and filters on includeStale', () => {
    const { store } = freshStore();
    const past = writeOk(store, { type: 'user', content: 'old', staleAfter: 1 });
    const future = writeOk(store, {
      type: 'user',
      content: 'fresh',
      staleAfter: Number.MAX_SAFE_INTEGER,
    });
    expect(past.staleAfter).toBe(1);
    expect(future.staleAfter).toBe(Number.MAX_SAFE_INTEGER);

    expect(store.read().map((e) => e.content).sort()).toEqual(['fresh', 'old']);
    expect(store.read({ includeStale: false }).map((e) => e.content)).toEqual(['fresh']);
  });
});

describe('memory: tagged results on failure', () => {
  it('write to a closed db returns {ok:false, kind:db} without throwing', () => {
    const { store, db } = freshStore();
    db.close();
    const result = store.write({ type: 'user', content: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('db');
    expect(result.error.message.length).toBeGreaterThan(0);
  });

  it('delete on a closed db returns {ok:false}', () => {
    const { store, db } = freshStore();
    db.close();
    const result = store.delete({ type: 'user' });
    expect(result.ok).toBe(false);
  });
});

describe('memory: delete', () => {
  it('deletes matching rows and reports the count', () => {
    const { store } = freshStore();
    writeOk(store, { type: 'user', content: 'a' });
    writeOk(store, { type: 'user', content: 'b' });
    writeOk(store, { type: 'project', content: 'c' });
    const result = store.delete({ type: 'user' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.deleted).toBe(2);
    expect(store.read({ type: 'user' })).toEqual([]);
    expect(store.read({ type: 'project' })).toHaveLength(1);
  });

  it('deletes by key', () => {
    const { store } = freshStore();
    writeOk(store, { type: 'user', content: 'a', key: 'k1' });
    writeOk(store, { type: 'user', content: 'b', key: 'k2' });
    const result = store.delete({ key: 'k1' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.deleted).toBe(1);
    expect(store.read().map((e) => e.content)).toEqual(['b']);
  });

  it('empty-filter delete throws TypeError (table-wipe guard)', () => {
    const { store } = freshStore();
    expect(() => store.delete({})).toThrow(TypeError);
  });
});

describe('memory: programmer errors throw TypeError', () => {
  it('rejects a non-object entry', () => {
    const { store } = freshStore();
    expect(() => store.write(null as unknown as MemoryInput)).toThrow(TypeError);
  });

  it('rejects non-string content', () => {
    const { store } = freshStore();
    expect(() => store.write({ type: 'user', content: 42 as unknown as string })).toThrow(TypeError);
  });

  it('rejects an unknown type', () => {
    const { store } = freshStore();
    expect(() =>
      store.write({ type: 'bogus' as unknown as MemoryType, content: 'x' }),
    ).toThrow(TypeError);
  });

  it('rejects non-array tags', () => {
    const { store } = freshStore();
    expect(() =>
      store.write({ type: 'user', content: 'x', tags: 'a' as unknown as string[] }),
    ).toThrow(TypeError);
  });

  it('rejects a negative limit', () => {
    const { store } = freshStore();
    expect(() => store.read({ limit: -1 })).toThrow(TypeError);
  });

  it('rejects a non-object filter', () => {
    const { store } = freshStore();
    expect(() => store.read(42 as unknown as MemoryFilter)).toThrow(TypeError);
  });

  it('rejects a non-string id', () => {
    const { store } = freshStore();
    expect(() =>
      store.write({ id: 7 as unknown as string, type: 'user', content: 'x' }),
    ).toThrow(TypeError);
  });

  it('rejects a negative staleAfter', () => {
    const { store } = freshStore();
    expect(() => store.write({ type: 'user', content: 'x', staleAfter: -5 })).toThrow(TypeError);
  });

  it('rejects an invalid order', () => {
    const { store } = freshStore();
    expect(() =>
      store.read({ order: 'sideways' as unknown as 'asc' }),
    ).toThrow(TypeError);
  });
});

describe('memory: robustness', () => {
  it('rowToEntry degrades malformed tags JSON to []', () => {
    const { store, db } = freshStore();
    db.prepare(
      `INSERT INTO memory_entries (id, type, key, content, tags, created_at, updated_at, stale_after)
       VALUES (?, 'user', NULL, 'x', ?, 1, 1, NULL)`,
    ).run('11111111-1111-1111-1111-111111111111', 'not json{');
    const rows = store.read();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tags).toEqual([]);
  });

  it('constructing the store twice on one db does not throw (idempotent schema)', () => {
    const { db } = freshStore();
    expect(() => createMemoryStore(db)).not.toThrow();
  });

  it('the store does not close the injected db', () => {
    const { store, db } = freshStore();
    writeOk(store, { type: 'user', content: 'x' });
    const second = createMemoryStore(db);
    expect(second.read()).toHaveLength(1);
  });

  it('persists to a real file across separate connections (creates parent dir)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-persist-'));
    const path = join(dir, 'nested', 'telemetry.db'); // nested dir must be created
    try {
      const db1 = openMemoryDatabase({ path });
      const written = writeOk(createMemoryStore(db1), { type: 'project', content: 'durable' });
      db1.close();

      // A fresh connection to the same file sees the persisted entry.
      const db2 = openMemoryDatabase({ path });
      const read = createMemoryStore(db2).read({ type: 'project' });
      db2.close();

      expect(read).toHaveLength(1);
      expect(read[0]?.id).toBe(written.id);
      expect(read[0]?.content).toBe('durable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
