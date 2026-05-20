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
