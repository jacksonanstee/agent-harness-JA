# ADR-0009: Memory store — injected SQLite connection, typed upsert/query

- **Status:** Accepted
- **Date:** 2026-07-05
- **Deciders:** Jackson Anstee
- **Related requirements:** [H-5](../../process/01-requirements.md), N-1, N-3
- **Related:** [architecture.md §harness/memory](../architecture.md), [ADR-0004](./0004-sqlite-for-telemetry.md) (substrate), [ADR-0008](./0008-hook-runtime-observe-accept-deny.md) (injected-seam precedent)

## Context

`harness/memory` owns typed memory entries with persistence and retrieval. architecture.md locks its public surface:

> - **Public API:** `write(entry: MemoryEntry)`, `read(filter: MemoryFilter): MemoryEntry[]`.
> - **Depends on:** `harness/telemetry`'s SQLite connection (shared DB, separate tables).
> - **Design notes:** Type-tagged for retrieval-by-type. Optional decay/staleness fields.

Entry types are locked: `user | feedback | project | reference`.

Two timing/scoping facts shape this ADR:

1. **Telemetry is unbuilt (Week 2), memory ships Week 1.** The locked dependency is telemetry's *SQLite connection*, not its module surface. Importing the unbuilt telemetry module would couple memory to a non-existent API and a migration runner that does not yet exist. This is the same dependency-timing seam hooks solved in ADR-0008 with an injected sink. Resolve it identically: **memory takes an injected `better-sqlite3` connection**; it never imports telemetry. Memory owns only its own table on the shared DB file.
2. **ADR-0004 is telemetry-scoped.** It commits the *substrate* (`better-sqlite3`, synchronous API, default DB `./.harness/telemetry.db`, native-dep tradeoff accepted) but its title, context, and related-requirements are telemetry-only and do not list H-5. This ADR reuses ADR-0004's substrate and owns the memory-specific schema, API refinements, and connection seam.

The Week-1 checkpoint requires "at least one memory entry persisted" in a real run, so memory must actually write to SQLite — not a stub. Acceptance (H-5): "CRUD test suite + retrieval-by-type test", coverage ≥70%.

`better-sqlite3` was smoke-tested and loads with a working prebuilt binary on this project's Node 25 toolchain, so the native-dep path from ADR-0004 holds; no fallback to `node:sqlite` was needed.

## Decision

### 1. Injected connection; memory owns only its table

`createMemoryStore(db)` takes an already-open `better-sqlite3` connection. Memory never imports telemetry. On the shared DB file, memory owns exactly the `memory_entries` table (+ its index). This mirrors ADR-0008's injected `HookSink`: the dependency points the correct way and memory ships before telemetry.

A standalone helper `openMemoryDatabase({ path? })` opens a connection for CLI/test/H-1 use before telemetry exists (see §5).

### 2. `MemoryEntry`, `MemoryInput`, `MemoryFilter`, `MemoryType`

The stored/returned entry is fully populated; callers create with a lighter input so the store owns identity and clocks (like a DB does), keeping id/timestamp concerns off every caller. This refines — does not contradict — the locked `write(entry: MemoryEntry)`: the method name and purpose are honoured; `MemoryInput` is `MemoryEntry` minus store-generated fields.

```ts
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryEntry {
  id: string;                // store-generated crypto.randomUUID()
  type: MemoryType;
  key: string | null;        // optional retrieval handle (e.g. 'preferred-tone')
  content: string;           // the memory payload
  tags: string[];            // JSON-encoded in SQLite
  createdAt: number;         // epoch ms
  updatedAt: number;         // epoch ms
  staleAfter: number | null; // epoch ms; entry is stale once Date.now() > staleAfter
}

// What callers pass to write(). Store fills id/createdAt/updatedAt.
// Providing an existing id turns write() into an update (upsert, §3).
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
  tag?: string;              // matches entries whose tags[] includes tag
  includeStale?: boolean;    // default true; false excludes now > staleAfter
  limit?: number;            // non-negative integer
  order?: 'asc' | 'desc';    // by createdAt; default 'desc'
}
```

**Decay/staleness (minimal but real):** one field, `staleAfter` (epoch ms). Derived staleness is `staleAfter !== null && Date.now() > staleAfter`. A half-life/decay-score model is deferred (Revisit if) — `staleAfter` covers retrieval-time filtering, which is what H-5 needs.

**id = `crypto.randomUUID()`** (Node ≥20 global). Chosen over autoincrement rowid because a stable, caller-addressable id makes upsert-by-id and cross-DB portability trivial and decouples identity from insertion order. `key` is *not* unique — multiple entries may share or omit it; identity is `id` alone.

### 3. CRUD reconciled with the locked 2-method surface

