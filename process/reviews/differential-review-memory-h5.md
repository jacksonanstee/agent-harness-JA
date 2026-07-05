# Differential Security Review — Module H-5 (Memory Store)

**Branch:** `feat/memory-h5` vs `main` (`3117d2d`)
**Diff:** `git diff 3117d2d..HEAD` (4 commits)
**Reviewer:** differential-review (DEEP strategy, SMALL codebase)
**Date:** 2026-07-05
**Verdict:** ✅ **APPROVE-WITH-NITS**

---

## 1. Scope & Strategy

| Item | Value |
|---|---|
| Files changed | 9 (`store.ts`, `types.ts`, `index.ts`, `store.test.ts`, ADR-0009, `src/index.ts`, `vitest.config.ts`, `package.json`, `package-lock.json`) |
| Production code under review | `src/memory/store.ts` (291 LOC), `src/memory/types.ts` (68 LOC) |
| Codebase size | SMALL (<20 source files) → **DEEP**: all deps read, full fix-commit blame, empirical probes against `dist/` |
| Risk classification | **MEDIUM** — new public data-access API, SQL surface, validation logic. No auth/crypto/value-transfer/network. |
| Commits | `0d06210` ADR, `352d4a9` deps, `34d4e71` feat, `364692f` fix (3-agent review remediation) |

The differential focus per the brief: judge the **final** branch state, hunting for (a) anything the per-file passes missed and (b) anything the fix commit `364692f` itself introduced.

---

## 2. Empirical Verification (evidence, not commit messages)

All commands run from repo root; probes against built `dist/memory/`.

| Check | Command | Result |
|---|---|---|
| Build | `npm run build` (tsc) | ✅ clean |
| Typecheck | `npm run typecheck` (tsc --noEmit) | ✅ clean |
| Full suite | `npx vitest run` | ✅ **123 tests, 4 files, all pass** (memory = 36) |
| Memory coverage | `vitest run src/memory --coverage` | ✅ **98.28% stmts / 92.78% branch / 100% funcs**; uncovered lines are unreachable defensive throws (85, 106–107, 157–158) |
| SQL injection (key) | probe: `read({key:"k'; DROP TABLE memory_entries;--"})` | ✅ bound param; row returned by exact match, table intact (2 rows) |
| SQL injection (tag) | probe: `read({tag:"t'--"})` | ✅ exact post-filter match, no eval |
| `read({tag,limit:2})` of 4 matches | probe | ✅ returns exactly 2 |
| `read({tag,limit:0})` | probe | ✅ returns 0 |
| `read({limit:0})` no tag | probe | ✅ SQL `LIMIT 0` → 0 |
| `read({limit:3})` no tag | probe | ✅ SQL-limits to 3 |
| `read({tag,limit:99})` (limit>matches) | probe | ✅ returns all 4 (no over-return) |
| tag+limit+order interaction | probe: `{tag,limit:2,order:'asc'}` | ✅ slice keeps oldest-two in ascending order |
| Full-replace upsert | probe: write key+tags+staleAfter, re-write same id bare | ✅ key/tags/staleAfter reset; `createdAt` preserved |
| Closed-db `read` | probe | ✅ **throws** (untagged) — as designed for programmer-error surface |
| Closed-db `write`/`delete` | probe | ✅ tagged `{ok:false, kind:'db'}` |

---

## 3. Fix-Commit Scrutiny (`364692f` — highest priority)

**Fix 1 — `read` LIMIT-after-tag-filter.** The regression is genuinely closed. `buildReadQuery` computes `tagPostFilter = filter.tag !== undefined` and pushes SQL `LIMIT` **only when no tag filter** (`store.ts:213`). The tag path carries `postFilterLimit`, applied via `.slice(0, limit)` **after** `entries.filter` (`store.ts:263-265`). Verified empirically across the tricky cases the brief flagged:
- tag-less query still gets SQL `LIMIT` (incl. `limit:0`) ✅
- `{tag, limit:0}` → 0 rows ✅ (`.slice(0,0)`)
- slice respects order (runs after ORDER BY materialization) ✅
- no double-application, no dropped limit ✅
Stale-exclusion (`includeStale:false`) is applied in SQL *before* the tag filter and slice — correct precedence (stale rows must not consume a limit slot).

**Fix 2 — key/tag validation.** `entry.key` guard correctly permits `undefined` **and** `null` (`store.ts:137`), matching the `string | null` input type; `filter.key`/`filter.tag` guards require `string` when present (`store.ts:159-163`), matching the `MemoryFilter` types (filter has no null semantics). No legit value rejected — round-trip and filter tests confirm.

