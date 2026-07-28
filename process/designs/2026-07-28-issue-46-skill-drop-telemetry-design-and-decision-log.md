# Design spec — issue #46: durable record for skill drops

**Status:** APPROVED by structured design review 2026-07-28. Not yet implemented.
**Base:** main `db164e6`, 979 tests.
**Process:** `multi-agent-brainstorming` — 3 reviewers (Skeptic/fable, Constraint Guardian/fable,
User Advocate/sonnet) all returned REVISE on v1; arbiter (fable) returned REVISE on v2 and
APPROVED on v3. Full objection coverage below.

---

## 1. Problem

ADR-0026 made the skill channel block-on-flag: a high-confidence injection `block` on a skill's
description, body, or assembled section drops the whole skill from the system prompt. This is the
single model-facing *enforcement* action the harness takes.

A drop currently produces only a stderr warning plus `SessionResult.droppedSkills`. Nothing
durable. A tool denial — a less novel act — does get a `denied-by-hook` telemetry row.
`docs/architecture.md:274` carries an explicit clause admitting its own "every step is recorded"
claim is false for this step.

Operational scenario (from the issue): a pack update adds a README badge, `markdown-image-exfil`
fires, the skill silently stops influencing behaviour. Thirty days later there is no way to answer
*"when did this skill stop reaching the model, and why?"*

**Aggravating fact, verified:** `cli.ts:381` prints `denied=` and `memory=` and never
`droppedSkills`. The telemetry row is therefore the operator's ONLY durable access to a drop.

---

## 2. Design

### 2.1 New event type, with the store's first array-bearing payload

```ts
// src/telemetry/types.ts
export type TelemetryEventType = 'turn-cost' | 'tool-trace' | 'hook-event' | 'skill-drop';

/** Structural mirror of session's SkillDropReason. NOT imported from src/session —
 *  telemetry is a leaf below harness (layering.test.ts), the same rule that makes
 *  HookEventKind a structural mirror of hooks' kinds. */
export type SkillDropReason = 'injection-block' | 'prompt-budget';

export interface SkillDropPayload {
  name: string;          // bounded head-projection, 200
  path: string;          // bounded TAIL-projection, 1024
  reason: SkillDropReason;
  channels: string[];    // blocking channels; [] for 'prompt-budget'
  ruleIds: string[];     // <=32 elements, <=64 chars each, sanitized
}
```

`channels` is carried because without it the durable record is strictly LESS informative than the
transient stderr warning it replaces (`session.ts:349-353` names the channel; `DroppedSkill` does
not). Adding it to `DroppedSkill` is additive and blessed by ADR-0023.

Rejected: a `'skill-dropped'` `HookEventKind`. No hook fires for a drop, so it would assert
something false into a persisted surface — the same reason `ToolTracePayload` refuses an `ok`
flag — and `HookEventPayload` has no home for `ruleIds` without widening anyway.
Rejected: also firing a hook. YAGNI; nothing has asked for a runtime reaction.

### 2.2 Recording site, and the reorder

`buildSystemPrompt` + the budget-warn loop + the merge + a new record loop relocate to sit between
`:361` (turnId minted) and `:576` (the session-start fire).

`buildSystemPrompt` is module-level (`:246-278`) and depends only on `injectableSkills`, available
since `:355`. Nothing between `:362` and `:596` reads `injectableSkills` or `blockedSkills`;
`systemPrompt` has exactly one use, at `:613`.

The move buys three things:
- Drops record BEFORE `deps.hooks.fire('session-start')`, which is **not** try/caught (unlike the
  pre-tool fire at `:492-514`) and can reject when a caller injects a throwing `HookRuntime`.
- `skill-drop` rows sort BEFORE the session-start row under `ORDER BY ts ASC`
  (`store.ts:302-305`, "trace reconstructions, oldest first"), making trace order truthful rather
  than excused.
- One loop over the exact array returned as `SessionResult.droppedSkills`, so the durable record
  and the programmatic surface cannot drift.

**Safety, verified:** all 18 warning-capture sites in `session.test.ts` assert order-independently
(`.some(...)`, or one `.filter(...).toEqual([])`); there are no `warnings[N]` index assertions and
no exact-array `toEqual` on the full list. The two hook-order pins (`:149`, `:325`) are unaffected
because the moved code fires no hooks.

**Behaviour change to record in the ADR:** operator-visible stderr ordering changes (budget-drop
warnings now precede session-start hook-error warnings) even though no test pins it.

