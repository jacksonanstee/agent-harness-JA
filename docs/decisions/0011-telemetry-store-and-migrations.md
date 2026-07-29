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
   - **Extended 2026-07-29 (issue #46):** a fourth type, `skill-drop`, added
     by migration m003. See the amendment below, item 1.
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
   - ⚠️ **"terminal-sanitized" is SUPERSEDED and was FALSE from 2026-07-29
     (commit `5ffad52`).** The export ESCAPES; it does not sanitize. See the
     amendment below, item 13, for why replacing rather than adding was the
     correct move.
9. **Sanitizer extraction (ADR-0008 Revisit-if fired).** Telemetry echoes
   attacker-influenced strings (tool names, hook reasons, result summaries)
   into an export that reaches terminals, so it sanitizes on write — making it
   the fourth `CONTROL_CHARS` copy site. The copies in
   hooks/router/skills/session/telemetry are replaced by
   `src/internal/sanitize.ts` (zero-dependency leaf). The CLI's
   `TERMINAL_UNSAFE` stays separate: it keeps newline/tab, a different charset
   contract. This amends ADR-0008's "hooks depends on nothing" to "hooks
   depends on nothing outside `src/internal/`".
   - **Widened 2026-07-29.** `TERMINAL_UNSAFE` is still a separate *contract*
     but no longer a separate *home*: it moved into `src/internal/sanitize.ts`
     (commit `389a7fa`) and is now DERIVED from `CONTROL_CHARS` rather than
     hand-typed. Only `sanitizeForTerminal` — the function, with its forty-odd
     callers — stays in `src/cli/shared.ts`. That leaf now holds every charset
     in the codebase, each derived rather than hand-typed. See the amendment
     below, item 13, for the derivation chain.

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

## Amendment (2026-07-29, issue #46): the `skill-drop` event

ADR-0026 shipped block-on-flag for the skill channel and named its own gap: a
drop left no durable record, so "when did this skill stop reaching the model,
and why?" was unanswerable thirty days later. This amendment records what
closing that gap decided. It adds no new ADR — the event is a fourth type in
the table decision 4 already owns.

1. **Fourth event type, `skill-drop`.** Payload: `name`, `path`,
   `pathTruncated`, `pathHasEscapes`, `reason` (`injection-block` |
   `prompt-budget`), `channels`, `ruleIds`. One row per dropped skill per
   turn, written at the capture site in `src/session/session.ts`.
2. **Migration m003 is a table REBUILD, not an `ALTER`.** SQLite cannot alter
   a `CHECK` constraint, so widening the type discriminator means
   create-copy-drop-rename. It runs inside the runner's per-migration
   transaction and SQLite DDL is transactional, so a failure mid-rebuild rolls
   back rather than leaving a half-renamed table. The three indexes are
   recreated because `DROP TABLE` takes its indexes with it.
3. **Old-binary lockout, accepted.** Once m003 is recorded, an older binary
   throws at the runner's registry check (`recorded migration N is not in the
   registry; refusing to run`) and fails *entirely* — `telemetry export` and
   any run that opens the DB. Two realistic scenarios: a version rollback, and
   two checkouts sharing one `./.harness/telemetry.db`. Accepted because the
   runner's refusal is deliberately fail-loud, and because this attaches to
   *any* future migration rather than to this one. Recorded as **one** item
   because it strictly dominates the per-row read-path skew: no read path
   skips the migration gate.
4. **The payload is a BOUNDED PROJECTION of `SessionResult.droppedSkills`, not
   a copy.** `path` is tail-truncated at 1024 units (the filename
   disambiguates; skill names are not unique), `name` at 200. So the row and
   the in-memory result are deliberately not byte-identical, and code that
   assumes otherwise is wrong.
5. **`name` and `path` are NOT redacted, deliberately.** They are short bounded
   strings naming a local file. The redactor is fail-closed, so a redactor
   error would replace them with the `[REDACTION FAILED]` sentinel — destroying
   the disambiguator the record exists to carry. A hostile skill pack authors
   its own `name` anyway, so redacting it protects nothing. The closer
   precedents agree: hook-error `reason` and the ADR-0025 turn-cost tokens are
   both persisted unredacted. R-g (absolute local paths now enter an
   exportable JSONL sink) is the accepted cost.
6. **First array-bearing payload in this store.** `channels` and `ruleIds` are
   validated and sanitized ELEMENT-wise, not just as containers, because a
   direct library writer need not have gone through `session.ts`. The element
   check uses an indexed loop, not `.every()`: `.every()` skips array holes
   while `JSON.stringify` materialises them as `null`, so a sparse array
   passed write validation, committed, and then threw on read — poisoning
   `query()` for the whole trail, not just that row. Validation and read-back
   now happen in ONE transaction, so `ok: false` means nothing was written.
7. **Stderr and row ordering changed.** The prompt build, the budget-drop warn
   loop and the `droppedSkills` merge now sit ABOVE the session-start fire
   (`src/session/session.ts`, and the comment there is authoritative). Two
   consequences, both intended: skill-drop rows sort before the session-start
   row, and budget-drop warnings now precede session-start hook-error warnings.
   A third was found during review rather than designed: before the move, a
   throw in `buildSystemPrompt` fired `session-start` but never `stop`, an
   asymmetric hook lifecycle; now neither fires.
8. **The caps are TOTAL stored length, and getting this backwards is silent.**
   The truncators bound *content* at `max` and then append a U+2026, so a
   truncated value is `max + 1` units. The capture site must therefore pass
   `CAP - 1`. Pass `CAP` and every truncated row fails `isSkillDropPayload`,
   throws in `assertValidInput`, and is downgraded by `recordTelemetry` to one
   stderr warning — i.e. the pathological long attacker-controlled paths, the
   rows most worth having, are exactly the ones lost. `boundSkillDropName` and
   `boundSkillDropPath` own that arithmetic so no caller re-derives it, and a
   store round-trip test pins that a truncated row is actually RECORDED.
9. **`pathTruncated` is out-of-band, and that is the point.** U+2026 is a legal
   filename character and skill paths are attacker-authored (a malicious cloned
   repo is in scope), so a file named `…foo.md` is byte-identical to a
   genuinely truncated path. An in-band marker is forgeable in both directions:
   fake truncation to send an analyst to the wrong file, or collision between a
   short path and a truncated long one. `name` deliberately has no equivalent
   flag — it is a display label, not the disambiguator. Scope choice, not
   oversight.
10. **TRANSFORM, then TRUNCATE — the order is required.** Truncating first lets
    an attacker fill the tail with characters a later transform rewrites, so
    the whole retained budget is spent on content that vanishes, blanking their
    own audit row. Our order is already correct; it is documented here so a
    future refactor cannot silently invert it. The transform is
    **`escapePathUnsafe`, NOT `cleanSkillText`**: paths are ESCAPED (`\u{...}`),
    so the pre-image is recoverable, because deleting an invisible character
    would let a hostile `/skills/he<U+200B>lper.md` read back byte-identical to
    a benign `/skills/helper.md`. `name`, `description`, `body` and `ruleIds`
    are still `cleanSkillText`'d. `pathHasEscapes` is a property of the
    **pre-image** and therefore survives a truncation that removes the only
    escape token; **re-deriving it by scanning the stored path is the bug, not
    the fix.**
11. **STANDING RULE for future migrations.** m003 is the project's first table
    rebuild and hand-copies m002's columns. See the new entry under "Revisit
    if" below for the rule itself. The ADR entry is necessary but NOT
    sufficient: an ADR requires the next author to think to consult it, whereas
    the rowid rule is already discoverable because it lives inline in
    `m003-skill-drop-type.ts`, the file an m004 author will literally copy. The
    drift-guard rule therefore gets the same code-adjacent treatment — a line in
    m003's docblock and in `index.ts`'s "append new migrations here" registry
    comment — *in addition to* this ADR. Related: `ddl-drift.test.ts`'s mandate
    has widened from cross-module dual ownership to any hand-copied DDL parity,
    cross- or intra-module, so the file's scope is now declared rather than
    inferred from its accumulated contents.
12. **Residuals named rather than fixed.**
    - **R-h:** lone surrogates already present in the input pass through both
      truncators untouched, including via the `length <= max` short-string
      branch, so truncation is not the enabler. SQLite stores the JSON as UTF-8
      (lone surrogate → U+FFFD) while `JSON.stringify` for the export emits a
      literal `\udc00`, so **the two retained sinks disagree about the same
      row**. Reachable on win32. `truncateWellFormed`'s "the result is always
      well-formed UTF-16" doc comment is correspondingly an overclaim.
    - **R-i:** `truncateWellFormed`'s `max` is unvalidated. `NaN` makes
      `text.length <= NaN` false and `slice(NaN)` behave as `slice(0)`,
      returning the entire input falsely marked truncated. Unreachable today —
      all caps are module constants.
    - **R-j — CLOSED 2026-07-29 (issue #50); see amendment item 16 below.** Tail
      truncation is inherently lossy, so two paths differing only *before* the
      cut store identically; `pathTruncated` tells an operator the path was cut
      but not that a distinguishing character was lost. This was first reported
      as a defect of the escape guard and **re-graded after verification**: a
      pure-ASCII control with no escape machinery collides the same way, so it
      predates the escape design entirely. Reachability changed from theoretical
      to default-on with Task 5, because `boundSkillDropPath` had zero
      production callers before it — which is why it was fixed rather than
      carried further.
    - **R-k:** `sessionId` and `turnId` are sanitised NOWHERE on the write path
      and reach SQLite raw; the export sink escapes them, but the stored rows
      hold the raw bytes and any future reader of those columns inherits the
      problem. Security review bounded it: those ids are not attacker-reachable
      in the shipped CLI flow (always `randomUUID()` or caller-supplied via
      `SessionConfig`), and `runTelemetryExport` is the only shipped reader, so
      this is a direct-library-consumer exposure rather than a live CLI vector.
    - **R-d, restated with a price.** Rows restate the same static fact every
      turn. Task 3 priced this against a handful of writes; Task 5 changed the
      shape by moving the loop ahead of the session-start fire. The bound is
      one synchronous validated write per dropped skill per turn, up to the
      loader's 10,000-entry cap. How close a hostile pack gets to that bound is
      a function of skill SIZE, not skill count: `buildSystemPrompt` admits
      skills in load order against a 256,000-char remaining budget, so 10,000
      minimal skills may produce no budget drops at all while 10,000 oversized
      ones drop every time. An earlier draft of this item quoted a specific
      figure; it was not derivable from the code and is replaced by the bound.
13. **The export is ESCAPED, not terminal-sanitised — decision item 8 is
    amended because it was FALSE.** Commit `5ffad52` removed the
    `sanitizeForTerminal` pass outright rather than adding to it, and that
    replacement was the correct move on measured grounds: the escape charset is
    a strict superset by construction, so keeping both was a provable no-op that
    was *also* lossy — the old pass substituted a space, so the stdout copy of a
    row parsed to a DIFFERENT value than the `--out` copy. The two are now
    byte-identical for the same query, pinned by a test. Escapes are 4-digit
    `\uXXXX` per UTF-16 code unit, not the braced `\u{HEX}` of
    `escapePathUnsafe`, because JSON has no braced form. Decision item 9 is
    widened at the same time: no charset in `src/internal/sanitize.ts` is
    hand-typed twice. `TERMINAL_UNSAFE` derives from `CONTROL_CHARS`;
    `PATH_ESCAPE_TARGETS` from `CONTROL_CHARS` together with `BIDI_CONTROLS`
    and `INVISIBLES`; and `JSON_TEXT_UNSAFE` from `TERMINAL_UNSAFE` — two hops
    from the root — plus `\p{Default_Ignorable_Code_Point}` and U+FFF9–FFFB.
    Hand-typing is the construction that let U+2065 through twice, which is
    why the derivations matter more than the count. The
    encoder's home is that leaf and **not** the cli layer, because eslint blocks
    `src/eval/**` from importing `src/cli/**` and `src/eval/scorecard` writes
    durable JSON through the same class of sink; that eval-side gap is
    pre-existing on main and tracked as its own issue (#48) rather than fixed
    here.
14. **The capture site bounds `channels` and `ruleIds` ASYMMETRICALLY, on
    purpose.** `channels` is harness-authored from a closed union, so it is
    passed through whole — neither sliced nor element-truncated — because
    slicing would write a row silently missing a channel and hide the very
    drift the cardinality guards exist to catch. `ruleIds` comes from a
    caller-supplied `scanInjection` and is bounded by nothing, so it IS sliced
    to `SKILL_DROP_RULE_IDS_MAX` and each element truncated to
    `SKILL_DROP_RULE_ID_MAX - 1`. The four array caps are validation bounds in
    both cases; only the `RULE_ID` pair carries truncation semantics at the
    capture site.
15. **Trace order is `ORDER BY ts, rowid`, not `ts` alone.** Decision 5 says
    `sessionId + turnId + ts + rowid` reconstructs a full trace; this states the
    query that does it. It matters more for this event type than the others,
    because a turn's skill-drop rows are written in a tight loop and share a
    millisecond, so `ts` alone gives no total order. This is also why m003
    copies `rowid` explicitly.

16. **`pathDigest` closes R-j (issue #50, 2026-07-29).** `SkillDropPayload`
    gains an OPTIONAL `pathDigest`: SHA-256 of the full escaped path, first
    `SKILL_DROP_PATH_DIGEST_LEN` hex characters, present only when
    `pathTruncated` is true. Two paths differing only before the tail-cut now
    stay distinguishable. The character count is deliberately named rather than
    quoted: R-d above records a figure that travelled into this document and
    could not be derived from the code, and repeating that number here would be
    the same mistake. Note what this does and does not claim. The bit strength
    below IS quoted, repeatedly and on purpose, because it is the load-bearing
    term of the threat argument and that argument is what this item exists to
    record. What is struck is the incidental encoding of that strength as a
    count of hex characters, which the constant already carries.
    - **Optional, and it must stay optional.** Rows written before the field
      existed carry no `pathDigest`. Requiring it would fail
      `isSkillDropPayload` on READ, and `rowToEvent` throws rather than skipping
      a row, so `query()` would throw on every call and deny the ENTIRE trail —
      every unrelated event included — for anyone who had already run the
      shipping build. **Measured, not reasoned:** removing one required field
      from one stored skill-drop row made `telemetry export` exit 1 with zero
      rows out of twenty-five. It also cannot be backfilled by a migration,
      because the digest covers the full escaped path and that is precisely
      what truncation discarded. No migration is needed either way: `payload`
      is JSON TEXT, so the column shape is unchanged.
    - **Absent is valid; present-but-malformed is not.** The validator pins the
      exact length and lowercase-hex charset with an anchored pattern. An
      unusable disambiguator is worse than none, because a consumer would trust
      it.
    - **SHA-256 at 128 bits, and the WIDTH is set by the same argument as the
      algorithm.** The input is attacker-authored: they write the skill pack,
      so they choose both paths, and forcing two audit rows to collide defeats
      the field's only purpose. That rules out a non-cryptographic hash, since
      FNV-class collisions are constructible by hand. **It equally rules out a
      short truncation of a good hash, and an earlier draft of this item missed
      that** — it specified 16 hex characters (64 bits) while justifying itself
      on attacker-forced-collision grounds, and a 64-bit birthday bound is ~2^32
      hashes, minutes of commodity GPU time. Review caught the inconsistency.
      At 128 bits the bound is 2^64, out of reach, so the rejection argument
      and the chosen width now agree. A test ratchets the constant so it cannot
      be silently narrowed.
    - **Widening later is a BREAKING READ CHANGE, not a free improvement.** The
      ratchet permits a larger number, and round-2 review caught that permission
      being read as "widening is fine" when the read path says otherwise. The
      validator's pattern is anchored at the exact current width, `rowToEvent`
      throws rather than skipping, and `query()` maps it over every row — so a
      single row written at the old width denies the whole trail by exactly the
      route the optionality bullet above measured. Anyone raising the width must
      therefore introduce a NEW FIELD NAME and leave the old field readable,
      rather than growing this one in place. The alternative considered and
      rejected was a width-tolerant range in the validator: it buys a free
      widening at the cost of un-pinning the exact width and handing every
      consumer a rule to remember (compare only equal-width digests), which is
      the kind of unstated obligation this item exists to avoid.
    - **Emitted only when truncated,** because a complete path is already its
      own identity. The key is omitted rather than set to `undefined`, so
      presence is itself the signal that something was discarded. This also
      keeps the R-d per-row cost unchanged for the common case.
    - **Derived by `boundSkillDropPath`, from the same call that truncates**, so
      it can no more disagree with `path` than `pathTruncated` can. The
      alternative — deriving it at the call site from the stored value —
      collides exactly as the stored value does, which is the bug itself.
      Rejected alternatives: raising `SKILL_DROP_PATH_MAX` (moves the boundary,
      does not remove it) and a head-plus-tail elision (still lossy in the
      middle, and spends more of the budget to be wrong less often).

**Do not overclaim the drift pin.** The `CHECK` ↔ `TELEMETRY_EVENT_TYPES` test
is inclusion-only: it proves `TELEMETRY_EVENT_TYPES` is a subset of the `CHECK`
constraint, not the converse. And the drift guard cannot observe a run that
throws, so placement is pinned by the ordering test instead — which is a
statement about what the guard does, not a claim that a test could not do it; a
fixture-keyed variant is writable.

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
- **Any migration that rebuilds an existing table** must add a byte-diff test
  in `ddl-drift.test.ts` comparing its output against the immediately preceding
  migration's, with only that migration's declared intentional change
  normalised away. Standing rule from 2026-07-29 (issue #46): m003 is the first
  rebuild and hand-copies m002's columns, so nothing but this test would catch a
  dropped `NOT NULL`. The rebuild must also copy `rowid` explicitly — a plain
  `INSERT…SELECT` assigns fresh rowids and silently renumbers retained operator
  data across a ship-once migration. See m003's DDL comment for both.
