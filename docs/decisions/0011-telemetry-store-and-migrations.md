# ADR-0011: Telemetry store — single-table event log + static-registry migration runner

- **Status:** Accepted
- **Date:** 2026-07-06
- **Requirements:** H-1, E-3, N-1 (via ADR-0004)

## Context

ADR-0004 committed the telemetry *substrate* — `better-sqlite3`, numbered
migrations in `src/telemetry/migrations/`, default DB `./.harness/telemetry.db`,
JSONL export — but deliberately left the schema and runner semantics
unspecified. The integration seams were already stubbed in Week 1: hooks expose
an injected `onEvent` sink (ADR-0008), session carries `usage`/`costUsd`/
`numTurns` off the SDK result message (ADR-0010), and memory shares the DB file
with a promise that telemetry's runner would adopt its DDL (ADR-0009 §5).

## Decision

1. **Migration runner: numbered `.ts` modules in a statically imported registry.**
   `src/telemetry/migrations/index.ts` exports an ordered `MIGRATIONS` array;
   each migration is `{ id, name, up(db) }`. No filesystem discovery — `tsc`
   copies no assets, so `.sql` files would need a build step, and a static
   import works identically under vitest and from compiled `dist/`.
2. **Bookkeeping via a `schema_migrations` table** (id = migration number,
   name, applied_at), created by the runner itself — not `PRAGMA user_version`,
   because shared DBs already exist in the wild with memory's table and no
   version stamp; per-migration rows are self-describing and debuggable. Each
   migration and its bookkeeping row commit in one transaction. The runner
   rejects gap/duplicate ids, recorded-but-unregistered ids, and name
   mismatches; re-runs are no-ops.
3. **Memory adoption without removal.** Migration 001 is memory's DDL verbatim
   (already `IF NOT EXISTS`-idempotent, so adoption on an existing DB no-ops
   and records). Memory's construction-time `ensureSchema` is **deliberately
   retained**: `createMemoryStore(db)` on an arbitrary injected connection must
   stay self-sufficient. Both paths are idempotent; coexistence is safe.
4. **Single `telemetry_events` table** — type discriminator (`turn-cost` |
   `tool-trace` | `hook-event`), promoted indexed columns (`session_id`,
   `turn_id`, `ts`), JSON `payload` TEXT. Per-type tables buy nothing at v1.0
   scale and triple the migration surface; queries are "filter by
   session/turn/type/time", which the three indexes serve.
5. **Correlation model.** The composition root (cli) pre-generates a harness
   session id and a turn id, because hook events fire before the SDK reports
   its own session id. Every telemetry writer keys on the harness ids; the SDK
   session id rides inside the `turn-cost` payload. `sessionId + turnId + ts +
   rowid` reconstructs a full trace in order.
6. **Telemetry and hooks stay import-free peers.** Telemetry defines its own
   structural `HookEventPayload`; the `HookEventRecord → TelemetryEventInput`
   adapter lives in `src/cli.ts`, mirroring how hooks' sink was designed to be
   fed (ADR-0008). Session takes an optional `telemetry: Pick<TelemetryStore,
   'record'>` dep and treats every failure as a warning — telemetry is
   observability, never control flow.
7. **API mirrors memory (ADR-0009):** `record(input): RecordResult` (tagged),
   `query(filter?): TelemetryEvent[]` (bare, TypeError on bad filter),
   prepared statements, named bound params only, defensive `rowToEvent`
   structural validation, SQLITE_CONSTRAINT → `kind: 'constraint'`.
8. **JSONL export:** `agent-harness-ja telemetry export [--db] [--out]
   [--session] [--type]`, one `JSON.stringify(event)` per line, stdout by
   default (terminal-sanitized).
9. **Sanitizer extraction (ADR-0008 Revisit-if fired).** Telemetry echoes
   attacker-influenced strings (tool names, hook reasons, result summaries)
   into an export that reaches terminals, so it sanitizes on write — making it
   the fourth `CONTROL_CHARS` copy site. The copies in
   hooks/router/skills/session/telemetry are replaced by
   `src/internal/sanitize.ts` (zero-dependency leaf). The CLI's
   `TERMINAL_UNSAFE` stays separate: it keeps newline/tab, a different charset
   contract. This amends ADR-0008's "hooks depends on nothing" to "hooks
   depends on nothing outside `src/internal/`".

## Alternatives considered

1. **`.sql` migration files discovered at runtime.** Rejected — needs an asset
   copy step and `import.meta.url` path math that differs between vitest and
   `dist/`.
2. **`PRAGMA user_version`.** Rejected — existing shared DBs have no stamp;
   baseline detection would be needed anyway, and a table is inspectable.
3. **Per-type event tables.** Rejected — 3× migration surface, no query win at
   this scale; revisit with ADR-0004's DuckDB trigger if eval volume explodes.
4. **Adapter inside telemetry (importing hooks' types).** Rejected — breaks
   the peer-leaf rule; the composition root already constructs both sides.
5. **Session generates its own correlation ids.** Rejected — hook events fire
   through a sink constructed before the session runs; ids must be shared, so
   the composition root owns them.

## Review amendments (2026-07-06, 3-agent gate)

- **`ToolTracePayload.ok` dropped before merge:** the SDK's PostToolUse input
  does not surface tool success/failure, so a hardcoded `ok: true` asserted
  something false into a persisted surface. Re-add only when derivable.
- **Drift guards added:** memory DDL ↔ migration 001 byte-identity test and a
  CHECK-constraint ↔ `TELEMETRY_EVENT_TYPES` re-derivation test
  (`src/telemetry/migrations/ddl-drift.test.ts`); layering rules proven by
  `src/layering.test.ts` (negative lint fixtures via the ESLint API).
- **Session `turnId` fallback uses an independent `randomUUID()`,** not
  `generateId` — a constant-closure `generateId` (as the CLI injects) must not
  collapse turnId onto sessionId.
- **Pre-tool `fire()`-throw now leaves a telemetry trace** (`hook-error`
  event recorded by session), closing the one failure path the hook sink
  cannot see.

## Revisit if

- Retention policy: `telemetry_events` has **no TTL/purge** (memory's session
  summaries decay after 30 days). Tool-result summaries persist indefinitely.
  - **Status 2026-07-06 (ADR-0013):** the secret-exposure half of this is
    CLOSED across BOTH retained sinks — S-2 redacts tool output before
    telemetry AND redacts `prompt`/`resultText` before the memory session
    summary (fail-closed to a sentinel on redactor error). A general TTL/purge
    for non-secret content remains open.
- A second telemetry writer process appears — ADR-0004's single-writer
  constraint (`SQLITE_BUSY`) becomes real; add busy_timeout/queueing.
- Payload querying needs SQL-side predicates — promote fields to columns via a
  new migration or add JSON1 indexes.
- OTLP export is requested — extend the export subcommand (ADR-0004 mitigation).
- Memory's `ensureSchema` and migration 001 drift — byte-identity is enforced
  by `ddl-drift.test.ts`; a schema change to `memory_entries` must go through a
  new migration and update both sites.