### 2.3 Bounds — direction-correct, every string sanitized

- `name`: `truncateWellFormed(name, 200)`. Head-preserving is correct here.
- `path`: **tail-preserving** projection at 1024 (order PATH_MAX). Head truncation is rejected: it
  keeps the common prefix and discards the distinguisher, for the one field whose documented job
  (`session/types.ts:250-255`) is disambiguation, because skill names are not unique.
- `channels`: harness-authored literals, capped at 3 (the number of scanned channels).
- `ruleIds`: cap count at 32 and each element at 64 chars, and map `sanitizeText` over elements.
- `path` gains `stripInvisibles` at both capture sites (`:267`, `:347`) so it matches `name`'s
  charset contract (`cleanSkillText`, `:43`). Today it gets only
  `stripBidi(sanitizeControlChars(...))`, so zero-width chars in a hostile directory name survive.

**The tail projection is NEW code with a hazard the existing helper does not have.**
`truncateWellFormed` (`internal/sanitize.ts:66-73`) is head-preserving and guards only the
TRAILING cut edge — it tests `charCodeAt(max - 1)` for a HIGH surrogate (0xD800-0xDBFF). A tail
projection has the MIRROR hazard at the LEADING edge: `slice(len - 1024)` can begin with a LOW
surrogate (0xDC00-0xDFFF) whose high half was cut, emitting a lone surrogate into a persisted,
exportable sink. Paths can legitimately hold non-BMP characters — emoji directory names survive
all three strippers. **Spec:** after taking the last 1024 units, if the first kept unit is a low
surrogate, drop it; then prefix `…`. The codebase already treats this class as design-level, cf.
the `cleanSdkToken` comment "a naive slice can emit a lone surrogate".

**Caps are shared constants, not duplicated literals.** `assertValidInput` runs BEFORE
`sanitizePayload` on the write path (`store.ts:324-332`), so if `isSkillDropPayload` enforces
32×64 then the session must cap at payload build or it trips its own read validator. Capture-site
and read-path caps must be the same exported constants.

**Store side:** `isSkillDropPayload` validates array ELEMENTS (a first for this store);
`sanitizePayload` gains its first array branch, because `store.ts:160-161` states it re-sanitizes
precisely for direct writers who never went through `session.ts`.

**Redaction — decided explicitly, not assumed: do NOT redact `name`/`path`.** They are short
bounded strings naming a local file. The redactor's fail-closed `[REDACTION FAILED]` sentinel
would destroy the very disambiguator this record exists to carry. The secret-transit channel in
this threat model is tool output and prose (`session.ts:536-541`, the ADR-0011 retention finding),
not operator-authored file identifiers; and a hostile skill pack authors its own `name`, so
redacting it protects nothing — the attacker wrote the string. Closer precedents (hook-error
`reason` at `:511`, the ADR-0025 turn-cost tokens) are persisted unredacted.

### 2.4 Validator ratchet

`TELEMETRY_EVENT_TYPES` (`store.ts:21`) uses `as const satisfies readonly TelemetryEventType[]`,
which checks MEMBERSHIP, not completeness. Widen the union and forget the array and it compiles
clean, while `EVENT_TYPE_SET` (`:24`) then rejects every write at `assertValidInput` — the whole
feature silently dead, downgraded to a warning. Derive the array from a
`Record<TelemetryEventType, true>` so omission is a compile error.
`isPayloadForType` becomes an exhaustive switch with a `never` check, replacing its current
unguarded fall-through to `isHookEventPayload`.

### 2.5 Migration m003 — table rebuild

`m002-telemetry-events.ts:14` bakes the allowlist into the DDL:
`CHECK (type IN ('turn-cost','tool-trace','hook-event'))`. SQLite cannot `ALTER` a `CHECK`, so
m003 performs the standard rebuild inside the runner's per-migration transaction
(`runner.ts:89-92`): create `telemetry_events_new` with the widened CHECK, `INSERT INTO … SELECT`,
drop old, rename, **recreate all three indexes** (`m002:20-22`).
`ddl-drift.test.ts` ("CHECK accepts exactly TELEMETRY_EVENT_TYPES") must go green against the
rebuilt table, not be relaxed.

