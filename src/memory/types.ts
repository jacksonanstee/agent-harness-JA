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
 * What `delete` accepts: the four fields it matches rows on (`type`, `key`,
 * `tag` and `ids`), and an explicit refusal of the three `MemoryFilter` fields
 * it does not.
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
 * The refusals are derived from `MemoryFilter` by a mapped type rather than
 * listed, so a field added to `MemoryFilter` later is refused here without
 * anyone remembering to add it. The store's runtime list is pinned to
 * `keyof MemoryFilter` the same way.
 *
 * The refusal is on defined values: an own key whose value is `undefined` is
 * absent, as `read` treats it (#118), so `{ ...readFilter, limit: undefined }`
 * compiles and deletes what `read` returns.
 *
 * The runtime guard in the store is still load-bearing, and not only for
 * JavaScript callers and `as` casts: a type cannot see a field that arrives on
 * the prototype chain or behind a Proxy.
 */
export type MemoryDeleteMatchField = 'type' | 'key' | 'tag' | 'ids';

/**
 * `ids` (#116) is delete-only: `read` has no id filter, and a smuggled `ids` on
 * a read filter is ignored there. It selects rows by `id`, AND-combined with
 * any `type`, `key` and `tag` given: an id whose row does not match the other
 * fields is not deleted. `DeleteResult.value.deleted` counts rows actually
 * removed, so duplicate and unknown ids add nothing.
 *
 * Rules, all enforced by the store at runtime:
 * - every element must be a non-empty string;
 * - at most `MEMORY_DELETE_IDS_MAX` elements: an over-cap list is refused, never
 *   truncated, because truncating would silently delete a subset;
 * - `ids: []` is a matcher that matches nothing: it deletes nothing and returns
 *   `{ deleted: 0 }`, alone or combined (it is not "no filter", so it does not
 *   reach the empty-filter refusal);
 * - an `ids` whose value is `undefined` is absent, as for every other field.
 *
 * A `tag` or `ids` delete selects and removes in one transaction. If another
 * connection changes a selected row in between (under WAL), the delete returns
 * `{ ok: false, error: { kind: 'db' } }` and removes nothing; that failure is
 * transient and retrying is safe.
 *
 * `{ type, limit, order }` ("delete the N oldest") stays refused (ADR-0009).
 */
export type MemoryDeleteFilter = Pick<MemoryFilter, Extract<MemoryDeleteMatchField, keyof MemoryFilter>> & {
  ids?: readonly string[];
} & {
  [K in Exclude<keyof MemoryFilter, MemoryDeleteMatchField>]?: never;
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
