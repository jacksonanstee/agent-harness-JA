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

export type MemoryErrorKind = 'write' | 'constraint' | 'db';

export interface MemoryError {
  kind: MemoryErrorKind;
  field?: string;
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
  delete(filter: MemoryFilter): DeleteResult;
}