- **`write` is an upsert keyed on `id`** — create *and* update through the one locked method. No `id` (or an unseen `id`) ⇒ INSERT with a generated id; a known `id` ⇒ UPDATE. Satisfies C and U. **Update has full-replace (PUT), not partial-merge, semantics:** every field is taken from the input; omitting `key`/`tags`/`staleAfter` resets them to their defaults rather than preserving the prior row. Only `createdAt` survives an update (`updatedAt` is bumped). Full-replace is chosen over partial-merge because it is predictable (the written entry *is* the stored entry) and because merge makes clearing a field impossible without a sentinel. Callers editing one field read-then-write the whole entry.
- **`read` is the query** (R).
- **`delete(filter): DeleteResult` is added as an explicit superset** for D, mirroring the router's `Unsubscribe` return and hooks' `FireResult` extras — additions beyond the architecture's headline, justified by the acceptance criterion literally naming "CRUD". A tombstone-via-write alternative was rejected: it pollutes every `read` with filtering and complicates the mapper. `delete` is bounded — an empty filter throws `TypeError` to prevent an accidental table wipe.

### 4. Return shapes: `write`/`delete` tagged, `read` bare

```ts
export type MemoryErrorKind = 'constraint' | 'db';
export interface MemoryError { kind: MemoryErrorKind; message: string; }

export type WriteResult  = { ok: true; value: MemoryEntry }        | { ok: false; error: MemoryError };
export type DeleteResult = { ok: true; value: { deleted: number } } | { ok: false; error: MemoryError };

export interface MemoryStore {
  write(entry: MemoryInput): WriteResult;
  read(filter?: MemoryFilter): MemoryEntry[];   // bare — see below
  delete(filter: MemoryFilter): DeleteResult;
}
```

`write`/`delete` are tagged: they have real recoverable failure modes a caller branches on — a disk-full/IO error (`kind:'db'`) or a constraint violation (`kind:'constraint'`, e.g. the CHECK in §6 as defense-in-depth). `MemoryError` mirrors skills' `SkillError` (`kind`/`field`/`message`).

`read` stays **bare `MemoryEntry[]`**, as architecture.md locked it. A query over our own table with a validated filter and an open connection is effectively total: the only failures are programmer errors (bad filter shape/type ⇒ throw `TypeError`, router `assertValid` precedent) or a catastrophic IO/closed-connection fault, which is a genuinely exceptional condition, not a domain outcome the caller branches on. Forcing every reader to unwrap `{ok}` for a query that never fails domain-wise is worse ergonomics and contradicts the locked signature. So `read` throws on the rare exceptional fault and never returns a tagged error. This is the deliberate asymmetry the cross-cutting rule anticipates: writes carry recoverable error state, pure queries do not.

Programmer errors that throw `TypeError`: non-object entry/filter, `content` not a string, `type` not one of the four, `tags` not `string[]`, `staleAfter`/`limit` non-finite or negative, empty-filter `delete`.

### 5. Schema ownership: idempotent DDL on construction; `openMemoryDatabase` helper

Telemetry's numbered-migration runner is unbuilt. The pragmatic Week-1 answer: memory **ensures its own table via idempotent `CREATE TABLE IF NOT EXISTS` on construction**. `createMemoryStore(db)` calls `ensureSchema(db)`, so a store built on any injected connection is self-sufficient; repeated calls are harmless. When telemetry's migration runner lands, it adopts memory's DDL as a numbered migration (Revisit if).

`openMemoryDatabase({ path? })` opens a handle for standalone/CLI/test/H-1 use: default path `./.harness/telemetry.db` (shared with telemetry; `.harness/` and `*.db` already gitignored), applies `journal_mode = WAL` (a no-op for `:memory:`) and `foreign_keys = ON`, creates the parent dir if needed, and calls `ensureSchema`. Callers own the returned handle's lifecycle (§8).

### 6. SQLite schema, JSON-encoded arrays, parameterized SQL

SQLite has no native boolean/date/array types: epoch-ms `INTEGER` for times, JSON `TEXT` for `tags`.

```sql
CREATE TABLE IF NOT EXISTS memory_entries (
  id          TEXT PRIMARY KEY NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('user','feedback','project','reference')),
  key         TEXT,
  content     TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  created_at  INTEGER NOT NULL,             -- epoch ms
  updated_at  INTEGER NOT NULL,             -- epoch ms
  stale_after INTEGER                        -- epoch ms, nullable
);
CREATE INDEX IF NOT EXISTS idx_memory_entries_type ON memory_entries(type);
```

All SQL uses **bound parameters — never string interpolation of entry content** (SQL-injection guard). `ORDER BY` direction comes from a validated `'asc'|'desc'` enum (a closed set — safe, not raw interpolation). `tag` filtering happens in JS after mapping (keeps the query total and avoids a JSON1 dependency assumption; `tag` is secondary to the locked retrieval-by-type). `created_at` is intentionally preserved across updates.

### 7. Row mapping under `noUncheckedIndexedAccess`

`.all()` returns rows typed `unknown`; a total `rowToEntry(row)` narrows every column and never trusts the DB blindly. `.get()` returns `T | undefined`, so callers guard undefined; `.all()` is iterated with `for…of`. The `tags` JSON parse is wrapped: a malformed value degrades to `[]` rather than throwing mid-query. A structurally impossible row (e.g. `content` not a string) throws a data-integrity `Error` — loud, not silent.