**Accepted consequence: old-binary lockout.** Once m003 is recorded in `schema_migrations`, an
older binary throws at `runner.ts:69-73` ("recorded migration N is not in the registry; refusing
to run") and fails ENTIRELY — `telemetry export`, and any run that opens the DB. Scenarios:
version rollback, or two checkouts sharing one `./.harness/telemetry.db`. This is inherent to the
runner's deliberately fail-loud design for ANY future migration. Accepted, and stated in the ADR
rather than discovered.

### 2.6 Docs

- **ADR-0011 amendment:** 4th event type; m003 rebuild; old-binary lockout; bounded-projection
  rationale; the explicit redaction decision; first array payload; the stderr-ordering change.
- **ADR-0026** line 51 residual → closed.
- **`docs/architecture.md:274`:** the "one honest exception" clause is **REPLACED, not deleted**.
  New wording must state that recording is best-effort and composition-dependent —
  `deps.telemetry` is optional and `recordTelemetry` downgrades failure to a warning. Deleting the
  caveat outright would substitute a new overclaim for a retired one.
- **`src/cli/shared.ts:23-28` USAGE enumerates the valid `--type` values**, and README gains a
  worked `telemetry export --type skill-drop` example. Without these the filter is discoverable
  only by guessing wrong and reading the validation error.
- `docs/security-model.md` §4 swept for the same class of staleness.
- No new ADR — keeps the count at 26, which the README states in three places.

### 2.7 Tests

Read-path validator (valid / wrong-type / missing field); dirty and oversized `ruleIds` elements
rejected; truncation of an oversized `name`; **a path whose 1024-unit cut boundary splits a
surrogate pair, asserting no lone surrogate reaches the payload**; `channels` populated for
`injection-block` and empty for `prompt-budget`; both reasons producing rows; `--type skill-drop`
filtering through the CLI; **m003 forward-migration over a database populated with pre-m003 rows
of all three old types** (rows survive, indexes exist, CHECK accepts exactly four types); an
ordering pin that a `skill-drop` row precedes the session-start row within a turn; and a drift pin
keyed on `reason` + tail-of-path rather than raw equality, since the payload is a projection.

The ordering pin is a **real witness**, not a vacuous assertion: `hooks/runtime.ts:149` emits a
`hook-fired` event on every fire including session-start, and the store's `rowid` tiebreak
(`store.ts:305`) makes same-millisecond ordering total. If the record loop regresses below the
fire, the pin goes red.

**Existing pin this breaks — update deliberately, do not pattern-match green:**
`session.test.ts:888` is a full-object `toEqual` on `{name, path, reason, ruleIds}` and must gain
`channels`. Verified it is the only full-object pin; the other 17 `droppedSkills` assertions are
`.map(...)` projections, `[0]?.field` accessors, or `toEqual([])` empties. The ADR-0023 surface
guards (`exports-map.test.ts`, `index.test.ts`) are RUNTIME pins with no `.d.ts` snapshot gate, so
adding an interface field breaks neither.

Also: `buildSystemPrompt` at `:267` constructs a `DroppedSkill` directly and gains `channels: []`.
That site has no scan results and cannot obtain them without a signature change — and `[]` is the
honest value, since nothing "blocked" it.

Every new assertion verified RED under a targeted mutation before being kept.

---

## 3. What v1 of this design got wrong

Recorded because the review catching these is the point of the process.

1. **v1 had no migration and could not have worked.** Every `skill-drop` insert would fail the
   CHECK constraint; `record()` returns `{ok:false}`; `recordTelemetry` downgrades to a warning.
   The run stays green and writes nothing — the exact failure #46 exists to eliminate.
2. **v1 bounded `path` in the direction that destroys its purpose** (head-truncation on the field
   whose only job is disambiguation), and did so for the surface that is the operator's only
   durable access.
3. **v1's "`ruleIds` needs no cap" was a false premise.** `scan.ts:160` describes the *shipped*
   scanner; `SessionDeps.scanInjection` is caller-supplied (`session/types.ts:147`) and
   `createInjectionScanner` accepts `opts.rules` (`scan.ts:84`). Elements were also stored raw.
4. **v1 analysed the wrong back-compat hazard** — per-row unreadability rather than migration
   lockout.
5. **v1's doc plan would have replaced an honest caveat with a fresh overclaim.**

---

## 4. Decision log

| # | Decision | Alternatives | Resolution |
|---|---|---|---|
| 1 | New `skill-drop` event type | reuse `hook-event`; also fire a hook | Re-opened with cause when the migration cost surfaced; re-affirmed with m003 accepted |
| 2 | One record site, above the session-start fire | record at each drop site; record at `:605` | Reorder adopted — closes the throwing-runtime gap and makes trace order truthful |
| 3 | Bound in payload only; `path` tail-preserving @1024, `name` head @200 | bound in `DroppedSkill`; no bound; head-truncate path | Tail-preserving with an explicit leading-edge surrogate guard |
| 4 | `ruleIds` capped 32×64, elements sanitized | uncapped (v1) | v1 premise withdrawn |
| 5 | Ratchet derives `TELEMETRY_EVENT_TYPES` from a `Record` + exhaustive `isPayloadForType` | leave fall-through | Adopted and widened past v1's scope |
| 6 | m003 table rebuild | none viable | Largest work item; was absent from v1 |
| 7 | Replace, not delete, architecture.md's caveat | delete it | Adopted |
| 8 | Do NOT redact `name`/`path` | redact | Decided explicitly, rationale into the ADR |
| 9 | Add `channels` | omit | Adopted; additive per ADR-0023 |
| 10 | USAGE enumerates `--type`; README worked example | v1's four doc files | Adopted |
| 11 | No rule-glossary or excerpts in the row | carry them | Rejected — row bloat / needs its own security decision. R-b, R-c |
| 12 | No partial-record incompleteness marker | add one | Rejected as YAGNI; best-effort is the store's existing contract. R-a |
| 13 | ts-ordering limitation | thread capture-time ts | Mooted by decision 2 |

### Full objection coverage (no numbering gaps)

**Skeptic:** #1→d4. #2 (raw elements, first array payload)→absorbed into §2.3. #3→d5. #4→d7, d12,
R-a. #5 (read-path skew)→**superseded by Constraint #2**: verified no read path skips the
migration gate (`store.ts:49`, `:320`; `rowToEvent` reachable only through a store), so the
lockout dominates and one ADR item is the correct recording. #6→d2. #7→d3 (N now fixed). #8 (`path`
charset)→absorbed into §2.3. #9→d13, R-f. #10a→absorbed into §2.7 via re-keying; **the drift pin
cannot observe throwing runs (a throwing run has no `SessionResult`), so placement is pinned by
the ordering test instead** — the residual (a *failed write* leaves no trace) is R-a. #10b→R-d.

