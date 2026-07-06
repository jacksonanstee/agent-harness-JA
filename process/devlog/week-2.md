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

51 new tests across the branch (199 total after the review-fix commit). Telemetry coverage 95% lines / 92% branch.
Verified from `dist/` against the live Week-1 smoke DB: migrations applied
cleanly over the pre-existing `memory_entries` table.

### Review gate (same day)

3-agent review (code / security / architecture, all on Fable): **0 CRITICAL,
0 HIGH**. Fixed before merge: hardcoded `ok: true` in tool-trace dropped
(asserted something false — SDK doesn't surface tool outcome), pre-tool
`fire()`-throw path now leaves a telemetry trace, session `turnId` fallback
decoupled from `generateId` (constant-closure collapse risk), token counts
finite-checked, plus three drift guards (memory-DDL↔migration-001 byte
identity, CHECK↔`TELEMETRY_EVENT_TYPES` re-derivation, eslint layering rules
proven by negative lint fixtures). Deferred with rationale: telemetry retention
policy (no TTL — ADR-0011 Revisit-if, pairs with S-2 redaction), memory's
`DEFAULT_DB_PATH` naming, CLI flag-value parsing hardening.

## 2026-07-06 — S-1 injection scanner shipped (ADR-0012)

Second Week-2 deliverable, off merged main (telemetry PR #11 → `7b2ef9f`).
Heuristic-only prompt-injection scanner; S-5 LLM-judge is a typed seam.

- `src/security/injection`: sync `scan(text): ScanResult {verdict pass|block|ask,
  rule_ids[], excerpts[], suspicious}` over 15 regex rules across 5 families.
  Confidence-gated (high→block, medium→ask), evaluates all rules, hidden-unicode
  strip-and-rescan (tag chars + zero-width runs), per-rule `safeMatch` isolation.
- **ReDoS policy**: linear-time patterns + guard test (<100ms on ~120KB
  pathological input, every rule).
- **Starter red-team corpus** (30 cases, adoptable by Week-3 `src/eval/corpus/`):
  test asserts ≥90% detection, **≥10 blocks (Week-2 checkpoint met)**, 0 benign
  false-positive blocks.
- **Session wiring**: `SessionDeps.scanInjection` runs on the FULL tool output,
  result feeds the post-tool hook `scan` field (architecture step 10, replacing
  the `scan: null` placeholder); warns on block/ask, never aborts. Enforcement
  (redact/drop) deliberately deferred to compose with S-2.
- **Layering**: `src/security/**` forbidden from importing any harness module
  (below-harness layer), proven by `src/layering.test.ts`.

90 new tests (301 total); scan.ts 100% line, rules.ts 100%, security 90%+.

## 2026-07-06 — S-2 secret scanner + redaction shipped (ADR-0013)

Third Week-2 deliverable, off merged main (S-1 → `7e240a1`).

- `src/security/secrets`: `redact(text): {redacted, findings}` over 25
  gitleaks/trufflehog-derived rules; `[REDACTED:<rule_id>]` format. `high`
  structural rules + 3 entropy-gated `heuristic` rules (aws-secret, twilio,
  generic-keyword) to cut false positives.
- **Leak-safe findings**: `SecretFinding` = rule_id + offsets + length, never a
  byte of the secret (property test: findings JSON contains no ≥8-char slice of
  any planted secret). Overlap resolution (longest span wins), redaction never
  capped, idempotent, ReDoS-guarded.
- 25-case secret corpus + 10 benign FP guards (git SHA, UUID, sk- in prose,
  AKIA mid-word, low-entropy placeholders): ≥20 distinct redactions, 0 false positives.
- **Session**: redaction runs on tool OUTPUT *before* the telemetry record —
  **closes the ADR-0011 retention finding** (secrets never reach the retained
  store; fail-closed to `[REDACTION FAILED]` on redactor error) — and on tool
  INPUT (pre-tool). Findings fill the post-tool + new pre-tool hook `redactions`
  slot.
- **Observe-only** (SDK has no rewrite channel — model still sees raw, same as
  S-1 gating). One combined model-facing-enforcement follow-up logged in the
  week plan.

135 new tests (444 total); secrets module 99% line.

Next: S-3 permission model (allow/ask/deny) + S-4 sandbox boundaries, then
docs/security-model.md.

## 2026-07-06 — S-3 permission model (ADR-0014)

Fourth Week-2 deliverable, off merged main (S-2 → `2acbbbb`).

- `src/security/permissions`: `{tool, match?, decision}` rules with
  trailing-`*` prefix globs only (no regex — nothing to ReDoS). Precedence =
  specificity (match > tool > wildcard) then severity (deny > ask > allow):
  order-independent, conflicts fail closed.
- **Settings inheritance**: user `~/.harness/settings.json` under project
  `./.harness/settings.json`; rules concatenate so a user deny survives a
  project allow (sticky deny). Missing file = empty layer; malformed file =
  crash at startup before any tool runs (fail loud, never open).
- **'ask' fails closed**: injected Prompter seam; no prompter / throw / reject
  all deny. TTY prompter deferred until the CLI grows interactive mode.
- **Layering held**: first cut imported HookDenial from hooks — lint's
  peer-leaf rule caught it. Fix: security throws its own `PermissionDenied`;
  the runtime denies on *any* pre-tool throw, so same contract, no import.
- Integration test drives parse → merge → evaluate → hook → SDK deny: denied
  Bash never executes, allowed Read still runs.

42 new tests (486 total). Next: S-4 sandbox, then docs/security-model.md.
