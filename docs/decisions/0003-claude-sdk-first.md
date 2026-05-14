# ADR-0003: Claude Agent SDK as the v1 target

- **Date:** 2026-05-13
- **Status:** Accepted
- **Deciders:** Jackson Anstee
- **Related requirements:** H-1

## Context

The harness must wrap *some* underlying agent SDK in v1.0. The realistic candidates are:

1. **Claude Agent SDK** (Anthropic) — tool use, prompt caching, extended thinking, MCP, files API.
2. **OpenAI Agents SDK** — tool use, function calling, Assistants API.
3. **Gemini SDK** — tool use, long-context, grounding.
4. **Provider-agnostic abstraction** — implement against multiple SDKs from day one.

Trade-offs:

- A provider-agnostic abstraction sounds appealing but is the classic premature abstraction. Without two real implementations driving the interface, the abstraction will encode one SDK's quirks as universal truths.
- Picking a single SDK lets the harness leverage that SDK's strongest features (prompt caching, MCP, hook semantics) without compromise.
- The author's deepest existing expertise is in the Claude ecosystem — settings, hooks, MCP, skills system, multi-model routing across the Claude family. Building on Claude leverages 18+ months of accumulated context.
- For a portfolio piece, depth of execution on one stack outranks shallow coverage of three.

## Decision

Target the **Claude Agent SDK** in v1.0. Do not introduce a provider-agnostic abstraction.

Specific implications:

- Public APIs may reference Claude-specific concepts (Haiku/Sonnet/Opus, prompt caching, MCP) directly. They will not be hidden behind a generic interface in v1.
- The model router's task descriptor schema is informed by the Claude family's pricing and capability tiers. Generalising to other providers is deferred.
- Test fixtures and the red-team corpus may include Claude-specific behaviours where relevant (e.g. extended thinking interactions).

## Consequences

### Positive
- Maximum leverage from the author's existing Claude expertise (skills system, hooks, multi-model routing, MCP integration).
- The harness can use Claude-specific features (prompt caching, extended thinking) as first-class concepts rather than lowest-common-denominator approximations.
- No abstraction tax — every line of code targets a real SDK.

### Negative
- A potential user on OpenAI or Gemini cannot adopt this harness in v1.0.
- The market of Claude-first developers is smaller than the union of all SDK users.
- If Anthropic deprecates or significantly changes the SDK surface, the harness pays the full migration cost.

### Mitigations
- The architecture documents (`docs/architecture.md`) will mark which modules are SDK-specific vs SDK-agnostic. Future provider support will mostly affect the router, skill loader, and hook adapters — not security or eval.
- An ADR-0006 (deferred) will capture lessons before adding a second SDK.

## Alternatives considered

1. **OpenAI Agents SDK first.** Larger audience, but the author has shallower expertise and would spend the first weeks ramping up. Wrong trade-off for a 4-week shipping window.
2. **Provider-agnostic from day one.** Rejected as premature abstraction. Reasonable to revisit in v2 once Claude support is stable and a second concrete SDK target emerges.
3. **Support Claude + OpenAI in v1.0.** Doubles scope without doubling value. The portfolio signal is "deep, considered execution," not "broad surface coverage."

## Revisit if

- A user community on a second SDK forms organically and asks for support.
- The author's job-search target shifts to roles centred on a different SDK.
- Anthropic's SDK direction diverges enough that the harness becomes structurally awkward — that would force a re-evaluation of the foundation rather than a second-SDK addition.