**Constraint:** #1→d6, §2.5. #2 (old-binary lockout)→absorbed into §2.5 as an accepted,
ADR-recorded consequence. #3→d4. #4→d3. #5→d8. #6→duplicate of Skeptic #8. #7→R-g. #8→d5.

**User Advocate:** #1→d3. #2→d9 and d11/R-b. #3→d10. #4→d13. #5→R-e. #6→d11, R-c.

**Arbiter 6.5:** `channels` typed `string[]` rather than a literal-union mirror — accepted as-is;
a third structural mirror across the layering boundary costs maintenance for no safety gain on
harness-authored literals.

---

## 5. Residuals — named, not silently closed

- **R-a:** a failed telemetry write leaves no durable trace of the drop; a mid-loop failure leaves
  a partial record with no incompleteness marker. Best-effort is the store's existing contract.
- **R-b:** `ruleIds` are opaque tokens. `rules.ts:114-120` carries a human `description` per rule,
  exposed nowhere a CLI user can reach. Follow-up issue.
- **R-c:** matched `excerpts` exist (bounded, sanitized, `scan.ts:90-95`) but are not carried;
  putting matched attacker text into a durable sink needs its own security decision.
- **R-d:** rows restate the same static fact every turn, up to the loader's 10,000-entry cap
  (`skills/load.ts:147`), into an indefinitely-retained store.
- **R-e:** `reason` lives inside the JSON payload, not an indexed column, so separating a
  security-relevant `injection-block` from benign `prompt-budget` churn means scanning.
- **R-f:** `sdkSessionId` does not exist at the record site, so correlating a drop to an SDK
  session id requires a join through the turn-cost row on `turnId`.
- **R-g:** absolute local paths (`/Users/<name>/…`) now enter an exportable JSONL sink.

---

## 6. Scope note

This is materially larger than the "small additive change" it was first scoped as: a durable-DB
table-rebuild migration, a session hot-path reorder, the store's first array-bearing payload, a new
truncation primitive, and five doc surfaces. The arbiter ruled it coherent as ONE change — the
pieces are mutually dependent (the writer without m003 dies at the CHECK; m003 without the writer
widens a constraint nothing uses; the ratchet is what makes the widening land safely) — and found
no cause to overrule the single-change decision. Splitting would ship the lockout with less
accompanying value.