**Fix 3 — `rowToEntry` full column validation.** New guards on `id/content/type/key/created_at/updated_at/stale_after`. Correctly allows `key===null` and `stale_after===null` (`store.ts:101,104`). A real inserted row still maps (all 36 tests + probes pass). Note the direct-map change `key: r.key` / `staleAfter: r.stale_after` (dropping the prior `?? null`) is now **safe** because the guard proves they are `string|null` / `number|null` before the map — no behavioral loss.

**Fix 4 — dropped `'write'` kind and `field`.** Grepped the whole tree: the only `.field`/`.kind`-string references outside memory belong to the **separate** `src/skills` error type (`load.test.ts`) — unrelated. `memoryError()` only ever emits `'constraint'|'db'`. No dangling reference; typecheck clean. ✅

**Fix 5 — full-replace upsert.** DDL `ON CONFLICT(id) DO UPDATE SET` covers every mutable column (`type,key,content,tags,updated_at,stale_after`) and deliberately omits `created_at` (`store.ts:37-43`). `write` recomputes `createdAt` from the existing row only when an id was supplied (`store.ts:234-235`). Documented in `types.ts` PUT-semantics block and proven by probe + test. ✅

---

## 4. Findings

### Blocking (0)
None.

### Nits (3)

- **N1 — Unbounded scan on tag queries (perf/DoS, LOW).** When `filter.tag` is set, no SQL `LIMIT` is issued (by necessity of the fix), so the entire type/key/stale-matching set is materialized into JS before the tag filter and slice. On a large `memory_entries` table a rare-tag query reads every candidate row into memory. Acceptable for a local single-user harness store at current scale; revisit if tags become a hot path (candidate: a `tags` join table or SQLite `json_each` filtering in SQL). This is an inherent trade-off of the correctness fix, not a regression.

- **N2 — Asymmetric failure surface (LOW, by design).** `read` throws on a closed/broken DB (programmer-error surface, untagged), while `write`/`delete` return tagged `{ok:false}`. Intentional and documented behavior, verified by probe; noted only so a caller wrapping all three uniformly is not surprised. No change recommended.

- **N3 — Cannot filter `key IS NULL` (feature gap, INFO).** `filter.key` must be a `string`, so there is no way to query entries whose `key` is null. Not a bug (matches the type), but a latent gap if null-key retrieval is ever needed.

---

## 5. Blast Radius

`src/memory` is exported via `src/index.ts` (barrel add, 1 line) but has **no production callers yet** (telemetry module named in ADR-0009 is unbuilt; `createMemoryStore` takes an injected `Database` and never imports telemetry — confirmed). Blast radius = the module itself + its 36 tests. A regression here cannot silently corrupt other subsystems today.

---

## 6. Security Posture

- **SQL injection:** CLOSED. Every SQL value is a bound `@param` (better-sqlite3 named params); the only string-concatenated SQL fragments are fixed clause/column/direction literals derived from validated enums (`order` ∈ asc/desc, column names are constants) — no user string reaches SQL text. Re-verified empirically after the query-builder rewrite.
- **Injection via tags/content:** tags are `JSON.stringify`-encoded TEXT and parsed defensively (`parseTags` degrades malformed JSON to `[]`); tag matching is an in-JS `Array.includes`, no eval.
- **Table-wipe guard:** `delete({})` throws `TypeError` (empty-filter guard, `store.ts:171-173`), tested.
- **Untrusted-DB hardening:** `rowToEntry` fully validates rows before typing them — appropriate for the future shared-DB scenario ADR-0009 anticipates.
- No secrets, no network, no filesystem writes beyond the parent-dir `mkdirSync` for a non-`:memory:` path (path is caller-supplied config, not remote input).

---

## 7. Coverage & Confidence

- **Coverage of changed code:** HIGH. 36 targeted tests; branch coverage 92.78%; the 4 uncovered lines are defensive throws that require a corrupt DB/impossible state.
- **Confidence in verdict:** HIGH. Small surface, fully read, empirically exercised including the exact fix edge-cases and the injection surface.
- **Limits:** Concurrency (WAL multi-writer) not stress-tested; single-process assumption holds for the harness. Integer values beyond `Number.MAX_SAFE_INTEGER` rely on better-sqlite3 default (non-bigint) behavior — out of scope for typed epoch-ms usage.

---

## 8. Verdict

✅ **APPROVE-WITH-NITS.** The H-5 memory store is correct, well-tested, and safe to merge. All five remediations from the 3-agent review are correctly implemented and introduce no new defects; the `read` limit-after-tag-filter regression is genuinely closed and the fix does not misbehave on the `limit:0` / order / limit>matches edge cases. The three nits are non-blocking (one perf trade-off inherent to the fix, two by-design/feature-gap notes).
