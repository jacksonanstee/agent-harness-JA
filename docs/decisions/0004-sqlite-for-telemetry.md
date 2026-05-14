# ADR-0004: SQLite for telemetry storage

- **Date:** 2026-05-14
- **Status:** Accepted
- **Deciders:** Jackson Anstee
- **Related requirements:** H-1, E-3, N-1

## Context

The harness needs to persist telemetry: per-turn token counts, cost, cache hit/miss, tool-call traces, hook events, and eval results. The data model is append-heavy, queried for both aggregates ("cost in the last hour") and traces ("show me the full event sequence for turn 42").

Realistic storage options:

1. **SQLite** — single-file embedded database, full SQL, mature, zero ops.
2. **JSONL files** — append-only newline-delimited JSON, dead simple, no schema.
3. **DuckDB** — analytical columnar embedded DB, excellent for aggregates.
4. **External service** (Postgres, Honeycomb, LangSmith) — requires hosting, account, or paid plan.

Constraints from requirements:

- **N-1** says the repo must run on a clean machine with only Node and an API key. Rules out external services for the default path.
- **E-3** requires a stable schema with regression detection. Rules out raw JSONL (no schema enforcement).
- **H-1** implies low-friction integration. Rules out anything requiring a separate daemon.

## Decision

Use **SQLite** as the default telemetry store.

Specifically:

- `better-sqlite3` as the Node binding (synchronous API, fast, well-maintained).
- Schema versioned via numbered migration files in `src/telemetry/migrations/`.
- Database file path configurable; default `./.harness/telemetry.db`.
- Provide an `--export jsonl` flag on the telemetry CLI for users who want to ship logs to another system.

## Consequences

### Positive
- Zero infrastructure. `npx agent-harness-ja run` works on a fresh machine.
- Full SQL for ad-hoc queries during debugging.
- Schema gives us regression detection for free (eval results compared via SQL).
- Mature ecosystem; `better-sqlite3` is battle-tested in Electron apps and CLIs.

### Negative
- Single-writer constraint. If the harness ever supports concurrent agent processes writing to the same DB, we will hit `SQLITE_BUSY`. Not a v1.0 concern (single-user, single-process).
- SQLite is not optimised for analytical workloads at scale. Aggregating millions of events will be slower than DuckDB. Acceptable at v1.0 scale (a solo developer's local agent).
- A native binary dependency (`better-sqlite3`) complicates cross-platform install slightly. Mitigated by prebuilt binaries for major platforms.

### Mitigations
- Provide a `harness telemetry export` command that writes JSONL or OTLP for users who outgrow SQLite.
- Document the single-writer constraint in `docs/architecture.md`.
- If multi-process support becomes a requirement, revisit with DuckDB or Postgres.

## Alternatives considered

1. **JSONL files.** Simpler, but loses query power and schema enforcement. Regression detection would require loading files into memory and re-implementing what SQL gives us free.
2. **DuckDB.** Strong for the analytical side. Weaker for the append-per-event write path. We can adopt DuckDB later for an "analytics" surface that reads from SQLite if needed.
3. **External Postgres / hosted observability.** Violates N-1 (zero-friction install) and pulls in account/billing concerns. Not suitable for the default path.
4. **In-memory only.** Loses everything on restart. Defeats the purpose of regression detection.

## Revisit if

- Concurrent-process telemetry becomes a real requirement.
- Eval result volume grows past tens of thousands of rows per run, where DuckDB's columnar advantage becomes load-bearing.
- A user requests OTLP-native export as the *primary* path, not a secondary one.