### 8. Connection lifecycle: caller owns close

`createMemoryStore` does **not** close the injected `db` — the caller (H-1, telemetry later, or the test) that opened it owns its lifecycle. `openMemoryDatabase` returns a handle the caller must `close()`.

### 9. CONTROL_CHARS: memory is NOT the fourth consumer

Memory uses parameterized SQL (no content interpolated into SQL) and **does not echo untrusted entry content into error/log messages** — `MemoryError.message` is either a static/templated string or a library-generated `better-sqlite3` error message (which names the constraint/column, not arbitrary row content). Because memory neither interpolates content into SQL nor writes attacker-influenced strings to a log-adjacent surface, it is not the fourth `CONTROL_CHARS` consumer, and the ADR-0008 extraction to `src/internal/` stays deferred (tightest scope). If a future change embeds a failing `key`/`content` into `MemoryError.message`, memory becomes the fourth consumer and triggers the extraction (Revisit if).

### 10. Factory-only; no module-level default instance

Unlike router (stateless over a table) and hooks (cheap in-memory registry, so a default instance is safe), memory's per-instance state is an **external resource with a lifecycle** (an open DB handle). A module-level default would have to lazily open `./.harness/telemetry.db` as an import-time filesystem side effect — surprising, untestable, and there is no sensible process-global DB before H-1 wires one. So memory is **factory-only**: `createMemoryStore(db)` and `openMemoryDatabase()`, no bare `write`/`read`. This deviation from the router/hooks default-instance precedent is itself a decision recorded here.

## Consequences

### Positive
- Ships Week 1 without telemetry; the injected connection keeps the dependency pointing the correct way (ADR-0008 parity).
- Real SQLite persistence satisfies the Week-1 checkpoint ("≥1 memory entry persisted").
- Upsert-by-id folds create+update into the locked `write`; `read` keeps its locked bare signature; `delete` is a small, justified superset.
- All SQL parameterized; type validated in JS *and* by a CHECK (defense-in-depth).
- Factory-only avoids an import-time filesystem side effect and keeps tests hermetic (`:memory:`).

### Negative / accepted
- `MemoryInput` refines the literal `write(entry: MemoryEntry)` — a documented, faithful narrowing, not the exact locked type.
- `delete` and `MemoryInput` exceed the 2-method headline (accepted superset).
- `tags` as JSON TEXT means tag filtering is a JS post-filter, not an index — fine at v1.0 scale, not for large stores.
- No FTS / no per-type table partitioning; a single indexed table. Adequate for a solo developer's local store.
- Memory and telemetry sharing one DB file means a schema/lifecycle coordination point when telemetry's migration runner lands.

## Alternatives considered

1. **Import telemetry's connection/module directly.** Rejected — couples to an unbuilt API + migration runner; the injected connection (ADR-0008 parity) ships now and coordinates later.
2. **Autoincrement rowid as id.** Rejected — couples identity to insertion order, complicates upsert and portability; `crypto.randomUUID()` is stable and caller-addressable.
3. **`read` returns a tagged `ReadResult`.** Rejected — contradicts the locked bare signature and burdens every caller for a query that fails only on programmer error or catastrophic IO (which throws).
4. **Delete via tombstone written through `write`.** Rejected — pollutes every `read` with tombstone filtering and complicates the mapper; a bounded `delete(filter)` is cleaner.
5. **Module-level default store (router/hooks style).** Rejected — would open a DB file at import time; no sensible process-global DB exists pre-H-1. Factory-only.
6. **A full migration runner now.** Rejected for Week 1 — idempotent `CREATE TABLE IF NOT EXISTS` is sufficient; telemetry brings the runner and adopts this DDL.
7. **`node:sqlite` (built-in) instead of `better-sqlite3`.** Held as a fallback in case the native binary failed on Node 25; the prebuilt binary loaded cleanly, so we stay on ADR-0004's `better-sqlite3` substrate. Revisit only if the native dep becomes an install burden.

## Revisit if

- Telemetry's numbered-migration runner lands — migrate memory's DDL into it and drop construction-time `ensureSchema` (or make it a registered migration).
  - **Status 2026-07-06 (ADR-0011):** runner landed; memory's DDL adopted verbatim as migration 001. `ensureSchema` deliberately **retained** — `createMemoryStore(db)` on an arbitrary injected connection stays self-sufficient; both paths are idempotent. Keep the DDL byte-identical in both sites.
- A real decay/eviction policy is needed (half-life scoring, TTL sweeps) beyond retrieval-time `staleAfter` filtering.
- Store size makes tag/text search slow — add FTS5 or a `tags` join table / JSON1 index.
- A `MemoryError.message` starts embedding untrusted `key`/`content` — memory becomes the 4th `CONTROL_CHARS` consumer; extract to `src/internal/`.
- Concurrent multi-process writers appear — inherits ADR-0004's single-writer `SQLITE_BUSY` caveat.
- Upsert-by-`key` (not just `id`) is requested — add a unique index and a keyed conflict target.
