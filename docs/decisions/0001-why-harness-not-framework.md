# ADR-0001: Harness, not framework

- **Date:** 2026-05-13
- **Status:** Accepted
- **Deciders:** Jackson Anstee
- **Related requirements:** H-1

## Context

The LLM agent ecosystem in 2026 is crowded with frameworks: LangGraph, CrewAI, Mastra, AutoGen, OpenAI Agents SDK, and the Claude Agent SDK itself. Each defines an opinionated agent execution model — state graphs, role-based crews, message-passing actors, or single-loop ReAct.

Adopting any of them means:

- Inheriting their execution model, lock-in, and upgrade tax.
- Rewriting agent logic to fit their primitives.
- Trusting their security and evaluation defaults (which, in most cases, are minimal or absent).

A new framework would compete on the same axis as five mature incumbents while adding nothing differentiated. The author has no execution-model innovation to contribute and no desire to maintain one.

However, the *layers above and around* the execution model — routing, hooks, telemetry, security, evaluation — are reinvented in every project, and existing frameworks ship them inconsistently or not at all.

## Decision

This project is a **harness**, not a framework.

Operationally this means:

1. It depends on a third-party SDK (Claude Agent SDK in v1) and does not shadow, fork, or wrap its public types.
2. It contributes orthogonal capabilities — routing, skill loading, hooks, telemetry, security scanning, evaluation — that compose around the SDK.
3. A user can adopt one module (e.g. just the injection scanner) without adopting the rest.
4. Removing this harness from a project should be a one-day refactor, not a two-week migration.

## Consequences

### Positive
- Smaller scope; faster to v1.0.
- Composable with any team's existing SDK choice.
- Honest positioning: the README does not claim to compete with LangGraph.
- Easier to maintain as a solo project — the surface area is bounded.

### Negative
- Less control over the agent's execution model means some optimisations are unavailable (e.g. custom cache-key strategies tied to graph state).
- Tied to upstream SDK stability; SDK-breaking changes propagate.
- Harder to market — "framework" is the more familiar category. Some readers will skim past "harness" without understanding the distinction.

### Mitigations
- Lead the README with a side-by-side: "Use a framework when you need X. Use this harness when you need Y."
- Pin the SDK version in `package.json` and document upgrade procedure in `docs/upgrading.md`.

## Alternatives considered

1. **Fork the Claude Agent SDK and extend it.** Rejected — incurs the maintenance burden of an SDK fork, and the SDK is moving fast.
2. **Build a thin framework on top of multiple SDKs.** Rejected for v1.0 — premature abstraction. May revisit if the harness modules stabilise across two SDKs in v2.
3. **Skip the framework debate; ship a library of utilities.** Rejected — "library" understates the architectural coherence. The three layers (harness / security / eval) are designed together, not as a grab-bag.

## Revisit if

- A second SDK is supported in v1.x and the abstraction emerges naturally from the code, not from speculation.
- A user reports that adopting the harness required rewriting their agent logic — that would indicate the harness has accidentally become opinionated about execution.
