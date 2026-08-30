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
 * What `delete` accepts: exactly the fields it matches rows on.
 *
 * `read`'s remaining fields shape a result set rather than select rows
 * (`limit`, `order`) or narrow it on a clock (`includeStale`), and `delete`
 * has never applied any of them. Accepting them meant deleting rows the very
 * same filter would not have returned: `{ type, limit: 0 }` read nothing and
 * deleted everything of that type. They are refused now: at compile time by
 * this type, and at runtime by the store, since a JavaScript caller or an
 * `as` cast gets past a type alone.
 */
export type MemoryDeleteFilter = Pick<MemoryFilter, 'type' | 'key' | 'tag'>;

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
