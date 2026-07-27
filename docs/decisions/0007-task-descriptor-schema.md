# ADR-0007: TaskDescriptor schema

- **Status:** Accepted
- **Date:** 2026-05-20
- **Related:** [H-2](../../process/01-requirements.md), [architecture.md §router](../architecture.md), open question #2
- **Model names superseded by:** [ADR-0024](./0024-router-model-tiers.md) (2026-07-27). Everything else in this ADR still stands; see the amendment at the end.

## Context

The router (`harness/router`) selects between Haiku 4.5, Sonnet 4.6, and Opus 4.7 from a declarative task descriptor (the model line-up as of this ADR's date; see the amendment below). The architecture doc named three fields — `shape`, `sensitivity`, `expected_tokens` — but deferred the exact schema to an ADR before Week 1 implementation. This ADR locks it.

The routing table is part of the harness's public API: downstream consumers will write task descriptors directly and ship custom routing tables. Field names, value sets, and defaults are therefore stable surface, not internals.

## Decision

`TaskDescriptor` is a closed-shape TypeScript type with three required fields and one optional:

```ts
type TaskShape = 'review' | 'build' | 'research' | 'lookup';
type TaskSensitivity = 'low' | 'medium' | 'high';

interface TaskDescriptor {
  shape: TaskShape;
  sensitivity: TaskSensitivity;
  expected_tokens: number;          // total prompt + completion budget, caller's best estimate
  hint?: string;                    // free-form, ignored by default routing, available to custom tables
}
```

`ModelChoice` is:

```ts
// Superseded — the shipped union is in ADR-0024. See the amendment below.
type Model = 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7';

interface ModelChoice {
  model: Model;
  rule_id: string;                  // stable rule identifier; 'fallthrough' for the implicit last rule
  reason: string;                   // human-readable rule trace, e.g. "shape=research+sensitivity=high → opus"
}
```

`rule_id` is the machine-parseable counterpart to `reason`. Telemetry, cost-budget routing (H-6), and downstream consumers should key off `rule_id`; `reason` is for humans reading logs.

### Default routing table

Routing is deterministic. The first matching rule wins. The shipped default **as of 2026-05-20** (the model column is superseded by ADR-0024; the match conditions, rule order, and rationale still stand):

| # | Match | → Model | Rationale |
|---|---|---|---|
| 1 | `sensitivity === 'high'` | `claude-opus-4-7` | Sensitive work gets the strongest reasoning model regardless of shape |
| 2 | `shape === 'lookup'` | `claude-haiku-4-5` | Fast, cheap, right-sized for retrieval and trivial answers |
| 3 | `shape === 'research'` | `claude-opus-4-7` | Multi-step reasoning across novel material |
| 4 | `shape === 'review'` && `expected_tokens < 20_000` | `claude-sonnet-4-6` | Routine code review fits Sonnet |
| 5 | `shape === 'build'` && `expected_tokens < 50_000` | `claude-sonnet-4-6` | Most build work fits Sonnet |
| 6 | _fallthrough_ | `claude-opus-4-7` | Large context or unclassified work escalates |

The default table mirrors the user-level effort routing rule that already governs this author's own Claude Code workflow — junior-with-spec → Sonnet, staff-engineer → Opus, intern-5-minute → Haiku.

**On the 20k / 50k thresholds.** These are unseated defaults, not derived from measurement. They encode the rough intuition that routine review fits well under 20k of context and routine build under 50k; beyond that you usually need Opus's reasoning even for nominally simple work. Consumers with real cost and quality data should override the table — that's the whole point of the injectable-rules design. The fallthrough rule (escalate on uncertainty) is the safety net for descriptors that don't match cleanly.

**Footgun: custom tables can downgrade `sensitivity:'high'`.** Because routing is first-match-wins and the table is fully replaceable, a consumer who writes a catch-all rule at the top of their custom table will silently route high-sensitivity work to a weaker model. This is by design — the harness does not impose a safety floor at the router layer; that responsibility belongs to the security layer's permission model and the consumer's own policy. An `enforceSensitivityFloor` option may be added in v1.x if real consumers ask for it.

## Consequences

**Positive**
- Stable, testable surface. Routing decisions are pure functions of `(descriptor, table)`, so unit tests cover every rule.
- Custom tables remain a one-file override — consumers pass their own array of rules to the router constructor.
- `reason` field gives traceability without a separate telemetry call.

**Negative / accepted**
- Closed shape on `shape` and `sensitivity` means adding a new category is a breaking change. Acceptable for v1.0; relaxable via discriminated-union extension if needed.
- `expected_tokens` is caller-estimated and therefore wrong sometimes. The fallthrough rule (escalate on uncertainty) is the safety net.
- `hint` is intentionally weakly typed. The default table ignores it; consumers who need richer routing can read it from a custom table.

## Alternatives considered

1. **Free-form `Record<string, unknown>` descriptor.** Rejected — defeats the point of a typed harness and pushes validation into every consumer.
2. **Cost-budget as a first-class field.** Deferred to H-6 (v1.x). Adding it now would force routing to depend on telemetry to know running cost, which would invert the dependency direction.
3. **Letting the router call a model to pick a model.** Rejected — non-deterministic, expensive, and untestable. The router stays a pure function.

## Amendment (2026-07-27): the model union moved on twice; this ADR's model names did not

The `Model` union and the model column of the default table above record the line-up as it stood on 2026-05-20. Both have been refreshed since, and this ADR was not updated either time. The original text is left intact as the record of what was decided then; the current state lives in ADR-0024.

- **2026-07-06, PR #10 (closes issue #8):** `claude-opus-4-7` became `claude-opus-4-8` in the union, the table, and the fallthrough. A mechanical, same-tier version bump with no routing-rule change. New tiers were deliberately left out of scope as an ADR-level decision.
- **2026-07-27, [ADR-0024](./0024-router-model-tiers.md):** that deferred decision was taken. The union is now `claude-haiku-4-5 | claude-sonnet-5 | claude-opus-5 | claude-fable-5`, and the default table targets the same three tiers this ADR chose, refreshed to the current generation. `claude-fable-5` is nameable from a custom table but is never selected by a default rule, on cost, data-retention, and unhandled-refusal grounds set out there.

One rationale in the table above is worth reading with the amendment in hand. Row 1 says sensitive work "gets the strongest reasoning model", which was literally true when every nameable model was a default target. Under ADR-0024 it means the strongest *defaulted* model: `claude-fable-5` is nameable but deliberately not selected by any default rule, so the strongest nameable model and the high-sensitivity target are no longer the same thing. The routing behaviour is unchanged; only the superlative needs reading precisely.

What this ADR still owns is unchanged: the `TaskDescriptor` shape, the `ModelChoice` shape, `rule_id` as the machine-parseable counterpart to `reason`, first-match-wins ordering, the 20k/50k thresholds and their unseated-defaults caveat, and the custom-table footgun. ADR-0024 supersedes only the model names.

**Process note.** The six-week gap between PR #10 changing the code and this amendment recording it is the failure this amendment exists to close. ADR-0024 classifies future refreshes as mechanical (Class A, no ADR, but update the pinned literals) or semantic (Class B, ADR required), so the next model release resolves to a known process instead of an open question.
