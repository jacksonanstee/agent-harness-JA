# Week 2 — Security layer + telemetry (2026-07-06 → 2026-07-12)

Planned scope: telemetry module, then the security layer (S-1 injection
scanner, S-5 LLM-judge, S-2 secret scanner, S-3 permissions, S-4 sandbox
boundaries) and `docs/security-model.md`.

## 2026-07-06 — Telemetry module shipped (ADR-0011)

First Week-2 deliverable, same day the Week-1 checkpoint passed. ADR-0004 had
committed the substrate but left the schema open; ADR-0011 records the design:

- **Migration runner** over a statically imported registry (`.ts` modules, no
  fs discovery — identical behaviour in vitest and `dist/`), `schema_migrations`
  bookkeeping, one transaction per migration, gap/duplicate/name-mismatch
  rejection. Memory's DDL adopted verbatim as migration 001; memory's
  construction-time `ensureSchema` deliberately retained (ADR-0009 Revisit-if
  closed with a status note).
- **Single `telemetry_events` table**: `turn-cost` (cost, turns, usage incl.
  cache creation/read tokens, SDK session id, result subtype), `tool-trace`
  (per post-tool callback), `hook-event` (structural mirror of the hooks sink
  records — telemetry and hooks stay import-free peers; the adapter lives in
  cli.ts, the composition root).
- **Correlation:** cli pre-generates harness session + turn ids because hook
  events fire before the SDK reports its id; the SDK id rides in the payload.
- **`telemetry export`** subcommand: JSONL to stdout or `--out`, `--session` /
  `--type` filters, no API key required.
- **Session integration:** optional `telemetry` dep; records on the error path
  too; every telemetry failure is a warning, never control flow.
- **Sanitizer extraction:** telemetry was the 4th `CONTROL_CHARS` copy site,
  firing ADR-0008's Revisit-if — extracted to `src/internal/sanitize.ts` and
  replaced five copies (separate commit). cli's `TERMINAL_UNSAFE` stays its own
  charset (keeps newline/tab).

45 new tests (193 total). Telemetry coverage 95% lines / 92% branch.
Verified from `dist/` against the live Week-1 smoke DB: migrations applied
cleanly over the pre-existing `memory_entries` table.

Next: S-1 injection scanner.
