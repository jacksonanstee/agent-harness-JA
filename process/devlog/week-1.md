# Devlog — Week 1

> Harness layer. 2026-05-18 → 2026-05-24. Sunday close-out will append "what shipped / what slipped / what I learned" at the end of this entry. Mid-week notes are kept as they happen so the audit trail reflects the actual sequence of work, not a retrospective tidy-up.

## Week kickoff (2026-05-20, two days slipped)

The week was scheduled to start Monday 2026-05-18. I didn't open the repo on Mon or Tue. Naming that here rather than backdating it: this is a *contract with future-me*, not a marketing site, and slippage protocol (`process/05-week-plan.md`) is to document slips honestly.

Two days of a five-evening week are gone. The implication for scope: if all five harness modules don't land by Sunday 2026-05-24, the cut comes from `H-5` (memory, `SHOULD`) before anything else. `H-1` through `H-4` are all `MUST`.

### Order of work

The plan locked router → skills → hooks → memory → SDK wiring. Holding that order. Router goes first because it is the only module with zero dependencies — pure functions over a config table — and it forces a decision on the `TaskDescriptor` schema that the rest of the system reads from telemetry.

### What landed today

1. **ADR-0007** — `TaskDescriptor` schema. This was flagged as open question #2 in `docs/architecture.md` and the plan required it to be resolved before Week 1 implementation. Resolved now, not after writing the code, so the ADR genuinely gates the work rather than reverse-justifying it. Default routing table mirrors the effort-routing rule already in use in my own Claude Code workflow (junior-with-spec → Sonnet, staff-engineer → Opus, intern-5-min → Haiku) — that rule has been load-bearing for me for months, so promoting it to the harness's default is an evidence-based choice, not a guess.

2. **`src/router/`** — four files: `types.ts`, `table.ts`, `route.ts`, `index.ts`. The router is a pure function over `(descriptor, table)` and the table is data, not code, so adding a custom routing rule never requires recompiling the harness. `createRouter({ table })` is the extension point; `route(...)` is the convenience wrapper that uses the default.

3. **`src/router/route.test.ts`** — 11 cases covering every default rule, the fallthrough escalation, both validation paths, and the custom-table override. Coverage target for Week 1 is ≥70%; the router alone is at 100% line coverage of its own module by inspection.

4. **`src/index.ts`** — public barrel. The harness's public type surface starts here.

5. **`package.json`** — added `devDependencies` for `typescript`, `vitest`, `@types/node`. The `test` and `typecheck` scripts were already declared in Week 0 but had nothing behind them; they will resolve now.

### Decisions deferred (not skipped)

