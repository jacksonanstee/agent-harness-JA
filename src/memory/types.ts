export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  key: string | null;
  content: string;
  tags: string[];
  /** epoch ms */
  createdAt: number;
  /** epoch ms */
  updatedAt: number;
  /** epoch ms; entry is stale once Date.now() > staleAfter. null = never stale. */
  staleAfter: number | null;
}

/**
 * What callers pass to `write`. The store fills `id`/`createdAt`/`updatedAt`.
 * Supplying an existing `id` turns `write` into an update (upsert).
 *
 * `write` has **full-replace (PUT) semantics**, not partial-merge: on update,
 * every field is taken from this input. Omitting `key`/`tags`/`staleAfter`
 * resets them to their defaults (`null`/`[]`/`null`) — it does NOT preserve the
 * prior values. Only `createdAt` survives an update. To edit one field, read
 * the entry first and write it back whole.
 */
export interface MemoryInput {
  type: MemoryType;
  content: string;
  id?: string;
  key?: string | null;
  tags?: string[];
  staleAfter?: number | null;
}

export interface MemoryFilter {
  type?: MemoryType;
  key?: string;
  /** Matches entries whose `tags` array includes this value. */
  tag?: string;
  /** Default true; false excludes entries where `now > staleAfter`. */
  includeStale?: boolean;
  /** Non-negative integer cap on the number of rows returned. */
  limit?: number;
  /** Order by `createdAt`; default 'desc'. */
  order?: 'asc' | 'desc';
}

/**
 * What `delete` accepts: the three fields it matches rows on, and an explicit
 * refusal of the three it does not.
 *
 * `read` applies `limit`, `order` and `includeStale`; `delete` never has, so
 * accepting one meant deleting rows the same filter's `read` would not have
 * returned: `{ type, limit: 0 }` read nothing and deleted every row of that
 * type.
 *
 * The three refusals are typed `never` rather than simply omitted, because
 * omitting them does not stop the caller this exists for. Every field here is
 * optional, so a plain `Pick` leaves `MemoryFilter` structurally assignable:
 * excess-property checking fires on a fresh object literal at the call site
 * and nowhere else, so `const f: MemoryFilter = { type, limit: 0 };
 * store.delete(f)` would compile clean. That is exactly the preview-then-delete
 * caller. `never` makes the assignment a compile error instead.
 *
 * The runtime guard in the store is still load-bearing, and not only for
 * JavaScript callers and `as` casts: a type cannot see a field that arrives on
 * the prototype chain or behind a Proxy.
 */
export type MemoryDeleteFilter = Pick<MemoryFilter, 'type' | 'key' | 'tag'> & {
  includeStale?: never;
  limit?: never;
  order?: never;
};

export type MemoryErrorKind = 'constraint' | 'db';

export interface MemoryError {
  kind: MemoryErrorKind;
  message: string;
}

export type WriteResult =
  | { ok: true; value: MemoryEntry }
  | { ok: false; error: MemoryError };

export type DeleteResult =
  | { ok: true; value: { deleted: number } }
  | { ok: false; error: MemoryError };

export interface MemoryStore {
  write(entry: MemoryInput): WriteResult;
  read(filter?: MemoryFilter): MemoryEntry[];
  delete(filter: MemoryDeleteFilter): DeleteResult;
}
