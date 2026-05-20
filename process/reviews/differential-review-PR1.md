# Differential Review — PR #1

> **PR:** [#1 — feat(router): model router with rule_id, validation, and sanitization (H-2)](https://github.com/jacksonanstee/agent-harness-JA/pull/1)
> **Branch:** `feat/router-h2` → `main`
> **Commit under review:** `65f1dca`
> **Reviewer:** differential-review skill (Claude)
> **Date:** 2026-05-20
> **Verdict:** **APPROVE** with one MINOR follow-up logged (non-blocking).

## Pre-analysis context

This is the first concrete code in `agent-harness-JA`, an open-source agent harness positioned as a hiring-signal portfolio repo. The PR implements requirement **H-2** (model router) from `process/01-requirements.md`. The router is a pure function over `(TaskDescriptor, RoutingRule[])`. No callers in the repo yet — the module is a leaf in the import graph.

**Codebase size:** SMALL (<20 source files). Strategy: **DEEP**.

**Limit of this review:** All `src/` content is greenfield — there is no baseline to git-blame against for the source files. Regression analysis is therefore N/A for `src/`. The review focuses on (a) new attack surface, (b) test adequacy, (c) public-API permanence, and (d) supply chain.

## Phase 0 — Triage

| File | Change | Risk |
|---|---|---|
| `src/router/route.ts` | new — routing core, validation, sanitization | **MEDIUM** |
| `src/router/table.ts` | new — default rules (data) | LOW |
| `src/router/types.ts` | new — type defs + enum constants | LOW |
| `src/router/index.ts` | new — barrel export | LOW |
| `src/router/route.test.ts` | new — 24 vitest cases | LOW (tests) |
| `src/index.ts` | new — root barrel | LOW |
| `docs/architecture.md` | sync `med`→`medium`, add `rule_id` to inline type | LOW |
| `docs/decisions/0007-task-descriptor-schema.md` | new — locks schema + footgun + thresholds | LOW |
| `process/05-week-plan.md` | check H-2 box | LOW |
| `process/devlog/week-1.md` | new — kickoff entry, honestly names 2-day slip | LOW |
| `package.json` | +3 devDeps (typescript, vitest, @types/node) | LOW |
| `package-lock.json` | auto-generated; pins exact versions; all from `registry.npmjs.org` | LOW |

**Overall risk:** MEDIUM, driven by:

- New public API surface that will be locked once published to npm (closed unions, `ModelChoice` shape, `RoutingRule` extension contract).
- Routing decides *which model* handles caller-tagged sensitive work — even though the router itself does not touch sensitive content, downstream consumers may build safety assumptions on it.
- Custom `RoutingRule.match` predicates are arbitrary consumer-supplied functions — a documented attack surface.

**No HIGH triggers present.** No auth, no crypto, no external calls, no value transfer, no removed security code (greenfield).

## Phase 1 — Code analysis (greenfield; limited)

`src/` has no prior history. The only modified non-source file is `docs/architecture.md`, where the diff is purely a doc sync (no security-relevant text changed; `med`→`medium` matches the just-locked ADR).

No removed code anywhere in the diff. No regressions possible.

## Phase 2 — Test coverage

**Numeric coverage unavailable**: `@vitest/coverage-v8` is not installed, so `npm run test:coverage` does not produce a report. Recommend adding `@vitest/coverage-v8` as a devDep before Week 1 closes, since the week-1 checkpoint requires "≥70% test coverage" and that claim is currently unverifiable.

**Inspection-based coverage of `route.ts` (82 LOC, 5 internal symbols):**

| Symbol | Exercised by | Verdict |
|---|---|---|
| `createRouter` (default table) | most tests | ✅ |
| `createRouter` (custom table) | `router: custom table` describe block | ✅ |
| `route` (convenience wrapper) | most tests | ✅ |
| `assertValid` — shape branch | "rejects unknown shape values" | ✅ |
| `assertValid` — sensitivity branch | "rejects unknown sensitivity values" | ✅ |
| `assertValid` — expected_tokens branch | "rejects negative", "rejects NaN", "rejects Infinity" | ✅ |
| `safeMatch` — try path | most tests | ✅ |
| `safeMatch` — catch path | "treats a throwing rule as non-matching and continues" | ✅ |
| `sanitizeReason` | "strips control characters from custom reason strings" | ✅ |
| All 5 default-table rules + fallthrough | shape-routing block + boundary tests | ✅ |

**Source-to-test ratio:** 82 LOC source : 194 LOC tests = **2.4×**. Healthy.

**Coverage gaps (MINOR):**

1. `safeMatch` does `rule.match(d) === true` — the strict-equality gate against truthy non-booleans (`1`, `"yes"`, objects) is untested. A test asserting `match: () => 1 as unknown as boolean` does *not* match would document the intentional strictness.
2. `assertValid` allows `expected_tokens === 0`. Tested negative (`-1`) but not the inclusive lower bound (`0`).
3. The `hint` field is declared on `TaskDescriptor` but never exercised by any test — it is unused by default rules but is part of the public API. A test confirming a custom rule can read `hint` would lock the contract.

None of these are blockers. Add to a follow-up.

## Phase 3 — Blast radius

**Current intra-repo callers of `route` / `createRouter`:** 0. The module is a leaf.

**Designed intra-repo blast radius (v1.0 horizon):** every other harness module + every eval task — i.e., the entire codebase eventually depends on this. Public API permanence matters.

**External blast radius once `agent-harness-ja` is published to npm:** unbounded. Any consumer can `import { route, createRouter } from 'agent-harness-ja'`. This is the right time to challenge the API shape — every later change risks breaking downstream users.

**Public surface locked by this PR:**

- `TaskDescriptor { shape, sensitivity, expected_tokens, hint? }` with closed unions
- `ModelChoice { model, rule_id, reason }`
- `RoutingRule { id, match, model, reason }`
- `createRouter(opts?: RouterOptions): Router`
- `route(descriptor): ModelChoice`
- `Router`, `RouterOptions` interface
- Constants: `DEFAULT_ROUTING_TABLE`, `FALLTHROUGH_MODEL`, `FALLTHROUGH_REASON`, `FALLTHROUGH_RULE_ID`, `TASK_SHAPES`, `TASK_SENSITIVITIES`

The `rule_id` field on `ModelChoice` (added in response to the architect-reviewer's first pass) is the key forward-compatibility move — it gives machine-parseable routing decisions for future cost-budget routing (H-6) and telemetry. Without it, H-6 would have required a breaking change.

## Phase 4 — Deep context

The MEDIUM concern worth dwelling on: **the router does not enforce a sensitivity safety floor against custom tables.** A consumer can pass `createRouter({ table: [{ match: () => true, model: 'claude-haiku-4-5', ... }] })` and `sensitivity: 'high'` descriptors will route to Haiku.

This is **documented** in ADR-0007 ("Footgun"): policy belongs to the security layer, not the router. The architectural argument is correct — but the documentation is the *only* thing standing between a consumer and a silent safety regression. Two mitigations could harden this without inverting the layering:

1. Surface an opt-in `enforceSensitivityFloor: true` flag on `RouterOptions` — deferred to v1.x by intent. Acceptable.
2. Add a one-line warning in the README's router section. **Not yet done.** Recommended before npm publish.

## Phase 5 — Adversarial analysis

Threat actors considered:

- **T1:** LLM-generated `TaskDescriptor` (LLM tries to manipulate routing)
- **T2:** Compromised consumer config shipping malicious `RoutingRule[]`
- **T3:** Telemetry / log-ingestion downstream of `ModelChoice.reason`
- **T4:** Supply chain (the three new devDeps)

### Scenarios

**A1 — Model downgrade via crafted descriptor.** LLM emits `sensitivity: 'low'` for actually-sensitive work to force Haiku.
**Status:** Out of router's threat model by design. Router trusts caller-supplied sensitivity. Determining true sensitivity is the consumer's job, not the router's. **Accepted.**

**A2 — Model downgrade via malicious custom table.**
**Status:** Documented in ADR-0007 as a footgun. **Accepted, with README warning recommended.**

**A3 — Log injection via custom `reason`.** Attacker-controlled `RoutingRule.reason` contains `\n` to forge log lines.
**Status:** `sanitizeReason` strips `\x00-\x1F`, `\x7F-\x9F` (C0 + C1 + DEL). Test asserts `\n` and `\r` are gone. **Defeated for ASCII control chars.**

**A4 — DoS via throwing rule predicate.** Custom `match` throws to crash router.
**Status:** `safeMatch` try/catch returns `false`, continues to next rule. Test confirms. **Defeated.**

**A5 — DoS via slow rule predicate.** Custom rule's `match` runs unbounded computation.
**Status:** No timeout. Risk LOW — the consumer wrote the rule; self-DoS is not a meaningful adversarial concern for a routing library.

**A6 — Prototype pollution via descriptor.** Attacker passes `{ __proto__: ..., shape, sensitivity, expected_tokens }`.
**Status:** `assertValid` reads three named fields via normal property access; no `Object.keys` / `for…in` iteration. `Array.includes` checks values, not keys. **No surface.**

**A7 — Proxy / getter type confusion.** Attacker passes a Proxy descriptor that returns different values on repeated `.shape` reads.
**Status:** TOCTOU is possible (validation reads each field once; user rules may re-read). Consequence: model selection only. The router has no security boundary that depends on field stability between validation and matching. **Out of scope.**

**A8 — Unicode line-separator injection via `reason`.** Custom rule's `reason` includes U+2028 (LINE SEPARATOR) or U+2029 (PARAGRAPH SEPARATOR).
**Status:** `sanitizeReason` does *not* strip these. Most log systems treat only `\n` as newline, so impact is low — but JSON.parse historically had issues with these chars in strings (pre-ES2019), and some downstream log ingestors split on Unicode line boundaries. **FINDING — MINOR.**

**A9 — BiDi visual injection via `reason`.** Custom rule's `reason` includes RTL override marks (U+202E etc.) to visually reorder log content.
**Status:** Not stripped. Pure visual confusion, no semantic impact. **Noted; not a finding.**

**A10 — Supply chain.** Three new devDeps: `typescript ^5.4.0`, `vitest ^1.6.0`, `@types/node ^20.12.0`.
**Status:** All canonical packages from `registry.npmjs.org`. `package-lock.json` pins resolved versions. devDeps do not ship to consumers (only the compiled `dist/` does). **Acceptable.**

## Findings

### MINOR — Sanitization regex misses Unicode line separators

**Where:** `src/router/route.ts:78` — `const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/g;`

**What:** The regex strips C0 + C1 + DEL but not U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR). A custom rule's `reason` containing these can survive sanitization and break some downstream log ingestors that split on Unicode line boundaries.

**Severity:** MINOR. Most log systems treat only `\n` / `\r` as newlines. Risk realises only if a downstream pipeline uses Unicode-aware line splitting.

**Recommendation:** Widen the regex:
```ts
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F  ]/g;
```
Add one test case covering U+2028. Non-blocking; do in a follow-up commit.

### MINOR — Missing tests for `===  true` strictness, `expected_tokens === 0`, and `hint` pass-through

**Where:** `src/router/route.test.ts`

See Phase 2 § Coverage gaps. Three small test additions to lock the documented contract. Non-blocking.

### MINOR — Coverage tooling missing

**Where:** `package.json`

`npm run test:coverage` fails on missing `@vitest/coverage-v8`. The Week 1 checkpoint requires ≥70% coverage, which cannot be measured numerically until this is added.

**Recommendation:** Add `@vitest/coverage-v8` to devDeps before declaring Week 1 done.

### NOTE — README sensitivity-floor warning

**Where:** README (currently absent)

The ADR documents the custom-table sensitivity-downgrade footgun, but a hiring reviewer (or downstream consumer) is more likely to read the README than ADR-0007. A one-line warning in the eventual README router section would close the documentation gap without changing the architecture. Track for Week 4 polish.

## Resolved (from prior 3-agent review)

For audit-trail completeness, the following were surfaced in the in-session three-agent review (code-reviewer + security-reviewer + architect) and resolved in this same commit:

- ✅ Runtime validation of `shape` and `sensitivity` (was MAJOR)
- ✅ Default router memoized at module level (was MAJOR)
- ✅ `safeMatch` wraps consumer predicates (was MAJOR)
- ✅ `rule_id` added to `ModelChoice` (was structural gap)
- ✅ `sanitizeReason` for log injection on ASCII control chars (was HIGH)
- ✅ Fallthrough path also sanitized for consistency
- ✅ All shape × high-sensitivity combinations tested
- ✅ Token-boundary tests (19_999 / 20_000 / 49_999 / 50_000)
- ✅ `NaN`, `Infinity`, unknown enum values tested
- ✅ Architecture doc synced (`med` → `medium`, `ModelChoice` snippet updated)
- ✅ ADR-0007 explicit threshold rationale + custom-table footgun

## Verdict

**APPROVE for merge.** All HIGH-severity items from the prior review pass are resolved in this commit. Remaining findings are MINOR and do not block merge:

- Unicode line-separator sanitization gap → one-line regex widen
- Three small test additions
- Coverage tooling missing
- README sensitivity-floor warning

Recommend tracking the MINOR findings as a follow-up issue or addressing them in the same patch series as the next harness module (skills loader, H-3) lands.

The PR ships a clean, well-tested, well-documented pure-function module with a deliberately small public surface. Test:source ratio is healthy at 2.4×. ADR-0007 + the devlog entry give a hiring reviewer enough context to understand both *what* and *why* — which is the whole point of this repo.

---

*Generated by the `differential-review` skill. Methodology: SMALL/DEEP strategy with greenfield-adjusted Phase 1.*