- **`hint` field on `TaskDescriptor`.** Included as optional, ignored by the default table, available to custom tables. Lets the harness ship a closed type today without painting future-me into a corner if a real consumer needs richer routing later.
- **Cost-budget routing (H-6).** Stays out. Adding it would require the router to read live telemetry to know running cost, which inverts the architectural dependency direction. Tracked as `COULD` for v1.x.
- **Hook mutation vs observe-only (open question #3).** Not relevant until the hook module — will resolve in the ADR that ships with `harness/hooks` later this week.

### Next sessions

- `harness/skills` — frontmatter validation via `gray-matter` + `ajv`. Schema is already half-locked by ADR-0006; the loader is the part that needs writing.
- `harness/hooks` — pre-tool / post-tool / session-start / stop. Sequential, async, short-circuit-via-throw. Will need ADR-0008 to resolve open question #3 before implementing.
- `harness/memory` — only if `H-1`–`H-4` are done by Saturday. Otherwise cut and defer.

## Sunday close (to be written 2026-05-24)

_What shipped:_

_What slipped:_

_What I learned:_

_What changes for Week 2:_

## Resume after a six-week gap (2026-07-05)

The Sunday close above was never written. Naming that plainly rather than backfilling it after the fact: the project stalled after H-2 landed on 2026-05-20. Other work took priority for the better part of six weeks — this is a hobby project worked evenings/weekends, and evenings/weekends went elsewhere. No spin on that; the slippage protocol in `process/05-week-plan.md` exists precisely so a gap like this gets logged, not hidden.

### What landed today

1. **Issue #2 router follow-ups, items 1–3.** The differential review of PR #1 (`process/reviews/differential-review-PR1.md`, finding A8) flagged that `sanitizeReason` stripped C0/C1/DEL control characters but not U+2028 (LINE SEPARATOR) / U+2029 (PARAGRAPH SEPARATOR), which could survive into a custom rule's `reason` and break log ingestors that split on Unicode line boundaries. Fixed the sanitizer, added 3 contract-lock tests pinning the router's public output shape, and installed `@vitest/coverage-v8` (wasn't wired up before — coverage numbers up to now were "100% by inspection," not measured). Baseline with the new tooling: 89.56%. Item 4 (a README warning about the same class of issue) stays open — deferred to Week 4's docs pass, not forgotten.

2. **`harness/skills` (H-3).** The loader ADR-0006 half-specified: recursive scan of a `skills/` directory, `gray-matter` for frontmatter, ajv for schema validation, invalid files reported without failing the whole load. 19 tests, 100% line coverage on `load.ts`, 90.6% branch. The one real design tension: the ADR said `load(dir): Skill[]`, but "invalid files don't fail the load" and "errors are structured, per-file" can't both survive a bare array return — resolved by introducing `LoadResult` (`{ skills, errors }`); full reasoning is in the ADR-0006 amendment, not repeated here.

3. **`vitest.config.ts` coverage excludes.** Added excludes for re-export barrels (`index.ts` files — no branching logic, just re-exports) and for `src/skills/types.ts` (type-only, erased at compile time). Justification is one line and worth keeping one line: there is no runtime code for v8 to observe in either case, so counting them against coverage would only be measuring the instrumenter, not the code.

### Noted, not actioned

- **`eslint` config is still missing.** The `lint` script has been declared since Week 0 and still resolves against zero installed `eslint` packages. Not blocking anything yet, but it's debt, not an oversight — logging it here so it doesn't quietly become permanent.
- **`npm audit`** shows a dev-only advisory chain through `esbuild` → `vite` → `vitest@1.6`. The fix is a breaking `vitest@4` upgrade. Dev-only, not shipped to users, so not urgent — but also not free, since `vitest@4` will touch the coverage config just added above. Deferred, logged, revisit before it's the thing blocking a real security fix.

### Next sessions

- `harness/hooks` (H-4) — still next in the locked router → skills → hooks → memory → SDK order. Needs ADR-0008 for open question #3 (hook mutation vs observe-only) before implementation, same as noted back in May.
- Given the six-week gap, Week 1's dates (`2026-05-18 → 2026-05-24`) are fiction at this point. `process/05-week-plan.md` needs an honest re-date pass before Week 2 work starts — not doing it in this entry because it deserves its own deliberate pass, not a rider on a devlog note.

## H-4 hook runtime (2026-07-05, same session as H-3)

Fourth module, built straight after H-3 in the same sitting. Router → skills → **hooks** → memory → SDK; hooks is now done.

### ADR-0008 first — the hard gate

`harness/hooks` had an open design question parked since Week 0 (architecture.md open question #3): can a hook *mutate* tool args/results, or only observe + accept/deny? The build order note said "resolve the ADR before writing the runtime," so ADR-0008 was written and committed as a standalone commit before any `src/hooks/` code. It ratifies **observe + accept/deny only for v1.0**, mutation deferred to v1.x. The load-bearing reason is security-layer authority: a hook that could rewrite `args` after `pre-tool` but before `permissions.check` (turn steps 7→8) would let a harness-layer extension route around a security gate. Full reasoning + six rejected alternatives in the ADR.

### The module

`createHookRuntime(opts?)` factory + module-level default + bare `register`/`fire` (router precedent, not skills' singleton — hooks hold per-session mutable handler state, so each SDK session needs its own registry). Handlers run **sequentially in registration order**, awaited one at a time (proven by a descending-delay ordering test — completion order would differ if it were `Promise.all`). A `pre-tool` throw denies and short-circuits; other events' throws are isolated (recorded, later handlers still run). `fire()` catches the deny and returns a tagged `FireResult` rather than rethrowing — a deny is expected control flow, so callers branch on `result.denied` instead of wrapping in try/catch. Telemetry is an **injected sink** (no-op default) so the module keeps its "depends on nothing" contract while still emitting the architecture-named `denied-by-hook` event; telemetry will later adapt the record shape, dependency pointing the correct way.

### The review gate did the work again

Same gate as H-3 (3-agent → differential), and it earned its keep:

- **3-agent pass** (code + security + architect) found three real issues. Security HIGH: the `tool` field on the `denied-by-hook` record went to the log/terminal-adjacent sink *unsanitized* while its sibling `reason` was scrubbed — and `tool` is model-requested, i.e. adversarial LLM output (the same log-injection class the router U+2028 fix and the H-3 error-sanitization closed). Code MAJOR: `fire<E>(event, payload)` bound `E` from the event but TypeScript won't correlate the payload argument through a widened caller — exactly the dispatch-loop shape H-1 will use — so a mismatched payload slid past the type checker with no runtime guard; fixed with an `assertPayloadMatchesEvent` throw (router `assertValid` precedent). Architecture MEDIUM: the ADR's immutability claim was aspirational — `Readonly<>` is compile-time-only — so a handler could mutate the shared payload; added `Object.freeze` before dispatch and reconciled the ADR to state the freeze is shallow and the SDK must re-read `args` authoritatively.
- **Differential review** (run on Fable, 32 adversarial probes against the compiled `dist/`) confirmed every fix holds and every deny-bypass vector is closed — then caught one LOW *introduced by the sanitize fix itself*: `sanitize(payload.tool)` assumed a string, so a non-string tool made the deny path throw where the accept path resolves. One-line `String()` coercion, mirroring the existing `reasonOf`.

Final: 87 tests (unit + per-event integration asserting payload shape, ordering, and deny short-circuit — the H-4 acceptance criterion), `runtime.ts` 100% line / 97% branch, RCE-class tool-injection verified closed against the built artifact.

### Noted, not actioned (carried from H-3, still open)

- `eslint` config still missing; `npm audit` dev-only `vitest@1.6` chain still deferred.
- **The Week 1 date re-date is still owed** — this is now the fourth module landing on 2026-07-05 under a header that says "2026-05-18 → 2026-05-24." Deferred again, but it's overdue for its own honest pass before Week 2.
- Sanitizer is now copied in three modules (router, skills, hooks). Rule-of-three is hit, but extraction needs relaxing hooks' "depends on nothing" first — tracked as a Revisit-if in ADR-0008, deliberately not scope-crept into H-4.

## H-5 memory store (2026-07-05, same session as H-3/H-4)

Fifth and final Week-1 harness module. Router → skills → hooks → **memory** done; only H-1 (SDK wiring) + CI remain in Week 1. H-5 was the designated first-cut (SHOULD), but it landed, so the Week-1 checkpoint's "≥1 memory entry persisted" clause is satisfiable for real.

### ADR-0009 first — and it was genuinely needed

ADR-0004 picks SQLite for *telemetry* — I checked whether it also covered memory, and it doesn't (title/context/related-requirements are telemetry-only, H-5 unlisted). So ADR-0009 reuses ADR-0004's `better-sqlite3` substrate but owns the memory-specific decisions. The load-bearing one is the same seam hooks hit: architecture.md says memory "depends on telemetry's SQLite connection," but telemetry is a Week-2 module that doesn't exist yet. Resolved identically to ADR-0008's injected sink — **memory takes an injected `better-sqlite3` connection** (`createMemoryStore(db)`) and never imports telemetry; a small `openMemoryDatabase()` helper opens/ensures the shared DB for CLI/test/H-1 use. Memory owns only its `memory_entries` table via idempotent `CREATE TABLE IF NOT EXISTS`; telemetry's future migration runner adopts it later.

Step 0 was de-risking the native dep: `better-sqlite3` is a native module and this machine is on Node 25, so I smoke-tested that the prebuilt binary loads before building on it (it did — no fallback to `node:sqlite` needed).

### The module

`write` is upsert-by-id with **full-replace (PUT) semantics** (the write *is* the stored row), returning a tagged `WriteResult`. `read(filter?)` stays bare `MemoryEntry[]` per the locked signature — a query over our own table has no domain failure mode, only programmer error (throws) or catastrophic IO (throws), so tagging it would be worse ergonomics. `delete(filter)` is a bounded superset (empty filter throws, to prevent a table wipe). Retrieval-by-type is indexed; `staleAfter` gives retrieval-time decay filtering; tags are JSON-encoded; all SQL is bound-parameterized.

### Review gate

Same gate (3-agent → differential), all on Fable this time. **Security came back clean** — SQL injection, connection-lifecycle/use-after-close, and `tags` prototype-pollution were all *empirically* probed against the compiled `dist/` and closed. **Architecture** ruled all three self-declared spec deviations (`MemoryInput` refining `MemoryEntry`, `delete` beyond the 2-method surface, write-tagged/read-bare) sound and well-justified. **Code review** found two MAJORs worth fixing: the upsert silently wiped `key`/`tags` on a partial update (fixed by making full-replace explicit + tested rather than silent), and `entry.key`/`filter.key`/`filter.tag` skipped the runtime validation every sibling field got. Plus the real MINOR I'd predicted — `read({tag, limit})` applied the SQL `LIMIT` *before* the JS tag post-filter and under-returned; now the limit caps matches after filtering. All fixed + regression-tested.

Final: 123 tests, `store.ts` 98.3% line / 92.8% branch, real cross-connection on-disk persistence proven.

### Noted, carried

- The Week-1 header date (`2026-05-18 → 2026-05-24`) is now *five* modules stale. It genuinely needs the honest re-date pass before Week 2 — flagged for the fourth time, still owed.
- eslint config still absent. `CONTROL_CHARS` sanitizer: memory deliberately did **not** become the fourth consumer (parameterized SQL, no untrusted content in error messages), so the `src/internal/` extraction stays deferred as ADR-0008 planned.

## H-1: SDK wiring (2026-07-06)

The Week-1 checkpoint module. `src/session/` wires all four modules into one
Claude Agent SDK session behind a `createSession(deps, config)` factory —
the same injected-seam pattern as hooks and memory, this time with the SDK's
`query` function as the injected dependency, so the entire session flow is
unit-tested against fake async generators and the network is only touched by
the real CLI. ADR-0010 records the three calls: injected `query`, structural
SDK types instead of SDK imports (the harness compiles against zero SDK
types; the one cast lives at the CLI boundary), and the hook mapping —
`session-start`/`stop` fired directly by the session module around the stream
(deterministic, exactly-once, fires-on-error via `finally`), `pre-tool`/
`post-tool` bridged through the SDK's `PreToolUse`/`PostToolUse` callbacks
with harness denials translated to `permissionDecision: "deny"`.

`src/cli.ts` is deliberately thin: hand-rolled arg parsing (no dependency),
fail-fast on a missing `ANTHROPIC_API_KEY`, streams assistant text, prints a
one-line summary (model + rule id, turns, cost, denials, memory entry id).
Every session persists a `session-<id>` summary entry through the memory
store — the checkpoint's ≥1-memory-entry requirement is structural, not
optional.

CI finally landed with it: eslint flat config (typescript-eslint recommended)
+ `.github/workflows/ci.yml` running lint → typecheck → test on Node 20/22.
Lint's first pass earned its keep immediately — it surfaced a literal U+FEFF
BOM embedded in a skills-loader regex (now the explicit `\uFEFF` escape) and
a stale disable-comment for a rule that no longer exists. The intentional
control-character sanitizer regexes got a documented config-level opt-out
rather than per-line pragmas.

15 new tests (8 session, 7 CLI arg parsing); suite now 138 across 6 files,
typecheck and lint clean.

## Week 1 close (2026-07-06 — six weeks after the planned Sunday)

The "Sunday close" placeholder above was written for 2026-05-24 and never
filled. Closing the week now, honestly dated.

### Post-merge fix: the containment gate was Node-version-dependent

Before the merge, PR #6's CI came back red on Node 20 only. The H-3
symlink-escape test relied on `readdirSync({recursive: true})` descending
into symlinked directories — which Node 25 does and Node 20 does not
(verified empirically, not from docs). On Node 20 the escaping file was
never enumerated, so the gate had nothing to refuse and the test's expected
error never appeared. The fix replaced recursive readdir with a manual walk
that resolves every symlink at the point it is encountered, refuses any
resolving outside the skills root, and dedupes directory visits by real
path (my own first cut had an infinite-recursion bug on in-root symlink
cycles — caught by self-review before commit). A follow-up hardening commit
extracted `scanMarkdownFiles()` and added a 64-level depth cap after review
flagged stack-exhaustion DoS. Two lessons: (1) "verified on Node X" in a
comment is a smell — behavior notes belong in tests that CI runs on every
supported version; (2) the CI matrix earned its keep on its first weekend.

### What shipped

All six checklist items: router (H-2), skills loader (H-3), hook runtime
(H-4), memory store (H-5), SDK wiring (H-1), and CI (lint → typecheck →
test on Node 20/22). 148 tests. Five ADRs written *before* their modules
(0007–0010 plus the 0006 amendment). Every module went through the
3-agent → differential review gate, and the gate caught real defects every
single time — an RCE-class frontmatter eval, a symlink exfiltration vector,
a type-checker blind spot in hook dispatch, a silent-data-wipe upsert, and
the Node-version dependence above.

### What slipped

The calendar, badly: six weeks of stall between H-2 (2026-05-20) and the
rest (2026-07-05/06). The plan file's timeline table now carries planned
vs actual columns and re-dated Weeks 2–4 rather than pretending otherwise.
One merge-mechanics stumble at the end: squash-merging the memory PR
deleted the base branch of the stacked SDK PR before GitHub retargeted it,
which auto-closed it unrecoverably — it landed as a fresh PR (#7) after a
rebase. Rule for next time: retarget the child PR to main *before* merging
the base.

### What I learned

The review-gate pattern is the portfolio differentiator working as
designed: five modules, five rounds of real findings, zero of them found
by me on the first pass. The injected-seam pattern (hooks' sink, memory's
connection, session's `query`) kept every module unit-testable without the
network and resolved three "depends on a module that doesn't exist yet"
knots the same way.

### What changes for Week 2

Nothing structural. The remaining checkpoint clause — the live E2E smoke —
needs an `ANTHROPIC_API_KEY` on this machine; it runs before Week 2 code
starts. Known debt carried forward, tracked as issues rather than memory:
the router's model table names a previous-generation model lineup, the
skills loader has four low-severity review findings (ordering nuance,
diamond-symlink dedup, partial-EACCES test, file-count cap), and issue #2
item 4 (README warning) stays parked for Week 4.
