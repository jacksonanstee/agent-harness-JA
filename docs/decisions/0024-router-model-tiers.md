# ADR-0024: Router model tiers, and what happens when new models ship

- **Status:** Accepted
- **Date:** 2026-07-27
- **Requirements:** The tier decision [PR #10](https://github.com/jacksonanstee/agent-harness-JA/pull/10) explicitly deferred ("new-tier additions (Sonnet 5 / Fable) deliberately out of scope, that's a semantics change deserving its own ADR-level decision"), plus the drift that accumulated while it stayed deferred
- **Relates to:** [ADR-0007](./0007-task-descriptor-schema.md) (owns the `Model` union and the default table; amended by this ADR), [ADR-0023](./0023-public-api-surface.md) (put `Model` in the locked public surface, which is what makes this timing-sensitive), [ADR-0010](./0010-sdk-session-adapter.md) (the seam where a model ID stops being a label and becomes an API argument)

## Context

The router's `Model` union had drifted a full generation: `claude-haiku-4-5 | claude-sonnet-4-6 | claude-opus-4-8`, pinned while Opus 5, Sonnet 5, and Fable 5 all shipped. Every one of those IDs is still served, so nothing was broken. The problem was that the decision about *what to do next* had never been made, so each new model release re-opened the same unanswered question.

Three facts shape the decision.

**The strings are load-bearing.** `src/session/session.ts` passes `modelChoice.model` straight to the SDK as `options.model`. A `Model` member is not a tier label, it is an API argument. A member that is wrong, retired, or unavailable to the caller's organisation is a runtime failure, not a documentation nit.

**The window is closing.** ADR-0023 pulled `Model` into the locked public surface via the root barrel and the `exports` map. Nothing is on npm yet, so changing the union is free exactly once more. Adding a union member is additive for consumers who *produce* a `Model` (writing a custom rule) but breaking for consumers who *consume* one exhaustively, and renaming a member is breaking for both.

**The recurring question needs an answer, not a re-litigation.** PR #10 drew the right line (mechanical refresh versus semantics change) in a PR body, where it is invisible six months later. This ADR promotes that line to a policy.

## Decisions

**1. The union names four models; the default table selects three of them.**

```ts
type Model =
  | 'claude-haiku-4-5'
  | 'claude-sonnet-5'
  | 'claude-opus-5'
  | 'claude-fable-5';
```

The default table keeps the shape ADR-0007 set, refreshed to the current generation: `sensitivity: 'high'`, `shape: 'research'`, and the implicit fallthrough go to `claude-opus-5`; small review and small build go to `claude-sonnet-5`; `shape: 'lookup'` stays on `claude-haiku-4-5`. The rule IDs, thresholds, and `reason` strings are unchanged, because the `reason` strings were written at tier level (`'sensitivity=high → opus'`) rather than pinned to a version.

**`claude-fable-5` is nameable but never defaulted.** It is in the union so a consumer can target it from a custom table without waiting on a release of this package. No shipped rule selects it, for three reasons that are properties of the model rather than preferences:

- **Cost.** Fable is $10/$50 per MTok against Opus 5 at $5/$25. Three of the six default rules (high sensitivity, research, fallthrough) resolve to the top tier, so defaulting them to Fable roughly doubles baseline spend for a harness whose stated purpose includes routing work to the cheapest model that can do it.
- **Availability.** Fable requires 30-day data retention and is not available under zero data retention. An organisation configured for ZDR receives `400 invalid_request_error` on *every* Fable request. A default that hard-fails an entire class of consumer is not a default.
- **Unhandled response shape.** Fable can return `stop_reason: "refusal"` from its safety classifiers. `src/session/session.ts` does not currently branch on that, so a refusal would surface as an empty or partial result rather than a handled outcome. Shipping Fable as a default before that seam exists would be shipping a known gap into the happy path.

Naming it without defaulting to it separates "the harness knows this model exists" from "the harness will spend your money on it". The split is enforced by tests, not just by this prose: `route.test.ts` asserts that no `DEFAULT_ROUTING_TABLE` rule and not `FALLTHROUGH_MODEL` selects Fable, and that a custom rule can.

**2. The union stays closed.**

No `(string & {})` escape hatch. A closed union means every refresh is a compiler-enforced event: the `SessionResult`-typed fixtures in `src/cli/init-templates.test.ts` and `src/eval/golden/runner.test.ts` fail to compile when a member is renamed, which is exactly the blast-radius guard ADR-0021's review pass deliberately introduced. The cost is that each refresh is a semver-relevant change to a published type, which is a cost worth paying for a harness whose value proposition is that its failure modes are loud.

Note that the telemetry and eval layers deliberately type their model fields as plain `string` (`adversaryModelId`, `ScorecardMeta.models`, the telemetry event payload). They record what ran; they do not constrain what may run. That decoupling is intentional and is not changed here.

**3. Model refresh is classified, and the classification decides the process.**

| Class | What it is | Process |
|---|---|---|
| **A, mechanical** | Same tier, newer version (for example Opus 5 to a later Opus) | Swap the literal in `types.ts`, `table.ts`, and the pinned tests. No ADR. Still a semver-relevant change to a published type, so note it in the PR. |
| **B, semantic** | Adding or removing a tier, or retargeting a rule to a different tier | Requires an ADR. It changes what the harness means by a tier, not just which build serves it. |

Either class, three sourcing rules:

- Read the current IDs from the live model list or the vendor migration guide at the time of the change. Never from memory, and never from this file, which is a record of what was true on its date.
- Use the exact published alias. **Never append a date suffix** to an alias.
- A union member must be a currently-served model. Retired IDs come out under Class B.

## Consequences

- The default routing profile is current-generation with no change in cost posture: the tier each rule targets is identical to what ADR-0007 specified, so a consumer's spend shape is unchanged apart from the vendor's own pricing.
- Consumers can opt into Fable in one line of a custom table, and cannot get there by accident.
- The v0.1.0 publish freezes a union that is current rather than a generation behind, which was the point of doing this before the release tag.
- Anyone who does route to Fable inherits the refusal, retention, and cost properties listed above. That is a documented consequence of an explicit opt-in, not a silent one.
- ADR-0007 remains the owner of the descriptor schema and the routing-table structure. This ADR supersedes only its `Model` union and the model column of its default-table listing.

## Revisit if

- **`stop_reason: "refusal"` gets handled in the session layer.** That removes the third objection to defaulting high-sensitivity work to Fable, at which point the cost and retention trade-offs can be weighed on their own.
- **A tier is retired upstream.** Removal is Class B and forces a decision about what the vacated rules target.
- **A real consumer needs a model the closed union does not name.** The cheap fix is adding the member; reopening the closed-union decision should require the additive fix having actually failed them.
- **The tier count stops matching the routing thesis.** The three defaulted tiers exist because they map onto cheap-lookup, routine-work, and hard-reasoning. If the vendor's line-up stops supporting that split, the table needs rethinking rather than renumbering.
